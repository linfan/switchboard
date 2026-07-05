//! Minimal authenticated REST calls to a hosting service. The WebSocket carries
//! the live sync plane; this is for request/response lookups like browsing the
//! host's filesystem for the working-directory picker.

import type { FsListing, ServiceInfo } from "../protocol";

interface ServiceRef {
  url: string;
  token: string;
}

/** How long `probeService` waits for the server before giving up. */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * Verify a service is reachable and the token is accepted, returning its info.
 * Hits the bearer-authed `/api/info`; a 401 means the token is wrong, anything
 * else non-2xx is a connection/server problem. Used to validate a service
 * before registering (or re-registering) it so a bad token fails loudly instead
 * of silently spinning in reconnect backoff.
 *
 * A non-responding host (e.g. a firewalled address that never refuses the
 * connection) would otherwise hang the dialog indefinitely, so the request is
 * aborted after `PROBE_TIMEOUT_MS` and reported as a timeout.
 */
export async function probeService(service: ServiceRef): Promise<ServiceInfo> {
  const base = service.url.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/api/info`, {
      headers: { Authorization: `Bearer ${service.token}` },
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new Error(
        `Server did not respond within ${PROBE_TIMEOUT_MS / 1000}s.`,
      );
    }
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
  return res.json() as Promise<ServiceInfo>;
}

/** List a directory on the hosting machine (defaults to the server's home). */
export async function listDir(
  service: ServiceRef,
  path?: string,
): Promise<FsListing> {
  const base = service.url.replace(/\/+$/, "");
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`${base}/api/fs${qs}`, {
    headers: { Authorization: `Bearer ${service.token}` },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).message ?? message;
    } catch {
      // non-JSON body; keep the status text
    }
    throw new Error(message);
  }
  return res.json() as Promise<FsListing>;
}
