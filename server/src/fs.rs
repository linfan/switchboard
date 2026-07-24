//! Server-side directory listing for the client's working-directory folder
//! picker. Browses the hosting machine's real filesystem; access is already
//! gated by the bearer token (which grants full PTY/shell access anyway), so no
//! path is off-limits — the whole tree is navigable from `/`.

use std::path::{Path, PathBuf};

use switchboard_shared::{FsEntry, FsListing, FsStat};

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
        parent: canonical.parent().map(|p| p.to_string_lossy().into_owned()),
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

/// Modification time of `meta` as unix millis, `0` when the platform can't
/// report one. Shared by [`stat`] and the editor's file read/write so the
/// client compares a consistent representation.
pub fn mtime_millis(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Report whether `path` exists on the hosting machine and, if so, whether it's
/// a directory. A missing path is not an error — the caller (workspace creation)
/// uses `exists == false` to offer creating the folder. Symlinks are followed.
pub fn stat(path: &str) -> AppResult<FsStat> {
    if path.trim().is_empty() {
        return Err(AppError::BadRequest("missing path".into()));
    }
    match std::fs::metadata(path) {
        Ok(m) => Ok(FsStat {
            exists: true,
            is_dir: m.is_dir(),
            mtime: mtime_millis(&m),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FsStat {
            exists: false,
            is_dir: false,
            mtime: 0,
        }),
        Err(e) => Err(AppError::BadRequest(format!("cannot stat '{path}': {e}"))),
    }
}

/// Create directory `path` (and any missing parents) on the hosting machine.
/// Idempotent: succeeds if the directory already exists.
pub fn mkdir(path: &str) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::BadRequest("missing path".into()));
    }
    std::fs::create_dir_all(path)
        .map_err(|e| AppError::BadRequest(format!("cannot create '{path}': {e}")))?;
    Ok(())
}

/// Reject a proposed file/directory name that isn't a single, safe path segment.
/// Names must be non-empty and free of path separators, NULs, and `.`/`..` so a
/// rename/upload can't escape its parent directory.
fn validate_name(name: &str) -> AppResult<()> {
    let ok = !name.trim().is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0');
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!("invalid name: {name}")))
    }
}

/// Rename a file or directory to a sibling `new_name` in the same parent.
pub fn rename(path: &str, new_name: &str) -> AppResult<()> {
    validate_name(new_name)?;
    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("cannot open '{path}': {e}")))?;
    let parent = canonical
        .parent()
        .ok_or_else(|| AppError::BadRequest("cannot rename the filesystem root".into()))?;
    let target = parent.join(new_name);
    if target.exists() {
        return Err(AppError::BadRequest(format!("already exists: {new_name}")));
    }
    std::fs::rename(&canonical, &target)
        .map_err(|e| AppError::BadRequest(format!("cannot rename '{path}': {e}")))?;
    Ok(())
}

/// Create an empty file or a directory named `name` inside existing directory
/// `dir` (file-tree context menu). Rejects an existing target so a create never
/// silently clobbers an entry.
pub fn create(dir: &str, name: &str, is_dir: bool) -> AppResult<()> {
    validate_name(name)?;
    let canonical = PathBuf::from(dir)
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("cannot open '{dir}': {e}")))?;
    if !canonical.is_dir() {
        return Err(AppError::BadRequest(format!("not a directory: {dir}")));
    }
    let target = canonical.join(name);
    if target.exists() {
        return Err(AppError::BadRequest(format!("already exists: {name}")));
    }
    let result = if is_dir {
        std::fs::create_dir(&target)
    } else {
        std::fs::write(&target, b"")
    };
    result.map_err(|e| AppError::BadRequest(format!("cannot create '{name}': {e}")))?;
    Ok(())
}

/// Delete a file, or a directory and all its contents.
pub fn delete(path: &str) -> AppResult<()> {
    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("cannot open '{path}': {e}")))?;
    let result = if canonical.is_dir() {
        std::fs::remove_dir_all(&canonical)
    } else {
        std::fs::remove_file(&canonical)
    };
    result.map_err(|e| AppError::BadRequest(format!("cannot delete '{path}': {e}")))?;
    Ok(())
}

/// Write `bytes` to a new file `name` inside existing directory `dir`. Rejects an
/// existing target so an upload never silently clobbers a file.
pub fn upload(dir: &str, name: &str, bytes: &[u8]) -> AppResult<()> {
    validate_name(name)?;
    let canonical = PathBuf::from(dir)
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("cannot open '{dir}': {e}")))?;
    if !canonical.is_dir() {
        return Err(AppError::BadRequest(format!("not a directory: {dir}")));
    }
    let target = canonical.join(name);
    if target.exists() {
        return Err(AppError::BadRequest(format!("already exists: {name}")));
    }
    std::fs::write(&target, bytes)
        .map_err(|e| AppError::BadRequest(format!("cannot write '{name}': {e}")))?;
    Ok(())
}

