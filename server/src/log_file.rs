//! Size-based rolling file logging, configured via `SWITCHBOARD_LOG`.
//!
//! The spec is `<file-path>|<max-size><unit>*<max-archive-count>`, e.g.
//! `logs/switchboard.log|100mb*5`: write to `logs/switchboard.log`, roll it when
//! it would exceed 100 MiB, and keep at most 5 archived generations
//! (`switchboard.log.1` … `switchboard.log.5`, newest first).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tracing_subscriber::fmt::MakeWriter;

/// Parsed `SWITCHBOARD_LOG` configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogFileConfig {
    /// Active log file path (archives get a `.N` suffix alongside it).
    pub path: String,
    /// Roll the file once a write would push it past this many bytes.
    pub max_size: u64,
    /// Number of archived generations to retain; the oldest is discarded on roll.
    pub max_files: usize,
}

impl LogFileConfig {
    /// Parse `<file-path>|<max-size><unit>*<max-archive-count>`, e.g.
    /// `logs/switchboard.log|100mb*5`. Units are case-insensitive: `b`, `kb`,
    /// `mb`, `gb` (or the bare `k`/`m`/`g`); a plain number is bytes.
    pub fn parse(spec: &str) -> Result<Self, String> {
        let (path, rest) = spec
            .split_once('|')
            .ok_or_else(|| format!("expected '<path>|<size>*<count>', got {spec:?}"))?;
        let (size, count) = rest
            .split_once('*')
            .ok_or_else(|| format!("expected '<size>*<count>' after '|', got {rest:?}"))?;
        let path = path.trim();
        if path.is_empty() {
            return Err("log file path is empty".to_string());
        }
        let max_size = parse_size(size.trim())?;
        let max_files: usize = count
            .trim()
            .parse()
            .map_err(|_| format!("invalid archive count {count:?}"))?;
        Ok(Self {
            path: path.to_string(),
            max_size,
            max_files,
        })
    }
}

/// Parse a byte size with an optional unit suffix into a byte count.
fn parse_size(s: &str) -> Result<u64, String> {
    let lower = s.to_ascii_lowercase();
    // Check longer/larger suffixes first so `mb` isn't mistaken for a bare `b`.
    let (num, mult): (&str, u64) = if let Some(n) =
        lower.strip_suffix("gb").or_else(|| lower.strip_suffix('g'))
    {
        (n, 1024 * 1024 * 1024)
    } else if let Some(n) = lower.strip_suffix("mb").or_else(|| lower.strip_suffix('m')) {
        (n, 1024 * 1024)
    } else if let Some(n) = lower.strip_suffix("kb").or_else(|| lower.strip_suffix('k')) {
        (n, 1024)
    } else if let Some(n) = lower.strip_suffix('b') {
        (n, 1)
    } else {
        (lower.as_str(), 1)
    };
    let value: u64 = num
        .trim()
        .parse()
        .map_err(|_| format!("invalid size {s:?}"))?;
    if value == 0 {
        return Err(format!("log max size must be > 0, got {s:?}"));
    }
    value
        .checked_mul(mult)
        .ok_or_else(|| format!("log max size overflows: {s:?}"))
}

/// The mutable rolling state, guarded by a mutex behind [`RollingWriter`].
struct Inner {
    path: PathBuf,
    max_size: u64,
    max_files: usize,
    file: File,
    written: u64,
}

impl Inner {
    /// Shift archives up by one (`.1`→`.2`, …), drop the oldest, move the live
    /// file to `.1`, then reopen a fresh live file.
    fn rotate(&mut self) -> io::Result<()> {
        if self.max_files == 0 {
            // Keep no archives: just truncate the current file in place.
            self.file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&self.path)?;
            self.written = 0;
            return Ok(());
        }
        let archive = |i: usize| -> PathBuf {
            let mut p = self.path.clone().into_os_string();
            p.push(format!(".{i}"));
            PathBuf::from(p)
        };
        let _ = fs::remove_file(archive(self.max_files));
        for i in (1..self.max_files).rev() {
            let from = archive(i);
            if from.exists() {
                let _ = fs::rename(&from, archive(i + 1));
            }
        }
        let _ = fs::rename(&self.path, archive(1));
        self.file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.path)?;
        self.written = 0;
        Ok(())
    }
}

