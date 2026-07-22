//! Backend for the client's workspace file editor: read/write files and query
//! git (branch, history, changed files, diffs) on the hosting machine.
//!
//! Access is already gated by the bearer token (which grants full PTY/shell
//! access anyway), so — like [`crate::fs`] — no path is off-limits beyond
//! canonicalization. Git operations live in [`git`] and shell out to the host's
//! `git` binary; if it is missing or the folder is not a repo, [`git::git_info`]
//! reports that so the client can hide the git panels.

mod git;

pub use git::{git_changes, git_diff, git_file_diff, git_info, git_log};

use std::path::PathBuf;

use switchboard_shared::FileContent;

use crate::error::{AppError, AppResult};

/// Largest file the editor will read into memory (2 MiB). Beyond this we return
/// an empty, `truncated` payload so the client shows a notice instead of hanging.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Read a file's contents (UTF-8, lossy). Rejects directories; flags oversize or
/// binary files as `truncated` with empty content rather than failing.
pub async fn read_file(path: &str) -> AppResult<FileContent> {
    if path.trim().is_empty() {
        return Err(AppError::BadRequest("missing file path".into()));
    }
    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("cannot open '{path}': {e}")))?;

    let meta = tokio::fs::metadata(&canonical)
        .await
        .map_err(|e| AppError::BadRequest(format!("cannot stat '{path}': {e}")))?;
    if meta.is_dir() {
        return Err(AppError::BadRequest(format!(
            "not a file: {}",
            canonical.display()
        )));
    }
    let out = canonical.to_string_lossy().into_owned();
    if meta.len() > MAX_FILE_BYTES {
        return Ok(FileContent {
            path: out,
            content: String::new(),
            truncated: true,
        });
    }

    let bytes = tokio::fs::read(&canonical)
        .await
        .map_err(|e| AppError::BadRequest(format!("cannot read '{path}': {e}")))?;
    // Treat an embedded NUL as "binary": don't stream control bytes to the editor.
    if bytes.contains(&0) {
        return Ok(FileContent {
            path: out,
            content: String::new(),
            truncated: true,
        });
    }
    Ok(FileContent {
        path: out,
        content: String::from_utf8_lossy(&bytes).into_owned(),
        truncated: false,
    })
}

/// Overwrite a file with new contents (the editor's Save). The file must already
/// exist (the editor only saves files it opened).
pub async fn write_file(path: &str, content: &str) -> AppResult<()> {
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
    tokio::fs::write(&canonical, content)
        .await
        .map_err(|e| AppError::BadRequest(format!("cannot write '{path}': {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_write_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("hello.txt");
        std::fs::write(&f, "one").unwrap();
        let p = f.to_str().unwrap();

        let got = read_file(p).await.unwrap();
        assert_eq!(got.content, "one");
        assert!(!got.truncated);

        write_file(p, "two\nthree").await.unwrap();
        let got = read_file(p).await.unwrap();
        assert_eq!(got.content, "two\nthree");
    }

    #[tokio::test]
    async fn read_rejects_dir_and_flags_binary() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_file(dir.path().to_str().unwrap()).await.is_err());

        let bin = dir.path().join("bin");
        std::fs::write(&bin, [0u8, 1, 2, 3]).unwrap();
        let got = read_file(bin.to_str().unwrap()).await.unwrap();
        assert!(got.truncated);
        assert_eq!(got.content, "");
    }
}
