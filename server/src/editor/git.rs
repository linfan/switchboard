//! Git queries (branch, history, changed files, diffs) for the workspace editor.
//!
//! Everything shells out to the host's `git` binary. If it is missing or the
//! folder is not a repo, [`git_info`] reports that so the client can hide the
//! git panels. Commit-ish values are validated by [`validate_hash`] before they
//! reach `git`, so they cannot smuggle extra arguments or flags.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::Command;

use switchboard_shared::{GitChange, GitCommit, GitDiff, GitFileDiff, GitInfo, GitWorktree};

use crate::error::{AppError, AppResult};

/// Sentinel `commit` value meaning "the working tree" (uncommitted changes).
const WORKING: &str = "WORKING";

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

/// Old + new contents of one file, for the client's editor diff view. Unlike
/// [`git_diff`] (which returns a pre-rendered unified diff), this hands back both
/// sides so the client can render a real side-by-side/inline diff editor.
pub async fn git_file_diff(cwd: &str, commit: &str, path: &str) -> AppResult<GitFileDiff> {
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
        return Ok(GitFileDiff {
            path: path.to_string(),
            old_text: String::new(),
            new_text: String::new(),
            binary: false,
        });
    };

    // Content of `path` at a git rev via the `rev:path` syntax; empty when the
    // rev/path doesn't resolve (root commit, added file, untracked, …).
    async fn at_rev(root: &str, rev: &str, path: &str) -> String {
        git(root, &["show", &format!("{rev}:{path}")])
            .await
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    let (old_text, new_text) = if commit == WORKING {
        // New side is the current working-tree file; old side is HEAD's version.
        let working = tokio::fs::read(PathBuf::from(&root).join(path))
            .await
            .unwrap_or_default();
        let new_text = String::from_utf8_lossy(&working).into_owned();
        let old_text = at_rev(&root, "HEAD", path).await;
        (old_text, new_text)
    } else {
        // A commit vs its first parent.
        let new_text = at_rev(&root, commit, path).await;
        let old_text = at_rev(&root, &format!("{commit}^"), path).await;
        (old_text, new_text)
    };

    // Treat an embedded NUL as "binary" (mirrors `read_file`): don't ship control
    // bytes to the diff editor.
    let binary = old_text.contains('\0') || new_text.contains('\0');
    Ok(GitFileDiff {
        path: path.to_string(),
        old_text: if binary { String::new() } else { old_text },
        new_text: if binary { String::new() } else { new_text },
        binary,
    })
}

/// Create a git worktree for `cwd`'s repo at
/// `$HOME/.switchboard/worktree/<workspace_name>/<worktree_name>` on the host.
///
/// When `branch` is given, that (existing) branch is checked out into the new
/// worktree; otherwise a fresh branch named `worktree_name` is created at HEAD.
/// Both name segments are validated so they can't escape their parent directory
/// or be read by `git` as a flag.
pub async fn git_worktree_add(
    cwd: &str,
    workspace_name: &str,
    worktree_name: &str,
    branch: Option<&str>,
) -> AppResult<GitWorktree> {
    require_dir(cwd)?;
    validate_segment(workspace_name)?;
    validate_segment(worktree_name)?;
    if let Some(b) = branch {
        validate_ref(b)?;
    }
    if !git_available().await {
        return Err(AppError::BadRequest(
            "git is not installed on the host".into(),
        ));
    }
    let Some(root) = toplevel(cwd).await else {
        return Err(AppError::BadRequest(format!(
            "not a git repository: {cwd}"
        )));
    };

    // Resolve $HOME/.switchboard/worktree/<workspace_name>/<worktree_name>.
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| AppError::BadRequest("HOME is not set on the host".into()))?;
    let dest = home
        .join(".switchboard")
        .join("worktree")
        .join(workspace_name)
        .join(worktree_name);
    if dest.exists() {
        return Err(AppError::BadRequest(format!(
            "worktree path already exists: {}",
            dest.display()
        )));
    }
    // Create the parent (…/worktree/<workspace_name>); git creates the leaf
    // worktree directory itself.
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::BadRequest(format!("cannot create '{}': {e}", parent.display()))
        })?;
    }
    let dest_str = dest.to_string_lossy().into_owned();

    // `-b <name> <path>` creates a new branch; `<path> <branch>` checks out an
    // existing one. Names are validated above, so they can't inject flags.
    let args: Vec<&str> = match branch {
        Some(b) => vec!["worktree", "add", dest_str.as_str(), b],
        None => vec!["worktree", "add", "-b", worktree_name, dest_str.as_str()],
    };
    let output = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(&args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| AppError::BadRequest(format!("failed to run git: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::BadRequest(format!(
            "git worktree add failed: {}",
            stderr.trim()
        )));
    }
    Ok(GitWorktree {
        path: dest_str,
        branch: branch
            .map(str::to_string)
            .unwrap_or_else(|| worktree_name.to_string()),
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

/// A safe single path segment (workspace/worktree folder name): non-empty, no
/// path separators, no `.`/`..`, no NUL, and not starting with `-` (so it can't
/// be read by `git` as a flag). Also used verbatim as a new branch name.
fn validate_segment(name: &str) -> AppResult<()> {
    let ok = !name.trim().is_empty()
        && name != "."
        && name != ".."
        && !name.starts_with('-')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0');
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!("invalid name: {name}")))
    }
}

/// Validate an existing-branch ref to check out: allows `/` (e.g. `feature/x`)
/// but forbids anything that could inject a flag or an unsafe git refname.
fn validate_ref(name: &str) -> AppResult<()> {
    let ok = !name.trim().is_empty()
        && !name.starts_with('-')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'));
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!("invalid branch: {name}")))
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

        // File-diff of the (added) file in the first commit: new side has the
        // content, old side is empty (no parent).
        let fd = git_file_diff(cwd, &log[0].hash, "a.txt").await.unwrap();
        assert_eq!(fd.new_text, "hello\n");
        assert_eq!(fd.old_text, "");
        assert!(!fd.binary);

        // Working-tree change shows up under the WORKING sentinel.
        std::fs::write(dir.path().join("a.txt"), "hello\nworld\n").unwrap();
        let working = git_changes(cwd, WORKING).await.unwrap();
        assert!(working.iter().any(|c| c.path == "a.txt"));
        let wdiff = git_diff(cwd, WORKING, "a.txt").await.unwrap();
        assert!(wdiff.diff.contains("world"));

        // File-diff of the working-tree change: old side is HEAD, new side is disk.
        let wfd = git_file_diff(cwd, WORKING, "a.txt").await.unwrap();
        assert_eq!(wfd.old_text, "hello\n");
        assert_eq!(wfd.new_text, "hello\nworld\n");
        assert!(!wfd.binary);

        // A second commit modifying the file: old side is the first commit's version.
        run(dir.path(), &["add", "a.txt"]);
        run(dir.path(), &["commit", "-q", "-m", "second"]);
        let log2 = git_log(cwd).await.unwrap();
        let head = &log2[0].hash;
        let mfd = git_file_diff(cwd, head, "a.txt").await.unwrap();
        assert_eq!(mfd.old_text, "hello\n");
        assert_eq!(mfd.new_text, "hello\nworld\n");
    }

    #[tokio::test]
    async fn diff_rejects_bad_commit() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        assert!(git_diff(cwd, "../etc; rm", "a.txt").await.is_err());
    }
}