impl Write for Inner {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // Roll before writing when this line would exceed the cap — but never on a
        // fresh file, so a single oversized line still lands somewhere.
        if self.written > 0 && self.written.saturating_add(buf.len() as u64) > self.max_size {
            self.rotate()?;
        }
        let n = self.file.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// A cloneable handle to a size-based rolling log file, usable as a
/// [`MakeWriter`] for `tracing_subscriber::fmt`.
#[derive(Clone)]
pub struct RollingWriter(Arc<Mutex<Inner>>);

impl RollingWriter {
    /// Open (or create) the log file, creating parent directories as needed, and
    /// seed the running byte count from the existing file size so appends roll at
    /// the right point across restarts.
    pub fn new(cfg: &LogFileConfig) -> io::Result<Self> {
        let path = PathBuf::from(&cfg.path);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self(Arc::new(Mutex::new(Inner {
            path,
            max_size: cfg.max_size,
            max_files: cfg.max_files,
            file,
            written,
        }))))
    }
}

/// Per-write guard handed out by [`RollingWriter::make_writer`]; each write locks
/// the shared state so concurrent tracing events can't interleave a roll.
pub struct LockedWriter(Arc<Mutex<Inner>>);

impl Write for LockedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("log writer mutex poisoned").write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.lock().expect("log writer mutex poisoned").flush()
    }
}

impl<'a> MakeWriter<'a> for RollingWriter {
    type Writer = LockedWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LockedWriter(self.0.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_spec() {
        let cfg = LogFileConfig::parse("logs/switchboard.log|100mb*5").unwrap();
        assert_eq!(cfg.path, "logs/switchboard.log");
        assert_eq!(cfg.max_size, 100 * 1024 * 1024);
        assert_eq!(cfg.max_files, 5);
    }

    #[test]
    fn parses_units_case_insensitively() {
        assert_eq!(parse_size("512").unwrap(), 512);
        assert_eq!(parse_size("512B").unwrap(), 512);
        assert_eq!(parse_size("4kb").unwrap(), 4 * 1024);
        assert_eq!(parse_size("4K").unwrap(), 4 * 1024);
        assert_eq!(parse_size("2MB").unwrap(), 2 * 1024 * 1024);
        assert_eq!(parse_size("1gb").unwrap(), 1024 * 1024 * 1024);
    }

    #[test]
    fn rejects_malformed_specs() {
        assert!(LogFileConfig::parse("no-delimiters").is_err());
        assert!(LogFileConfig::parse("logs/x.log|100mb").is_err());
        assert!(LogFileConfig::parse("|100mb*5").is_err());
        assert!(LogFileConfig::parse("logs/x.log|0mb*5").is_err());
        assert!(LogFileConfig::parse("logs/x.log|abc*5").is_err());
        assert!(LogFileConfig::parse("logs/x.log|100mb*x").is_err());
    }

    #[test]
    fn rolls_and_retains_archive_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        let cfg = LogFileConfig {
            path: path.to_str().unwrap().to_string(),
            max_size: 10,
            max_files: 2,
        };
        let writer = RollingWriter::new(&cfg).unwrap();

        // Each 8-byte write fits, but the second forces a roll of the first.
        for _ in 0..5 {
            writer.make_writer().write_all(b"12345678").unwrap();
        }
        writer.make_writer().flush().unwrap();

        assert!(path.exists());
        assert!(path.with_extension("log.1").exists());
        assert!(path.with_extension("log.2").exists());
        // Only `max_files` archives are kept — no `.3`.
        assert!(!path.with_extension("log.3").exists());
    }
}
