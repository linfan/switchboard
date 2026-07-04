//! Minimal authenticated REST calls to a hosting service. The WebSocket carries
//! the live sync plane; this is for request/response lookups like browsing the
//! host's filesystem for the working-directory picker.

import type { FsListing } from "../protocol";

interface ServiceRef {
  url: string;
  token: string;
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
