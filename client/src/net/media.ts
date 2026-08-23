//! Which files the editor previews as media instead of opening as text, and how
//! big each kind may be. The host's `read_file` would only report an image or a
//! video as `truncated` (NUL bytes / oversize), so the editor decides from the
//! extension *before* fetching anything.
//!
//! Only formats a webview can actually decode are listed: `.svg` is deliberately
//! absent (it's editable text, and opening it in CodeMirror is more useful), as
//! are containers like `.mkv`/`.avi` that would render a broken element.

/** What element previews a file: `<img>`, `<audio>`, or `<video>`. */
export type MediaKind = "image" | "audio" | "video";

const EXTENSIONS: Record<string, MediaKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",

  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  opus: "audio",

  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  ogv: "video",
};

/**
 * Default largest file previewed per kind; the effective cap is configurable in
 * the settings panel. The cap is about transfer time and disk, not memory —
 * previews stream from a local cache file — so it mainly stops an accidental
 * click on a huge file from pulling it over a slow link.
 */
export const DEFAULT_MAX_PREVIEW_BYTES: Record<MediaKind, number> = {
  image: 8 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  video: 32 * 1024 * 1024,
};

/**
 * Classify a path by extension, or `null` when it isn't previewable media (and
 * should therefore open as text). `ext` is returned lowercased because it also
 * names the cache file, which is what the asset protocol sniffs a MIME type from.
 */
export function mediaForPath(
  path: string,
): { kind: MediaKind; ext: string } | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like `.gitignore`
  const ext = name.slice(dot + 1).toLowerCase();
  const kind = EXTENSIONS[ext];
  return kind ? { kind, ext } : null;
}

/** Byte count as a short human-readable size, for the over-the-cap notice. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  // Whole bytes read oddly as "1.0 B"; larger units keep one decimal.
  const rounded = unit === 0 ? String(n) : n.toFixed(1);
  return `${rounded} ${units[unit]}`;
}
