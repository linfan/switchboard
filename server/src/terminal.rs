//! Server-side terminal emulator: the authoritative screen for a PTY task.
//!
//! Every PTY chunk is fed through a `vt100::Parser`, so the emulator's screen is
//! a pure function of the ordered chunk log. On reconnect we render the current
//! screen with [`TerminalEmulator::snapshot`] — the ANSI escape sequences that
//! recreate the visible grid — and the client resets then writes them, provably
//! matching the server. See PTY-SPEC §5.

/// Wraps a `vt100::Parser` with the current terminal size.
pub struct TerminalEmulator {
    parser: vt100::Parser,
    cols: u16,
    rows: u16,
}

impl TerminalEmulator {
    /// Create an emulator sized `cols` × `rows` with no scrollback (the client's
    /// xterm keeps scrollback; snapshots cover the visible screen only).
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, 0),
            cols,
            rows,
        }
    }

    /// Feed raw PTY bytes into the emulator.
    pub fn process(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    /// Resize the emulated screen so snapshots match the client's viewport.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        if (cols, rows) != (self.cols, self.rows) {
            self.parser.set_size(rows, cols);
            self.cols = cols;
            self.rows = rows;
        }
    }

    /// ANSI escape sequences that reconstruct the current visible screen.
    pub fn snapshot(&self) -> Vec<u8> {
        self.parser.screen().contents_formatted()
    }

    /// Plain-text contents of the current screen (rows joined by `\n`), used in
    /// tests and diagnostics.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn contents(&self) -> String {
        self.parser.screen().contents()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reconstructs_the_screen() {
        let mut term = TerminalEmulator::new(80, 24);
        term.process(b"\x1b[2J\x1b[H"); // clear + home
        term.process(b"hello \x1b[31mred\x1b[0m world");
        let expected = term.contents();

        // Replay the snapshot into a fresh emulator: it must converge.
        let snap = term.snapshot();
        let mut replay = TerminalEmulator::new(80, 24);
        replay.process(&snap);
        assert_eq!(replay.contents(), expected);
        assert!(expected.contains("hello red world"));
    }

    #[test]
    fn resize_changes_the_grid() {
        let mut term = TerminalEmulator::new(80, 24);
        term.resize(100, 40);
        // A line longer than 80 cols must not wrap at the old width.
        let line = "x".repeat(90);
        term.process(line.as_bytes());
        assert!(term.contents().lines().next().unwrap().len() >= 90);
    }
}
