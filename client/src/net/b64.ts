//! Base64 <-> bytes, for carrying binary WebSocket frames over the Tauri IPC
//! bridge (JSON event payloads can't hold raw bytes).

/** Encode bytes (any ArrayBuffer view or buffer) to a base64 string. */
export function bytesToBase64(data: ArrayBufferLike | ArrayBufferView): string {
  const bytes =
    data instanceof Uint8Array
      ? data
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBufferLike);
  let bin = "";
  const chunk = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Decode a base64 string to a fresh ArrayBuffer. */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
