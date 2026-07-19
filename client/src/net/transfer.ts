//! Download/upload orchestration for the file tree. Byte transfer needs a local
//! save/open location, so this bridges native OS dialogs (Tauri) or the browser's
//! download anchor / file input (dev). The actual bytes move through the native
//! Rust commands (`download_file`/`upload_file`) in Tauri — binary safe, no
//! base64 — or plain `fetch` in the browser.

import { cbFromPin, fromHex, restSignHeaders, sha256 } from "./swbauth";
import { invoke, isTauri } from "./tauri";

interface ServiceRef {
  url: string;
  token: string;
  /** Pinned leaf-cert fingerprint (hex); absent for plain-HTTP services. */
  certFingerprint?: string;
}

function baseUrl(service: ServiceRef): string {
  return service.url.replace(/\/+$/, "");
}

/** Base name of a path, tolerating both `/` and `\` separators. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
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
 * Save the host file at `path` to a user-chosen local location. Returns `true`
 * when a file was written, `false` when the user cancelled the dialog.
 */
export async function downloadFile(
  service: ServiceRef,
  path: string,
  name: string,
): Promise<boolean> {
  const reqPath = `/api/fs/download?path=${encodeURIComponent(path)}`;
  const url = `${baseUrl(service)}${reqPath}`;
  // A download has no request body; the MAC covers the empty-body hash.
  const emptyHash = await sha256(new Uint8Array(0));
  const headers = await signHeaders(service, "GET", reqPath, emptyHash);

  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({ defaultPath: name });
    if (!dest) return false;
    await invoke<void>("download_file", {
      url,
      headers: Object.entries(headers),
      pin: service.certFingerprint ?? null,
      dest,
    });
    return true;
  }

  // Browser: fetch the bytes and trigger a download via an anchor.
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(await errorText(res));
  const blob = await res.blob();
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

/**
 * Upload a user-chosen local file into host directory `dir`. Returns `true` when
 * a file was uploaded, `false` when the user cancelled the picker.
 */
export async function uploadFile(
  service: ServiceRef,
  dir: string,
): Promise<boolean> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const src = await open({ multiple: false, directory: false });
    if (!src || typeof src !== "string") return false;
    const name = basename(src);
    const reqPath = `/api/fs/upload?dir=${encodeURIComponent(
      dir,
    )}&name=${encodeURIComponent(name)}`;
    // The bytes live only on the Rust side, so hash them there for the MAC.
    const bodyHash = fromHex(await invoke<string>("hash_file", { path: src }));
    const headers = await signHeaders(service, "POST", reqPath, bodyHash);
    await invoke<void>("upload_file", {
      url: `${baseUrl(service)}${reqPath}`,
      headers: Object.entries(headers),
      pin: service.certFingerprint ?? null,
      src,
    });
    return true;
  }

  // Browser: pick a file via a transient <input type=file> and POST its bytes.
  const file = await pickBrowserFile();
  if (!file) return false;
  const reqPath = `/api/fs/upload?dir=${encodeURIComponent(
    dir,
  )}&name=${encodeURIComponent(file.name)}`;
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

/** Prompt the browser for a single file, resolving `null` if none was chosen. */
function pickBrowserFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const finish = (f: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    // If the dialog is dismissed, `change` never fires; `cancel` (where
    // supported) or a focus fallback resolves null so the caller isn't stuck.
    input.addEventListener("cancel", () => finish(null));
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
