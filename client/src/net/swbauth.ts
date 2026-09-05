//! `SWB-v1` channel-bound auth, in the browser/webview via WebCrypto.
//!
//! This is the single client-side implementation of the HMAC proofs, shared by
//! the Tauri-bridge path and the browser-`fetch` path. It mirrors
//! `switchboard-shared::auth` (Rust) byte-for-byte — the `known_answer_vectors`
//! test on the Rust side pins the exact outputs so the two can never drift.
//!
//! The shared token is never transmitted: for REST we attach `x-swb-*` headers
//! (timestamp, nonce, MAC), and for the WebSocket we answer the server's
//! `AuthChallenge`. Every MAC also covers the channel binding `cb` (SHA-256 of
//! the server's pinned leaf cert), so a proof cannot be relayed onto a different
//! TLS channel.

export const WS_DOMAIN = "SWB-WS-v1";
export const REST_DOMAIN = "SWB-REST-v1";

export const H_TS = "x-swb-ts";
export const H_NONCE = "x-swb-nonce";
export const H_MAC = "x-swb-mac";

export const NONCE_LEN = 32;
export const REST_NONCE_LEN = 16;

const enc = new TextEncoder();

/** Lowercase hex encoding. */
export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Decode hex; empty string yields an empty array (used for an absent `cb`). */
export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

/** Channel-binding bytes for a service: its pinned leaf fingerprint, or empty. */
export function cbFromPin(fingerprint?: string): Uint8Array {
  return fingerprint ? fromHex(fingerprint) : new Uint8Array(0);
}

/** A cryptographically random nonce of `len` bytes. */
export function randomNonce(len: number): Uint8Array {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return b;
}

function u64be(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
}

function i64be(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(n), false);
  return b;
}

/** `domain ‖ Σ (u64_be(len(field)) ‖ field)` — the unambiguous MAC input. */
function feed(domain: Uint8Array, fields: Uint8Array[]): Uint8Array {
  const parts = [domain, ...fields];
  let len = 0;
  for (const p of parts) len += 8 + p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(u64be(p.length), o);
    o += 8;
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", k, data as BufferSource),
  );
}

/** SHA-256 digest. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", data as BufferSource),
  );
}

async function mac(
  key: Uint8Array,
  domain: string,
  fields: Uint8Array[],
): Promise<Uint8Array> {
  return hmac(key, feed(enc.encode(domain), fields));
}

/** WS handshake proof over the server + client nonces and channel binding. */
export async function wsMac(
  token: string,
  serverNonce: Uint8Array,
  clientNonce: Uint8Array,
  cb: Uint8Array,
): Promise<Uint8Array> {
  return mac(enc.encode(token), WS_DOMAIN, [serverNonce, clientNonce, cb]);
}

/**
 * Build the `x-swb-*` signing headers for one REST request. `bodyHash` is the
 * SHA-256 of the raw request body (of the empty body for bodyless requests).
 */
export async function restSignHeaders(opts: {
  token: string;
  method: string;
  pathAndQuery: string;
  bodyHash: Uint8Array;
  cb: Uint8Array;
  ts?: number;
  nonce?: Uint8Array;
}): Promise<Record<string, string>> {
  const ts = opts.ts ?? Date.now();
  const nonce = opts.nonce ?? randomNonce(REST_NONCE_LEN);
  const m = await mac(enc.encode(opts.token), REST_DOMAIN, [
    enc.encode(opts.method),
    enc.encode(opts.pathAndQuery),
    i64be(ts),
    nonce,
    opts.bodyHash,
    opts.cb,
  ]);
  return { [H_TS]: String(ts), [H_NONCE]: hex(nonce), [H_MAC]: hex(m) };
}