/// Read a file's raw bytes for download, returning its base name alongside them.
/// Rejects directories.
pub fn read_bytes(path: &str) -> AppResult<(String, Vec<u8>)> {
    if path.trim().is_empty() {
        return Err(AppError::BadRequest("missing file path".into()));
    }
    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("cannot open '{path}': {e}")))?;
    if canonical.is_dir() {
        return Err(AppError::BadRequest(format!(
            "not a file: {}",
            canonical.display()
        )));
    }
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let bytes = std::fs::read(&canonical)
        .map_err(|e| AppError::BadRequest(format!("cannot read '{path}': {e}")))?;
    Ok((name, bytes))
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

        let readme = listing
            .entries
            .iter()
            .find(|e| e.name == "readme.txt")
            .unwrap();
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

    #[test]
    fn rename_moves_within_parent() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("old.txt");
        fs::write(&f, b"x").unwrap();

        rename(f.to_str().unwrap(), "new.txt").unwrap();
        assert!(!f.exists());
        assert!(dir.path().join("new.txt").exists());
    }

    #[test]
    fn rename_rejects_bad_names_and_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        fs::write(&f, b"x").unwrap();
        fs::write(dir.path().join("b.txt"), b"y").unwrap();
        let p = f.to_str().unwrap();

        // Path separators / traversal are rejected before touching disk.
        assert!(rename(p, "../escape").is_err());
        assert!(rename(p, "sub/child").is_err());
        assert!(rename(p, "").is_err());
        // Colliding with an existing sibling is rejected.
        assert!(rename(p, "b.txt").is_err());
        // The original file is untouched by the failed renames.
        assert!(f.exists());
    }

    #[test]
    fn delete_removes_files_and_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        fs::write(&f, b"x").unwrap();
        delete(f.to_str().unwrap()).unwrap();
        assert!(!f.exists());

        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("nested.txt"), b"y").unwrap();
        delete(sub.to_str().unwrap()).unwrap();
        assert!(!sub.exists());
    }

    #[test]
    fn upload_writes_and_rejects_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_str().unwrap();

        upload(d, "up.txt", b"hello").unwrap();
        assert_eq!(fs::read(dir.path().join("up.txt")).unwrap(), b"hello");

        // A second upload with the same name is rejected (no clobber).
        assert!(upload(d, "up.txt", b"world").is_err());
        // Bad names are rejected.
        assert!(upload(d, "../evil", b"z").is_err());
    }

    #[test]
    fn create_makes_empty_file_and_folder_and_rejects_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_str().unwrap();

        create(d, "new.txt", false).unwrap();
        assert_eq!(fs::read(dir.path().join("new.txt")).unwrap(), b"");

        create(d, "newdir", true).unwrap();
        assert!(dir.path().join("newdir").is_dir());

        // Existing targets are rejected (no clobber), for both kinds.
        assert!(create(d, "new.txt", false).is_err());
        assert!(create(d, "newdir", true).is_err());
        // Bad names are rejected before touching disk.
        assert!(create(d, "../evil", false).is_err());
        assert!(create(d, "a/b", true).is_err());
        assert!(create(d, "", false).is_err());
    }

    #[test]
    fn stat_reports_dir_file_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let file = dir.path().join("f.txt");
        fs::write(&file, b"x").unwrap();

        let d = stat(sub.to_str().unwrap()).unwrap();
        assert!(d.exists && d.is_dir);

        let f = stat(file.to_str().unwrap()).unwrap();
        assert!(f.exists && !f.is_dir);

        let missing = stat(dir.path().join("nope").to_str().unwrap()).unwrap();
        assert!(!missing.exists && !missing.is_dir);

        assert!(stat("   ").is_err());
    }

    #[test]
    fn mkdir_creates_nested_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a/b/c");
        let p = nested.to_str().unwrap();

        mkdir(p).unwrap();
        assert!(nested.is_dir());
        // Re-creating an existing directory succeeds.
        mkdir(p).unwrap();
        assert!(nested.is_dir());

        assert!(mkdir("").is_err());
    }

    #[test]
    fn read_bytes_returns_name_and_contents() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("data.bin");
        fs::write(&f, [0u8, 1, 2, 3]).unwrap();

        let (name, bytes) = read_bytes(f.to_str().unwrap()).unwrap();
        assert_eq!(name, "data.bin");
        assert_eq!(bytes, vec![0u8, 1, 2, 3]);

        // Directories are rejected.
        assert!(read_bytes(dir.path().to_str().unwrap()).is_err());
    }
}
