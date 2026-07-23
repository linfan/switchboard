//! Base64 encoding for the tiny client->server binary frames (keystrokes,
//! resizes) sent over the Tauri IPC bridge, whose JSON args can't hold raw
//! bytes. The high-volume inbound path uses a raw-bytes Channel instead.

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
