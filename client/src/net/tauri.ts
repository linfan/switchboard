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

/**
 * Subscribe to an event emitted by the native layer (e.g. a menu item that has
 * no predefined action). Resolves to an unsubscribe function; in the browser,
 * where nothing can emit, it resolves to a no-op so callers need no `isTauri`
 * branch of their own.
 */
export async function listen(
  event: string,
  handler: () => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen(event, () => handler());
}

/**
 * Turn a local file path into an `asset:` URL the webview can load — used for
 * media previews, which stream from a cache file on disk. The path must have been
 * allowed on the asset-protocol scope first (see the `cache_media` command).
 */
export async function assetUrl(path: string): Promise<string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}
