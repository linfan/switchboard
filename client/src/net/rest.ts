//! Minimal authenticated REST calls to a hosting service. The WebSocket carries
//! the live sync plane; this is for request/response lookups like browsing the
//! host's filesystem for the working-directory picker.

import type {
  FileContent,
  FsListing,
  FsStat,
  GitChange,
  GitCommit,
  GitFileDiff,
  GitInfo,
  GitWorktree,
  ServiceInfo,
} from "../protocol";
import { invoke, isTauri } from "./tauri";
import { cbFromPin, restSignHeaders, sha256 } from "./swbauth";

interface ServiceRef {
  url: string;
  token: string;
  /** Pinned leaf-cert fingerprint (hex); absent for plain-HTTP services. */
  certFingerprint?: string;
}

/** How long `probeService` waits for the server before giving up. */
export const PROBE_TIMEOUT_MS = 5000;

/** Status + raw body from the native REST bridge (mirrors a `fetch` response). */
interface BridgeResponse {
  status: number;
  body: string;
  /** SHA-256 (hex) of the server's leaf cert, when TLS was used. */
  cert_fp?: string | null;
}

const EMPTY_BODY_HASH = sha256(new Uint8Array(0));

/**
 * Compute the SWB-v1 signing headers for a request. `path` is the exact
 * request target the server will see (`/api/...` including any query), which is
 * what the server signs via its `OriginalUri`.
 */
async function signHeaders(
  service: ServiceRef,
  method: string,
  path: string,
  bodyBytes: Uint8Array | null,
): Promise<Record<string, string>> {
  const bodyHash =
    bodyBytes === null ? await EMPTY_BODY_HASH : await sha256(bodyBytes);
  return restSignHeaders({
    token: service.token,
    method,
    pathAndQuery: path,
    bodyHash,
    cb: cbFromPin(service.certFingerprint),
  });
}

/** Invoke the native REST bridge with signed headers and the pinned cert. */
function bridge(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
  pin: string | undefined,
): Promise<BridgeResponse> {
  return invoke<BridgeResponse>("http_request", {
    method,
    url,
    headers: Object.entries(headers),
    body,
    pin: pin ?? null,
  });
}

/** Reject sentinel used to distinguish a timeout from other failures. */
const TIMEOUT = Symbol("timeout");

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(TIMEOUT), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Interpret a bridge response with the same rules as the fetch path: 401 is a
 * bad token, other non-2xx surfaces the server's `message`, 2xx is parsed JSON.
 */
function interpret<T>(res: BridgeResponse): T {
  if (res.status === 401) throw new Error("Invalid token.");
  if (res.status < 200 || res.status >= 300) {
    let message = `HTTP ${res.status}`;
    try {
      message = JSON.parse(res.body).message ?? message;
    } catch {
      // non-JSON body; keep the status text
    }
    throw new Error(message);
  }
  return JSON.parse(res.body) as T;
}

/**
 * Signed JSON request against a service, transparently using the Tauri native
 * bridge (cert-pinning) or `fetch` in the browser. Shared by every editor REST
 * call below so signing, query-building, and error handling live once.
 */
async function apiRequest<T>(
  service: ServiceRef,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const base = service.url.replace(/\/+$/, "");
  const url = `${base}${path}`;
  const payload = body === undefined ? null : JSON.stringify(body);
  const bodyBytes = payload === null ? null : new TextEncoder().encode(payload);
  const headers = await signHeaders(service, method, path, bodyBytes);
  if (isTauri) {
    const res = await bridge(method, url, headers, payload, service.certFingerprint);
    // 204 (e.g. a successful save) has no body for `interpret` to parse.
    if (res.status === 204) return undefined as T;
    return interpret<T>(res);
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(payload !== null ? { "Content-Type": "application/json" } : {}),
    },
    body: payload,
  });
  if (res.status === 401) throw new Error("Invalid token.");
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      message = (await res.json()).message ?? message;
    } catch {
      // non-JSON body; keep the status text
    }
    throw new Error(message);
  }
  // 204 (e.g. a successful save) has no body to parse.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** A probed service's info plus the leaf-cert fingerprint captured to pin it. */
export interface ProbeResult {
  info: ServiceInfo;
  /** SHA-256 (hex) of the server's leaf cert; absent for plain-HTTP services. */
  certFingerprint?: string;
}

/**
 * Verify a service is reachable and the token is accepted, returning its info
 * and (for HTTPS) the leaf-cert fingerprint to pin. A 401 means the token is
 * wrong; anything else non-2xx is a connection/server problem. Used to validate
 * a service before registering (or re-registering) it so a bad token fails
 * loudly instead of silently spinning in reconnect backoff.
 *
 * Trust-on-first-use: the fingerprint is learned from an *unauthenticated*
 * `/health` hit (the native bridge reports the leaf it saw), then used as the
 * channel binding to sign `/api/info` — proving the token without transmitting
 * it, bound to *this* cert. The caller persists the fingerprint; every later
 * connection enforces it.
 *
 * A non-responding host (e.g. a firewalled address that never refuses the
 * connection) would otherwise hang the dialog indefinitely, so each request is
 * aborted after `PROBE_TIMEOUT_MS` and reported as a timeout.
 */
