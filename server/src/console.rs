//! Whether the stdout log stream can render ANSI color escapes.

/// Whether the stdout subscriber should colorize.
///
/// `NO_COLOR` (set to anything non-empty) always wins; otherwise colors are on
/// only when stdout is a terminal that actually understands the escapes. On
/// Windows that means asking the console for virtual-terminal processing first:
/// without it, `conhost` prints the escape bytes literally (`←[2m…←[0m`
/// smeared through every line) instead of coloring them, and a stdout that is a
/// file or a pipe (a service's redirected output) has no console at all.
pub fn ansi_stdout() -> bool {
    if std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()) {
        return false;
    }
    stdout_supports_ansi()
}

#[cfg(unix)]
fn stdout_supports_ansi() -> bool {
    // SAFETY: `isatty` only inspects the descriptor.
    unsafe { libc::isatty(libc::STDOUT_FILENO) == 1 }
}

/// Turn on `ENABLE_VIRTUAL_TERMINAL_PROCESSING` for our stdout console and
/// report whether escapes are safe to emit. Modern Windows Terminal already has
/// the bit set; legacy `cmd.exe` / `conhost` needs the flip and pre-1809 builds
/// reject it outright, in which case we colorize nothing.
#[cfg(windows)]
fn stdout_supports_ansi() -> bool {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
        STD_OUTPUT_HANDLE,
    };

    // SAFETY: returns the process's existing stdout handle; we don't close it.
    let handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return false;
    }
    let mut mode = 0u32;
    // SAFETY: `handle` is our stdout handle, `mode` a valid out-param. This
    // fails when stdout is a file or pipe rather than a console.
    if unsafe { GetConsoleMode(handle, &mut mode) } == 0 {
        return false;
    }
    if mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
        return true;
    }
    // SAFETY: same handle; OR-ing one flag onto the mode we just read leaves
    // the console's other settings intact.
    unsafe { SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0 }
}

/// Platforms with neither `isatty` nor a Win32 console: assume no escapes.
#[cfg(not(any(unix, windows)))]
fn stdout_supports_ansi() -> bool {
    false
}
