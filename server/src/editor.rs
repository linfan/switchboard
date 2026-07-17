//! Backend for the client's workspace file editor: read/write files and query
//! git (branch, history, changed files, diffs) on the hosting machine.
//!
//! Access is already gated by the bearer token (which grants full PTY/shell
//! access anyway), so — like [`crate::fs`] — no path is off-limits beyond
//! canonicalization. Git operations shell out to the host's `git` binary; if it
//! is missing or the folder is not a repo, [`git_info`] reports that so the
//! client can hide the git panels.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::Command;

use switchboard_shared::{FileContent, GitChange, GitCommit, GitDiff, GitInfo};

use crate::error::{AppError, AppResult};

/// Largest file the editor will read into memory (2 MiB). Beyond this we return
/// an empty, `truncated` payload so the client shows a notice instead of hanging.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Sentinel `commit` value meaning "the working tree" (uncommitted changes).
const WORKING: &str = "WORKING";

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

/// Run `git` with the given args inside `cwd`, returning stdout on success.
/// `Ok(None)` means git ran but exited non-zero (e.g. not a repo); `Err` means
/// git could not be launched at all (not installed).
async fn git(cwd: &str, args: &[&str]) -> Result<Option<String>, std::io::Error> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await?;
    if output.status.success() {
        Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
    } else {
        Ok(None)
    }
}

/// Resolve the work-tree root for `cwd`. All history/changes/diff commands run
/// from here so their paths are consistently relative to the repo root, even
/// when the workspace folder is a subdirectory of the repo.
async fn toplevel(cwd: &str) -> Option<String> {
    git(cwd, &["rev-parse", "--show-toplevel"])
        .await
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Whether a `git` binary is on PATH at all.
async fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Report git availability and whether `cwd` is a work tree, plus current branch.
pub async fn git_info(cwd: &str) -> AppResult<GitInfo> {
    require_dir(cwd)?;
    if !git_available().await {
        return Ok(GitInfo {
            available: false,
            is_repo: false,
            branch: None,
        });
    }
    let is_repo = matches!(
        git(cwd, &["rev-parse", "--is-inside-work-tree"]).await.ok().flatten(),
        Some(s) if s.trim() == "true"
    );
    let branch = if is_repo {
        git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .ok()
            .flatten()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    };
    Ok(GitInfo {
        available: true,
        is_repo,
        branch,
    })
}

/// Commits on the current branch, newest first (capped at 200).
pub async fn git_log(cwd: &str) -> AppResult<Vec<GitCommit>> {
    require_dir(cwd)?;
    let Some(root) = toplevel(cwd).await else {
        return Ok(Vec::new());
    };
    // Unit separator between fields, record separator between commits — safe
    // against subjects/bodies containing spaces/pipes/newlines. Body (%b) is
    // last so its embedded newlines can't be mistaken for a field break.
    let fmt = "--pretty=format:%H\x1f%h\x1f%s\x1f%an\x1f%ar\x1f%b\x1e";
    let out = match git(&root, &["log", "-n", "200", fmt]).await {
        Ok(Some(s)) => s,
        // Non-zero (e.g. empty repo with no commits) or not a repo → no history.
        _ => return Ok(Vec::new()),
    };
    let commits = out
        .split('\x1e')
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let mut f = record.split('\x1f');
            Some(GitCommit {
                hash: f.next()?.to_string(),
                short: f.next()?.to_string(),
                subject: f.next()?.to_string(),
                author: f.next()?.to_string(),
                date: f.next()?.to_string(),
                body: f.next().unwrap_or("").trim().to_string(),
            })
        })
        .collect();
    Ok(commits)
}

/// Files changed in a commit, or the working tree when `commit == "WORKING"`.
pub async fn git_changes(cwd: &str, commit: &str) -> AppResult<Vec<GitChange>> {
    require_dir(cwd)?;
    let Some(root) = toplevel(cwd).await else {
        return Ok(Vec::new());
    };
    if commit == WORKING {
        // Porcelain v1: "XY <path>" per line; XY is the two-column status.
        let out = git(&root, &["status", "--porcelain"]).await.ok().flatten();
        let Some(out) = out else { return Ok(Vec::new()) };
        let changes = out
            .lines()
            .filter(|l| l.len() > 3)
            .map(|l| {
                let status = l[..2].trim().to_string();
                let path = l[3..].trim().to_string();
                // Renames render as "old -> new"; keep the new path.
                let path = path
                    .split(" -> ")
                    .last()
                    .unwrap_or(&path)
                    .trim_matches('"')
                    .to_string();
                GitChange { status, path }
            })
            .collect();
        return Ok(changes);
    }
    validate_hash(commit)?;
    // name-status for a single commit vs its first parent.
    let out = git(
        &root,
        &["show", "--name-status", "--pretty=format:", commit],
    )
    .await
    .ok()
    .flatten();
    let Some(out) = out else { return Ok(Vec::new()) };
    let changes = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let mut parts = l.split('\t');
            let status = parts.next()?.trim().to_string();
            // Renames/copies: "R100\told\tnew" — take the last field as the path.
            let path = parts.next_back()?.trim().to_string();
            Some(GitChange { status, path })
        })
        .collect();
    Ok(changes)
}