export async function probeService(service: ServiceRef): Promise<ProbeResult> {
  const base = service.url.replace(/\/+$/, "");
  const timeoutErr = () =>
    new Error(`Server did not respond within ${PROBE_TIMEOUT_MS / 1000}s.`);

  if (isTauri) {
    // 1. Capture the leaf-cert fingerprint via unauthenticated `/health`.
    let health: BridgeResponse;
    try {
      health = await withTimeout(
        bridge("GET", `${base}/health`, {}, null, service.certFingerprint),
        PROBE_TIMEOUT_MS,
      );
    } catch (e) {
      if (e === TIMEOUT) throw timeoutErr();
      throw new Error("Could not reach the server — check the address.");
    }
    const fp = health.cert_fp ?? undefined; // absent on plain HTTP
    const probed: ServiceRef = { ...service, certFingerprint: fp };
    // 2. Signed `/api/info`, channel-bound to the just-captured fingerprint.
    let res: BridgeResponse;
    try {
      const headers = await signHeaders(probed, "GET", "/api/info", null);
      res = await withTimeout(
        bridge("GET", `${base}/api/info`, headers, null, fp),
        PROBE_TIMEOUT_MS,
      );
    } catch (e) {
      if (e === TIMEOUT) throw timeoutErr();
      throw new Error("Could not reach the server — check the address.");
    }
    return { info: interpret<ServiceInfo>(res), certFingerprint: fp };
  }

  // Browser: no cert pinning, so the channel binding is empty (cb = ∅).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let res: Response;
  try {
    const headers = await signHeaders(service, "GET", "/api/info", null);
    res = await fetch(`${base}/api/info`, {
      headers,
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) throw timeoutErr();
    throw new Error("Could not reach the server — check the address.");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new Error("Invalid token.");
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      message = (await res.json()).message ?? message;
    } catch {
      // non-JSON body; keep the status text
    }
    throw new Error(message);
  }
  return { info: (await res.json()) as ServiceInfo };
}

/** List a directory on the hosting machine (defaults to the server's home). */
export function listDir(
  service: ServiceRef,
  path?: string,
): Promise<FsListing> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return apiRequest<FsListing>(service, "GET", `/api/fs${qs}`);
}

/** Report whether a path exists on the hosting machine and if it's a directory. */
export function statPath(service: ServiceRef, path: string): Promise<FsStat> {
  return apiRequest<FsStat>(
    service,
    "GET",
    `/api/fs/stat?path=${encodeURIComponent(path)}`,
  );
}

/** Create a directory (and any missing parents) on the hosting machine. */
export function makeDir(service: ServiceRef, path: string): Promise<void> {
  return apiRequest<void>(service, "POST", `/api/fs/mkdir`, { path });
}

/** Create an empty file or a folder named `name` inside directory `dir`. */
export function createEntry(
  service: ServiceRef,
  dir: string,
  name: string,
  isDir: boolean,
): Promise<void> {
  return apiRequest<void>(service, "POST", `/api/fs/create`, {
    dir,
    name,
    is_dir: isDir,
  });
}

// --- workspace file editor --------------------------------------------------

/** Read a file's contents from the hosting machine. */
export function readFile(
  service: ServiceRef,
  path: string,
): Promise<FileContent> {
  return apiRequest<FileContent>(
    service,
    "GET",
    `/api/file?path=${encodeURIComponent(path)}`,
  );
}

/** Save a file's contents back to the hosting machine. */
export function writeFile(
  service: ServiceRef,
  path: string,
  content: string,
): Promise<void> {
  return apiRequest<void>(service, "PUT", `/api/file`, { path, content });
}

/** Rename a file/directory to a sibling `newName` in the same parent. */
export function renamePath(
  service: ServiceRef,
  path: string,
  newName: string,
): Promise<void> {
  return apiRequest<void>(service, "POST", `/api/fs/rename`, {
    path,
    new_name: newName,
  });
}

/** Delete a file, or a directory and its contents. */
export function deletePath(service: ServiceRef, path: string): Promise<void> {
  return apiRequest<void>(service, "POST", `/api/fs/delete`, { path });
}

/** Report git availability + repo state for a workspace folder. */
export function gitInfo(service: ServiceRef, cwd: string): Promise<GitInfo> {
  return apiRequest<GitInfo>(
    service,
    "GET",
    `/api/git/info?cwd=${encodeURIComponent(cwd)}`,
  );
}

/** List commits on the current branch of a workspace folder. */
export function gitLog(
  service: ServiceRef,
  cwd: string,
): Promise<GitCommit[]> {
  return apiRequest<GitCommit[]>(
    service,
    "GET",
    `/api/git/log?cwd=${encodeURIComponent(cwd)}`,
  );
}

/**
 * List files changed in `commit` (a hash, or `"WORKING"` for uncommitted
 * changes) within a workspace folder.
 */
export function gitChanges(
  service: ServiceRef,
  cwd: string,
  commit: string,
): Promise<GitChange[]> {
  return apiRequest<GitChange[]>(
    service,
    "GET",
    `/api/git/changes?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commit)}`,
  );
}

/**
 * Fetch both sides (old + new contents) of one file's diff, for the editor's
 * diff view. `commit` is a hash, or `"WORKING"` for uncommitted changes.
 */
export function gitFileDiff(
  service: ServiceRef,
  cwd: string,
  commit: string,
  path: string,
): Promise<GitFileDiff> {
  return apiRequest<GitFileDiff>(
    service,
    "GET",
    `/api/git/filediff?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commit)}&path=${encodeURIComponent(path)}`,
  );
}

/**
 * Create a git worktree for a workspace's repo at
 * `$HOME/.switchboard/worktree/<workspaceName>/<worktreeName>` on the host.
 * When `branch` is given, that existing branch is checked out; otherwise a new
 * branch named `worktreeName` is created.
 */
export function gitCreateWorktree(
  service: ServiceRef,
  cwd: string,
  workspaceName: string,
  worktreeName: string,
  branch?: string,
): Promise<GitWorktree> {
  return apiRequest<GitWorktree>(service, "POST", `/api/git/worktree`, {
    cwd,
    workspace_name: workspaceName,
    worktree_name: worktreeName,
    branch: branch && branch.trim() !== "" ? branch.trim() : null,
  });
}
