//! Download/upload orchestration for the file tree, plus the editor's media
//! previews. Byte transfer needs a local save/open location, so this bridges
//! native OS dialogs (Tauri) or the browser's download anchor / file input (dev).
//! The actual bytes move through the native Rust commands (`download_file`/
//! `upload_file`/`cache_media`) in Tauri — binary safe, no base64 — or plain
//! `fetch` in the browser.
//!
//! A transfer takes one file, so a *batch* is one dialog plus a sequential run
//! over the picked files: each file gets its own progress row, and one failing
//! (a name the host refuses to clobber, a dropped connection) never stops the
//! rest. The per-operation file cap is enforced by the callers — the tree stops
//! adding to a selection at its limit, and {@link uploadFiles} refuses a picker
//! that came back over its limit.
//!
//! Transfers report progress through {@link TransferHooks} so the file tree can
//! show how far along they are, and stay cancellable via {@link cancelTransfer}.
//! Ids are allocated here and the abort handles live in a module-level registry
//! (like `net/editors.ts`), so the store holds plain data and a component that
//! unmounts mid-transfer doesn't strand it.

import { cbFromPin, fromHex, hex, restSignHeaders, sha256 } from "./swbauth";
import { assetUrl, invoke, isTauri } from "./tauri";

interface ServiceRef {
  url: string;
  token: string;
  /** Pinned leaf-cert fingerprint (hex); absent for plain-HTTP services. */
  certFingerprint?: string;
}

function baseUrl(service: ServiceRef): string {
  return service.url.replace(/\/+$/, "");
}

/**
 * Base name of a path, tolerating both `/` and `\` separators. Hosts can be
 * Windows, so a name is whatever follows the last separator either way.
 */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Default cap on how many files one operation may carry, in either direction.
 * Both are editable in the settings dialog (`uploadMaxFiles` /
 * `downloadMaxFiles`).
 */
export const DEFAULT_MAX_UPLOAD_FILES = 50;
export const DEFAULT_MAX_DOWNLOAD_FILES = 50;

/** Progress reporting for one transfer, and the id needed to cancel it. */
export interface TransferHooks {
  /**
   * Fires once the local files are known — after the save/open dialog, before
   * any bytes move — so a row appears for the whole life of each transfer.
   */
  onStart: (t: { id: number; name: string; total?: number }) => void;
  /** Bytes moved so far; `total` is absent when the size isn't known up front. */
  onProgress: (id: number, done: number, total?: number) => void;
  /**
   * Fires as a transfer ends — completed, failed or cancelled — so its row
   * leaves with it instead of waiting for the rest of the batch.
   */
  onEnd?: (id: number) => void;
}

/** One item of a batch run: enough to label and size its progress row. */
interface BatchItem {
  name: string;
  /** Known size up front; absent when the transfer learns it mid-flight. */
  total?: number;
}

/**
 * What a batch run moved. A file the user cancelled is neither a success nor a
 * failure, so it counts separately.
 */
export interface BatchOutcome {
  /** Base names that completed. */
  done: string[];
  /** Per-file failures, in the order attempted. */
  failed: { name: string; message: string }[];
  /** Transfers the user stopped, at the dialog or in flight. */
  cancelled: number;
}

function emptyOutcome(): BatchOutcome {
  return { done: [], failed: [], cancelled: 0 };
}

/**
 * Move `items` through `one` a file at a time. Every id goes out before the
 * first byte, so the whole batch is visible and individually cancellable from
 * the start; a file that throws is recorded and skipped rather than aborting
 * the run.
 */