/// Unified diff for one file, in a commit or the working tree.
pub async fn git_diff(cwd: &str, commit: &str, path: &str) -> AppResult<GitDiff> {
    require_dir(cwd)?;
    if path.trim().is_empty() {
        return Err(AppError::BadRequest("missing file path".into()));
    }
    // Validate the commit-ish up front so a malicious value is rejected
    // regardless of whether the folder turns out to be a repo.
    if commit != WORKING {
        validate_hash(commit)?;
    }
    let Some(root) = toplevel(cwd).await else {
        return Ok(GitDiff {
            path: path.to_string(),
            diff: String::new(),
        });
    };
    let diff = if commit == WORKING {
        // Working-tree changes vs HEAD. For an untracked file HEAD has nothing,
        // so fall back to diffing against /dev/null to show it as all-added.
        let tracked = git(&root, &["diff", "HEAD", "--", path]).await.ok().flatten();
        match tracked {
            Some(s) if !s.trim().is_empty() => s,
            _ => git(&root, &["diff", "--no-index", "--", "/dev/null", path])
                .await
                .ok()
                .flatten()
                .unwrap_or_default(),
        }
    } else {
        git(&root, &["show", "--pretty=format:", commit, "--", path])
            .await
            .ok()
            .flatten()
            .unwrap_or_default()
    };
    Ok(GitDiff {
        path: path.to_string(),
        diff,
    })
}

/// Ensure `cwd` exists and is a directory before shelling out to git.
fn require_dir(cwd: &str) -> AppResult<()> {
    if cwd.trim().is_empty() {
        return Err(AppError::BadRequest("missing cwd".into()));
    }
    let p = PathBuf::from(cwd);
    if !p.is_dir() {
        return Err(AppError::BadRequest(format!("not a directory: {cwd}")));
    }
    Ok(())
}

/// Reject anything that isn't a plausible commit-ish, so a hash can't smuggle
/// extra `git` arguments or flags.
fn validate_hash(commit: &str) -> AppResult<()> {
    let ok = !commit.is_empty()
        && commit.len() <= 64
        && commit.chars().all(|c| c.is_ascii_alphanumeric());
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!("invalid commit: {commit}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn run(dir: &std::path::Path, args: &[&str]) {
        let ok = StdCommand::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    }

    fn init_repo(dir: &std::path::Path) {
        run(dir, &["init", "-q"]);
        run(dir, &["config", "user.email", "t@t.t"]);
        run(dir, &["config", "user.name", "t"]);
        run(dir, &["config", "commit.gpgsign", "false"]);
    }

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

    #[tokio::test]
    async fn git_info_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        let info = git_info(dir.path().to_str().unwrap()).await.unwrap();
        // `git` is expected on dev/CI machines; the folder is not a repo.
        assert!(info.available);
        assert!(!info.is_repo);
        assert!(info.branch.is_none());
    }

    #[tokio::test]
    async fn git_history_changes_and_diff() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
        run(dir.path(), &["add", "a.txt"]);
        // Subject + body (two -m args), so we can verify body parsing.
        run(dir.path(), &["commit", "-q", "-m", "first", "-m", "more detail"]);

        let info = git_info(cwd).await.unwrap();
        assert!(info.is_repo);
        assert!(info.branch.is_some());

        let log = git_log(cwd).await.unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "first");
        assert_eq!(log[0].body, "more detail");

        let changes = git_changes(cwd, &log[0].hash).await.unwrap();
        assert!(changes.iter().any(|c| c.path == "a.txt"));

        let diff = git_diff(cwd, &log[0].hash, "a.txt").await.unwrap();
        assert!(diff.diff.contains("hello"));

        // Working-tree change shows up under the WORKING sentinel.
        std::fs::write(dir.path().join("a.txt"), "hello\nworld\n").unwrap();
        let working = git_changes(cwd, WORKING).await.unwrap();
        assert!(working.iter().any(|c| c.path == "a.txt"));
        let wdiff = git_diff(cwd, WORKING, "a.txt").await.unwrap();
        assert!(wdiff.diff.contains("world"));
    }

    #[tokio::test]
    async fn diff_rejects_bad_commit() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        assert!(git_diff(cwd, "../etc; rm", "a.txt").await.is_err());
    }
}
