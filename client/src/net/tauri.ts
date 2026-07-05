//! Thin wrappers around the Tauri IPC surface.
//!
//! The `@tauri-apps/api` modules are imported lazily so the browser build
//! (`npm run dev`, which has no Tauri runtime) never loads them. Call sites gate
//! on {@link isTauri} first.

/** True when running inside the Tauri webview (vs a plain browser). */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export type UnlistenFn = () => void;

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => handler(e.payload));
}