async function runBatch<T extends BatchItem>(
  items: T[],
  hooks: TransferHooks | undefined,
  one: (item: T, id: number) => Promise<boolean>,
): Promise<BatchOutcome> {
  const outcome = emptyOutcome();
  const ids = items.map(() => nextTransferId++);
  items.forEach((item, i) =>
    hooks?.onStart({ id: ids[i], name: item.name, total: item.total }),
  );
  for (const [i, item] of items.entries()) {
    try {
      if (await one(item, ids[i])) outcome.done.push(item.name);
      else outcome.cancelled++;
    } catch (e) {
      outcome.failed.push({
        name: item.name,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      hooks?.onEnd?.(ids[i]);
    }
  }
  return outcome;
}

/**
 * `name` inside the local folder `dir`, keeping the separator `dir` was spelled
 * with — this machine may be Windows while the host is not.
 */
export function joinLocalPath(dir: string, name: string): string {
  const base = dir.replace(/[\\/]+$/, "");
  return `${base}${base.includes("\\") ? "\\" : "/"}${name}`;
}

/** One tick from the Rust side (mirrors `Progress` in `net.rs`). */
interface ProgressTick {
  done: number;
  total: number | null;
}

let nextTransferId = 1;

/** Abort handles for in-flight transfers, keyed by transfer id. */
const cancels = new Map<number, () => void>();

/**
 * Ask an in-flight transfer to stop. The transfer itself then resolves `false`,
 * so a cancel reads as "nothing was transferred" rather than as a failure.
 */
export function cancelTransfer(id: number): void {
  cancels.get(id)?.();
}

/**
 * Register `abort` for `id` and run `body`, clearing the handle afterwards so a
 * late cancel can't reach a transfer that already finished.
 */
async function tracked<T>(
  id: number,
  abort: () => void,
  body: () => Promise<T>,
): Promise<T> {
  cancels.set(id, abort);
  try {
    return await body();
  } finally {
    cancels.delete(id);
  }
}

/**
 * A Tauri `Channel` that forwards Rust progress ticks to `hooks`. Registered
 * before the invoke so no tick can be missed; a hookless caller gets a channel
 * whose messages go nowhere, which keeps the command signature uniform.
 */
async function progressChannel(
  id: number,
  hooks?: TransferHooks,
): Promise<unknown> {
  const { Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<ProgressTick>();
  channel.onmessage = (tick) =>
    hooks?.onProgress(id, tick.done, tick.total ?? undefined);
  return channel;
}

/**
 * SWB-REST-v1 signing headers for a byte transfer. `path` is the exact request
 * target the server signs (`/api/...` including query); `bodyHash` is SHA-256 of
 * the raw request body (of the empty body for a download).
 */
function signHeaders(
  service: ServiceRef,
  method: string,
  path: string,
  bodyHash: Uint8Array,
): Promise<Record<string, string>> {
  return restSignHeaders({
    token: service.token,
    method,
    pathAndQuery: path,
    bodyHash,
    cb: cbFromPin(service.certFingerprint),
  });
}

/**
 * Save the host files at `paths` to a user-chosen local location: a save dialog
 * for one file, one destination folder picked for a batch. Each file is saved
 * under its own base name. Backing out of the dialog is an empty outcome, not an
 * error. The caller owns the file cap (Settings → "Max files per download").
 */
export async function downloadFiles(
  service: ServiceRef,
  paths: string[],
  hooks?: TransferHooks,
): Promise<BatchOutcome> {
  const files = paths.map((path) => ({ path, name: basename(path) }));
  const dests = await chooseDownloadDests(files);
  if (!dests) {
    const outcome = emptyOutcome();
    outcome.cancelled = files.length;
    return outcome;
  }
  return runBatch(
    files.map((file, i) => ({ ...file, dest: dests[i] })),
    hooks,
    (file, id) => downloadOne(service, file, id, hooks),
  );
}

/**
 * Where each downloaded file goes, asking the user once; `null` when they backed
 * out. In the browser the location is the browser's to choose, so only the
 * suggested name comes back.
 */
async function chooseDownloadDests(
  files: { name: string }[],
): Promise<string[] | null> {
  if (files.length === 0) return [];
  if (!isTauri) return files.map((f) => f.name);
  const { open, save } = await import("@tauri-apps/plugin-dialog");
  if (files.length === 1) {
    const dest = await save({ defaultPath: files[0].name });
    return dest ? [dest] : null;
  }
  // One folder for the whole batch, rather than a save dialog per file.
  const dir = await open({
    title: `Choose a folder for ${files.length} downloads`,
    directory: true,
    multiple: false,
  });
  if (typeof dir !== "string") return null;
  return files.map((f) => joinLocalPath(dir, f.name));
}

/**
 * One file of a {@link downloadFiles} batch. `dest` is the local path to write
 * to, or in the browser the name the download is offered under.
 */
async function downloadOne(
  service: ServiceRef,
  file: { path: string; name: string; dest: string },
  id: number,
  hooks?: TransferHooks,
): Promise<boolean> {
  const reqPath = `/api/fs/download?path=${encodeURIComponent(file.path)}`;
  const url = `${baseUrl(service)}${reqPath}`;
  // A download has no request body; the MAC covers the empty-body hash.
  const emptyHash = await sha256(new Uint8Array(0));
  const headers = await signHeaders(service, "GET", reqPath, emptyHash);
  const { name, dest } = file;

  if (isTauri) {
    // The size is only known once the response headers land, so the row starts
    // out indeterminate and the first tick fills its total in.
    const onProgress = await progressChannel(id, hooks);
    return tracked(
      id,
      () => void invoke<void>("cancel_transfer", { id }),
      () =>
        invoke<boolean>("download_file", {
          url,
          headers: Object.entries(headers),
          pin: service.certFingerprint ?? null,
          dest,
          transferId: id,
          onProgress,
        }),
    );
  }

  // Browser: stream the bytes (counting them for progress) and hand the
  // assembled blob to a download anchor.
  const abort = new AbortController();
  const blob = await tracked(
    id,
    () => abort.abort(),
    async () => {
      const res = await fetch(url, { headers, signal: abort.signal });
      if (!res.ok) throw new Error(await errorText(res));
      const header = res.headers.get("content-length");
      const total = header ? Number(header) : undefined;
      hooks?.onProgress(id, 0, total);
      const reader = res.body?.getReader();
      if (!reader) return res.blob();
      const chunks: Uint8Array[] = [];
      let done = 0;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
        done += step.value.byteLength;
        hooks?.onProgress(id, done, total);
      }
      return new Blob(chunks as BlobPart[]);
    },
  ).catch((e: unknown) => {
    // An abort is a cancel, not a failure.
    if (abort.signal.aborted) return null;
    throw e;
  });
  if (!blob) return false;

  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
  return true;
}

/** A media preview's source URL plus the release of whatever backs it. */
export interface Preview {
  /** Src for an `<img>`/`<audio>`/`<video>` element. */
  url: string;
  /** Drop the backing cache file (Tauri) or object URL (browser). */
  release: () => void;
}

/**
 * Cache file name for a preview: hex SHA-256 over service + path + mtime, so an
 * edited file gets its own file instead of a stale hit. Truncated to 128 bits,
 * which is ample for names that only have to not collide.
 */
async function previewKey(
  serviceUrl: string,
  path: string,
  mtime: number,
): Promise<string> {
  const material = new TextEncoder().encode(`${serviceUrl} ${path} ${mtime}`);
  return hex(await sha256(material)).slice(0, 32);
}

/**
 * Make the host's media file at `path` playable in the webview, for the editor's
 * preview tabs. In Tauri the bytes are cached to a local file and served over
 * `asset:`, which answers Range requests — so a video seeks without ever holding
 * the file in webview memory; the browser build falls back to a blob. Callers
 * must `release()` when the preview goes away (see `net/editors.ts`).
 */
export async function openPreview(
  service: ServiceRef,
  path: string,
  ext: string,
  mtime: number,
): Promise<Preview> {
  const reqPath = `/api/fs/download?path=${encodeURIComponent(path)}`;
  const url = `${baseUrl(service)}${reqPath}`;
  // Like a download, this has no request body; the MAC covers the empty-body hash.
  const emptyHash = await sha256(new Uint8Array(0));
  const headers = await signHeaders(service, "GET", reqPath, emptyHash);

  if (isTauri) {
    const local = await invoke<string>("cache_media", {
      url,
      headers: Object.entries(headers),
      pin: service.certFingerprint ?? null,
      key: await previewKey(service.url, path, mtime),
      ext,
    });
    return {
      url: await assetUrl(local),
      release: () => {
        // Best-effort: a failed delete is swept at startup/exit anyway.
        void invoke<void>("drop_cached_media", { path: local }).catch(() => {});
      },
    };
  }

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(await errorText(res));
  const objectUrl = URL.createObjectURL(await res.blob());
  return { url: objectUrl, release: () => URL.revokeObjectURL(objectUrl) };
}

/**
 * Upload user-chosen local files into host directory `dir`, through one picker
 * for the whole batch. Throws when the picker came back with more than `max`
 * files and transfers nothing, so the user can narrow the selection. Otherwise
 * each file is sent in turn and a refusal — the host never clobbers an existing
 * name — is collected rather than fatal.
 */
export async function uploadFiles(
  service: ServiceRef,
  dir: string,
  max: number,
  hooks?: TransferHooks,
): Promise<BatchOutcome> {
  if (isTauri) {
    const paths = await pickTauriFiles();
    if (paths.length === 0) return emptyOutcome();
    if (paths.length > max) throw tooManyFiles(paths.length, max);
    return runBatch(
      paths.map((path) => ({ name: basename(path), path })),
      hooks,
      (item, id) => uploadFromPath(service, dir, item.path, id, hooks),
    );
  }

  const picked = await pickBrowserFiles();
  if (picked.length === 0) return emptyOutcome();
  if (picked.length > max) throw tooManyFiles(picked.length, max);
  return runBatch(
    picked.map((file) => ({ name: file.name, total: file.size, file })),
    hooks,
    (item, id) => uploadFromBrowser(service, dir, item.file, id, hooks),
  );
}

function tooManyFiles(chosen: number, max: number): Error {
  return new Error(`At most ${max} files per upload (${chosen} chosen).`);
}

/**
 * Upload one local file by path, streaming from disk on the Rust side so a large
 * file never sits in the webview heap. Hashing it is itself a visible pause, so
 * its row is already up; a cancel there sets the flag the upload checks as it
 * starts.
 */
async function uploadFromPath(
  service: ServiceRef,
  dir: string,
  src: string,
  id: number,
  hooks?: TransferHooks,
): Promise<boolean> {
  const reqPath = `/api/fs/upload?dir=${encodeURIComponent(
    dir,
  )}&name=${encodeURIComponent(basename(src))}`;
  const onProgress = await progressChannel(id, hooks);
  return tracked(
    id,
    () => void invoke<void>("cancel_transfer", { id }),
    async () => {
      // The bytes live only on the Rust side, so hash them there for the MAC.
      const bodyHash = fromHex(
        await invoke<string>("hash_file", { path: src }),
      );
      const headers = await signHeaders(service, "POST", reqPath, bodyHash);
      return invoke<boolean>("upload_file", {
        url: `${baseUrl(service)}${reqPath}`,
        headers: Object.entries(headers),
        pin: service.certFingerprint ?? null,
        src,
        transferId: id,
        onProgress,
      });
    },
  );
}

/** Upload one picked browser file by POSTing its bytes. */
async function uploadFromBrowser(
  service: ServiceRef,
  dir: string,
  file: File,
  id: number,
  hooks?: TransferHooks,
): Promise<boolean> {
  const reqPath = `/api/fs/upload?dir=${encodeURIComponent(
    dir,
  )}&name=${encodeURIComponent(file.name)}`;
  const abort = new AbortController();
  const done = await tracked(
    id,
    () => abort.abort(),
    async () => {
      const bodyHash = await sha256(new Uint8Array(await file.arrayBuffer()));
      const headers = await signHeaders(service, "POST", reqPath, bodyHash);
      // `fetch` gives no upload progress, so the bar only moves at the end.
      const res = await fetch(`${baseUrl(service)}${reqPath}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/octet-stream" },
        body: file,
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(await errorText(res));
      hooks?.onProgress(id, file.size, file.size);
      return true;
    },
  ).catch((e: unknown) => {
    // An abort is a cancel, not a failure.
    if (abort.signal.aborted) return false;
    throw e;
  });
  return done;
}

/**
 * Upload a user-chosen local binary as a host self-upgrade (POSTs the raw bytes
 * to the admin upgrade endpoint). Single-file by nature, so it bypasses the
 * batch plumbing; like {@link uploadFiles} the MAC binds the body hash, so no
 * separate checksum is sent. Returns `true` when a binary was uploaded (the host
 * then re-execs), `false` if the user cancelled.
 */
export async function uploadBinaryUpgrade(
  service: ServiceRef,
): Promise<boolean> {
  const reqPath = `/api/admin/upgrade/upload`;
  if (isTauri) {
    const src = await pickTauriFile();
    if (!src) return false;
    // The bytes live only on the Rust side, so hash them there for the MAC.
    const bodyHash = fromHex(await invoke<string>("hash_file", { path: src }));
    const headers = await signHeaders(service, "POST", reqPath, bodyHash);
    const id = nextTransferId++;
    return invoke<boolean>("upload_file", {
      url: `${baseUrl(service)}${reqPath}`,
      headers: Object.entries(headers),
      pin: service.certFingerprint ?? null,
      src,
      transferId: id,
      onProgress: await progressChannel(id),
    });
  }

  const file = (await pickBrowserFiles(false))[0];
  if (!file) return false;
  const bodyHash = await sha256(new Uint8Array(await file.arrayBuffer()));
  const headers = await signHeaders(service, "POST", reqPath, bodyHash);
  const res = await fetch(`${baseUrl(service)}${reqPath}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(await errorText(res));
  return true;
}

/**
 * Prompt for the local files of a batch upload through the native dialog. The
 * plugin types its return off the literal `multiple` flag, so the single-file
 * question below is a separate call rather than a parameter.
 */
async function pickTauriFiles(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return (await open({ multiple: true, directory: false })) ?? [];
}

/** Prompt for exactly one local file — a host upgrade binary takes one. */
async function pickTauriFile(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return await open({ multiple: false, directory: false });
}

/**
 * Prompt the browser for local files, resolving empty when none were chosen.
 */
function pickBrowserFiles(multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () =>
      finish(Array.from(input.files ?? [])),
    );
    // If the dialog is dismissed, `change` never fires; `cancel` (where
    // supported) resolves empty so the caller isn't stuck.
    input.addEventListener("cancel", () => finish([]));
    input.click();
  });
}

/** Best-effort error message from a failed `fetch` response. */
async function errorText(res: Response): Promise<string> {
  if (res.status === 401) return "Invalid token.";
  try {
    return (await res.json()).message ?? `HTTP ${res.status}`;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}
