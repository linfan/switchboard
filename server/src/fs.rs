//! Server-side directory listing for the client's working-directory folder
//! picker. Browses the hosting machine's real filesystem; access is already
//! gated by the bearer token (which grants full PTY/shell access anyway), so no
//! path is off-limits — the whole tree is navigable from `/`.

use std::path::{Path, PathBuf};

use switchboard_shared::{FsEntry, FsListing};

use crate::error::{AppError, AppResult};

/// List the immediate children of `path` (or the server user's home directory,
/// then `/`, when `None`). Directories are returned before files; within each
/// group entries are sorted case-insensitively by name. Unreadable entries are
/// skipped rather than failing the whole listing.
pub fn list_dir(path: Option<&str>) -> AppResult<FsListing> {
    let base = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => default_dir(),
    };

    let canonical = base
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("cannot open '{}': {e}", base.display())))?;
    if !canonical.is_dir() {
        return Err(AppError::BadRequest(format!(
            "not a directory: {}",
            canonical.display()
        )));
    }

    let read = std::fs::read_dir(&canonical)
        .map_err(|e| AppError::BadRequest(format!("cannot read '{}': {e}", canonical.display())))?;

    let mut entries: Vec<FsEntry> = read
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().ok()?.is_dir();
            Some(FsEntry {
                name,
                path: e.path().to_string_lossy().into_owned(),
                is_dir,
            })
        })
        .collect();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(FsListing {
        path: canonical.to_string_lossy().into_owned(),
        parent: canonical
            .parent()
            .map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// Where the picker opens when no path is given: the server user's home, else
/// the filesystem root.
fn default_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new("/").to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_dirs_first_then_files_sorted() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("zeta")).unwrap();
        fs::create_dir(dir.path().join("alpha")).unwrap();
        fs::write(dir.path().join("readme.txt"), b"x").unwrap();

        let listing = list_dir(Some(dir.path().to_str().unwrap())).unwrap();

        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "zeta", "readme.txt"]);

        let alpha = &listing.entries[0];
        assert!(alpha.is_dir);
        assert!(alpha.path.ends_with("alpha"));

        let readme = listing.entries.iter().find(|e| e.name == "readme.txt").unwrap();
        assert!(!readme.is_dir);

        // A non-root temp dir always has a parent.
        assert!(listing.parent.is_some());
    }

    #[test]
    fn missing_path_errors() {
        let err = list_dir(Some("/no/such/path/zzz-does-not-exist")).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn file_path_is_rejected() {
        let f = tempfile::NamedTempFile::new().unwrap();
        let err = list_dir(Some(f.path().to_str().unwrap())).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }
}
