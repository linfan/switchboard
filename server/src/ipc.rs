//! Local IPC transport between the server and its pty-host processes.
//!
//! One abstraction over two platform primitives:
//!
//! * **unix** — a filesystem socket at `<dir>/<task_id>.sock`.
//! * **windows** — a named pipe at `\\.\pipe\switchboard-pty-<task_id>`.
//!
//! The host is the listener and the server is the client, which is what makes a
//! server restart survivable: the endpoint keeps existing while nobody is
//! connected, and the new server process simply dials it again.
//!
//! The two ends are separate types ([`ServerStream`] accepted by the host,
//! [`ClientStream`] dialed by the server) because on Windows they genuinely are
//! different: only the listening end can `connect`/`disconnect` a pipe instance.
//! Consumers are generic over `AsyncRead + AsyncWrite`, so this never surfaces.

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// How long to keep retrying [`connect`] before giving up. A freshly spawned
/// host needs a few milliseconds to bind, and the server dials immediately.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const CONNECT_RETRY: std::time::Duration = std::time::Duration::from_millis(25);

/// Directory holding per-task host endpoints and logs, derived from the database
/// path so it lands beside the rest of the server's durable state.
pub fn hosts_dir(db_path: &str) -> PathBuf {
    let parent = Path::new(db_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    parent.join("hosts")
}

/// The endpoint a task's host listens on. On unix this is a path inside
/// [`hosts_dir`]; on Windows it is a pipe name and `db_path` is unused (the pipe
/// namespace is global, so the task id alone is unique).
///
/// The unix filename is a truncated digest of the task id rather than the id
/// itself: `sockaddr_un.sun_path` holds only ~104 bytes on macOS, and a 36-char
/// uuid plus a deep data directory blows past that. 64 bits of digest is far
/// more than enough to keep concurrent tasks apart.
#[cfg(unix)]
pub fn endpoint_for(db_path: &str, task_id: &str) -> String {
    let digest = switchboard_shared::auth::sha256(task_id.as_bytes());
    let short = switchboard_shared::auth::hex(&digest[..8]);
    hosts_dir(db_path)
        .join(format!("{short}.sock"))
        .to_string_lossy()
        .into_owned()
}

#[cfg(windows)]
pub fn endpoint_for(_db_path: &str, task_id: &str) -> String {
    format!(r"\\.\pipe\switchboard-pty-{task_id}")
}

/// Path of a host's own log file. The host is spawned detached with no console,
/// so this is the only place its diagnostics can go.
pub fn log_path_for(db_path: &str, task_id: &str) -> PathBuf {
    hosts_dir(db_path).join(format!("{task_id}.log"))
}

#[cfg(unix)]
pub use unix_impl::{connect, listen};
#[cfg(windows)]
pub use windows_impl::{connect, listen};

#[cfg(unix)]
mod unix_impl {
    use super::*;
    use tokio::net::{UnixListener, UnixStream};

    pub type ServerStream = UnixStream;
    pub type ClientStream = UnixStream;

    /// A bound unix socket that unlinks its path on drop.
    pub struct Listener {
        inner: UnixListener,
        path: PathBuf,
    }

    impl Listener {
        pub async fn accept(&mut self) -> AppResult<ServerStream> {
            let (stream, _) = self
                .inner
                .accept()
                .await
                .map_err(|e| AppError::Other(anyhow::anyhow!("ipc accept failed: {e}")))?;
            Ok(stream)
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    /// Bind `endpoint`, replacing a stale socket file left by a dead host.
    pub fn listen(endpoint: &str) -> AppResult<Listener> {
        let path = PathBuf::from(endpoint);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Other(anyhow::anyhow!(
                    "cannot create ipc directory {}: {e}",
                    parent.display()
                ))
            })?;
        }
        // A leftover file from a host that died without unlinking would make
        // bind fail with EADDRINUSE. Nobody else can legitimately own this path
        // (it is keyed by a fresh task uuid), so removing it is safe.
        let _ = std::fs::remove_file(&path);
        let inner = UnixListener::bind(&path)
            .map_err(|e| AppError::Other(anyhow::anyhow!("cannot bind {endpoint}: {e}")))?;
        Ok(Listener { inner, path })
    }

    /// Dial `endpoint`, retrying until [`CONNECT_TIMEOUT`] elapses.
    pub async fn connect(endpoint: &str) -> AppResult<ClientStream> {
        let deadline = std::time::Instant::now() + CONNECT_TIMEOUT;
        loop {
            match UnixStream::connect(endpoint).await {
                Ok(s) => return Ok(s),
                Err(e) if std::time::Instant::now() >= deadline => {
                    return Err(AppError::Other(anyhow::anyhow!(
                        "cannot connect to {endpoint}: {e}"
                    )))
                }
                Err(_) => tokio::time::sleep(CONNECT_RETRY).await,
            }
        }
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
    };

    pub type ServerStream = NamedPipeServer;
    pub type ClientStream = NamedPipeClient;

    /// A named-pipe listener. Unlike a unix socket, each accepted connection
    /// *consumes* a pipe instance, so a fresh instance is created per accept.
    pub struct Listener {
        name: String,
        /// The instance currently waiting for a client, created ahead of time so
        /// a dialing server never sees "pipe does not exist".
        pending: Option<NamedPipeServer>,
    }

    impl Listener {
        pub async fn accept(&mut self) -> AppResult<ServerStream> {
            let server = match self.pending.take() {
                Some(s) => s,
                None => create_instance(&self.name, false)?,
            };
            server
                .connect()
                .await
                .map_err(|e| AppError::Other(anyhow::anyhow!("ipc accept failed: {e}")))?;
            // Have the next instance listening before we hand this one back, so
            // there is no window where the pipe name is unbound.
            self.pending = Some(create_instance(&self.name, false)?);
            Ok(server)
        }
    }

    fn create_instance(name: &str, first: bool) -> AppResult<NamedPipeServer> {
        ServerOptions::new()
            .first_pipe_instance(first)
            .create(name)
            .map_err(|e| AppError::Other(anyhow::anyhow!("cannot bind {name}: {e}")))
    }

    /// Create the first instance of `endpoint`. `first_pipe_instance` makes this
    /// fail rather than silently sharing a name another process already owns.
    pub fn listen(endpoint: &str) -> AppResult<Listener> {
        let pending = create_instance(endpoint, true)?;
        Ok(Listener {
            name: endpoint.to_string(),
            pending: Some(pending),
        })
    }

    /// Dial `endpoint`, retrying until [`CONNECT_TIMEOUT`] elapses. A pipe whose
    /// every instance is busy reports `ERROR_PIPE_BUSY`, which is retryable and
    /// happens whenever the host is between `accept` calls.
    pub async fn connect(endpoint: &str) -> AppResult<ClientStream> {
        let deadline = std::time::Instant::now() + CONNECT_TIMEOUT;
        loop {
            match ClientOptions::new().open(endpoint) {
                Ok(client) => return Ok(client),
                Err(e) if std::time::Instant::now() >= deadline => {
                    return Err(AppError::Other(anyhow::anyhow!(
                        "cannot connect to {endpoint}: {e}"
                    )))
                }
                Err(_) => tokio::time::sleep(CONNECT_RETRY).await,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn endpoint_is_task_scoped_and_stable() {
        let a = endpoint_for("data/switchboard.db", "task-a");
        let b = endpoint_for("data/switchboard.db", "task-b");
        assert_ne!(a, b);
        assert_eq!(a, endpoint_for("data/switchboard.db", "task-a"));
    }

    /// A host endpoint must fit in `sun_path` even for a realistically deep data
    /// directory, or task creation fails on macOS with an opaque bind error.
    #[cfg(unix)]
    #[test]
    fn unix_endpoint_stays_within_sun_path() {
        let deep = "/var/folders/_6/1swqrmss7t7_crpg5k6g72lw0000gn/T/.tmpAbCdEf/switchboard.db";
        let endpoint = endpoint_for(deep, &uuid::Uuid::new_v4().to_string());
        assert!(
            endpoint.len() < 104,
            "endpoint is {} bytes: {endpoint}",
            endpoint.len()
        );
    }

    #[test]
    fn hosts_dir_sits_beside_the_database() {
        assert_eq!(
            hosts_dir("/opt/switchboard/data/switchboard.db"),
            PathBuf::from("/opt/switchboard/data/hosts")
        );
        // A bare filename has no parent to speak of; stay in the cwd.
        assert_eq!(hosts_dir("switchboard.db"), PathBuf::from("./hosts"));
    }

    /// The transport must round-trip bytes in both directions, and — critically
    /// for the upgrade story — accept a *second* connection after the first one
    /// goes away, since that is exactly what a restarted server does.
    #[tokio::test]
    async fn round_trips_and_accepts_a_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir
            .path()
            .join("switchboard.db")
            .to_string_lossy()
            .into_owned();
        let endpoint = endpoint_for(&db, &uuid::Uuid::new_v4().to_string());

        let mut listener = listen(&endpoint).unwrap();
        let ep = endpoint.clone();
        let host = tokio::spawn(async move {
            for expect in ["one", "two"] {
                let mut stream = listener.accept().await.unwrap();
                let mut buf = vec![0u8; expect.len()];
                stream.read_exact(&mut buf).await.unwrap();
                assert_eq!(std::str::from_utf8(&buf).unwrap(), expect);
                stream.write_all(b"ack").await.unwrap();
                stream.flush().await.unwrap();
            }
        });

        for msg in [b"one", b"two"] {
            let mut client = connect(&ep).await.unwrap();
            client.write_all(msg).await.unwrap();
            client.flush().await.unwrap();
            let mut ack = [0u8; 3];
            client.read_exact(&mut ack).await.unwrap();
            assert_eq!(&ack, b"ack");
            drop(client);
        }
        host.await.unwrap();
    }
}
