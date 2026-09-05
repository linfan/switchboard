//! Forward client-side (webview) errors into the native rolling log file.
//!
//! `console.error`, uncaught exceptions, and unhandled promise rejections are
//! sent to the `frontend_log` Tauri command so every kind of frontend error is
//! captured alongside native events in `~/.switchboard/logs`. In a plain browser
//! (no Tauri runtime) forwarding is a no-op and the console behaves normally.

import { invoke, isTauri } from "./tauri";

type Level = "error" | "warn" | "info";

/**
 * Best-effort forward of a message to the native log file. Never throws and
 * never routes back through `console.error`, so it can't recurse or break the
 * app if the IPC call fails.
 */
export function logToBackend(level: Level, message: string): void {
  if (!isTauri) return;
  invoke("frontend_log", { level, message }).catch(() => {});
}

function format(value: unknown): string {
  if (value instanceof Error)
    return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let installed = false;

/**
 * Install global error hooks once. Call as early as possible during startup so
 * failures during the first render are captured too.
 */
export function installErrorLogging(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    const detail = event.error ? format(event.error) : event.message;
    logToBackend("error", `uncaught error: ${detail}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    logToBackend("error", `unhandled rejection: ${format(event.reason)}`);
  });

  // Mirror everything already routed through console.error into the log file,
  // while preserving the original console output.
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    logToBackend("error", args.map(format).join(" "));
  };
}
