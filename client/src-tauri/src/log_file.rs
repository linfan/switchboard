//! Size-based rolling file logging for the desktop client.
//!
//! Logs are written to a single active file; when a write would push it past
//! `max_size` the file is rolled (`.1`…`.N`, newest first) and the oldest
//! archive beyond `max_files` is discarded. Mirrors the hosting service's
//! rolling writer.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tracing_subscriber::fmt::MakeWriter;

/// Rolling log file configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogFileConfig {
    /// Active log file path (archives get a `.N` suffix alongside it).
    pub path: PathBuf,
    /// Roll the file once a write would push it past this many bytes.
    pub max_size: u64,
    /// Number of archived generations to retain; the oldest is discarded on roll.
    pub max_files: usize,
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
        let path = cfg.path.clone();
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
