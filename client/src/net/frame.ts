// Binary WebSocket data-plane frame codec — hand-mirror of `shared/src/frame.rs`.
// Must stay byte-for-byte compatible with the Rust codec (both round-trip tested).
//
// Layout (integers big-endian, task_id = the 16 raw bytes of the task UUID):
//   OUTPUT    [0x01][task_id:16][seq:u64][data...]   server -> client
//   SNAPSHOT  [0x02][task_id:16][seq:u64][data...]   server -> client
//   INPUT     [0x10][task_id:16][data...]            client -> server
//
// `seq` is a per-task chunk counter; it stays well below 2^53, so we carry it as
// a JS `number` (matching the control plane) and encode it as two 32-bit halves
// to avoid BigInt.
//
// INPUT has no seq: ordering is assumed, and on the wire that assumption holds.
// It does NOT hold across the desktop bridge, where each frame is a separate
// concurrent `fetch` and a separate spawned Tauri task — `tauriSocket.ts`
// serializes sends to keep this codec's contract true end to end.

export const KIND_OUTPUT = 0x01;
export const KIND_SNAPSHOT = 0x02;
export const KIND_INPUT = 0x10;

const UUID_LEN = 16;
const SEQ_LEN = 8;

export type Frame =
  | { kind: "output"; taskId: string; seq: number; data: Uint8Array }
  | { kind: "snapshot"; taskId: string; seq: number; data: Uint8Array }
  | { kind: "input"; taskId: string; data: Uint8Array };

export class FrameError extends Error {}

export function encode(frame: Frame): Uint8Array {
  if (frame.kind === "input") {
    const out = new Uint8Array(1 + UUID_LEN + frame.data.length);
    out[0] = KIND_INPUT;
    out.set(uuidToBytes(frame.taskId), 1);
    out.set(frame.data, 1 + UUID_LEN);
    return out;
  }
  const kind = frame.kind === "output" ? KIND_OUTPUT : KIND_SNAPSHOT;
  const header = 1 + UUID_LEN + SEQ_LEN;
  const out = new Uint8Array(header + frame.data.length);
  out[0] = kind;
  out.set(uuidToBytes(frame.taskId), 1);
  writeU64BE(out, 1 + UUID_LEN, frame.seq);
  out.set(frame.data, header);
  return out;
}

export function decode(bytes: Uint8Array): Frame {
  if (bytes.length < 1) throw new FrameError("empty frame");
  const kind = bytes[0];
  if (kind === KIND_OUTPUT || kind === KIND_SNAPSHOT) {
    if (bytes.length < 1 + UUID_LEN + SEQ_LEN) {
      throw new FrameError("frame shorter than its header");
    }
    const taskId = bytesToUuid(bytes.subarray(1, 1 + UUID_LEN));
    const seq = readU64BE(bytes, 1 + UUID_LEN);
    const data = bytes.slice(1 + UUID_LEN + SEQ_LEN);
    return { kind: kind === KIND_OUTPUT ? "output" : "snapshot", taskId, seq, data };
  }
  if (kind === KIND_INPUT) {
    if (bytes.length < 1 + UUID_LEN) {
      throw new FrameError("frame shorter than its header");
    }
    const taskId = bytesToUuid(bytes.subarray(1, 1 + UUID_LEN));
    const data = bytes.slice(1 + UUID_LEN);
    return { kind: "input", taskId, data };
  }
  throw new FrameError(`unknown frame kind 0x${kind.toString(16)}`);
}

/** Convenience: encode a keystroke INPUT frame. */
export function encodeInput(taskId: string, data: Uint8Array): Uint8Array {
  return encode({ kind: "input", taskId, data });
}

function writeU64BE(out: Uint8Array, offset: number, value: number): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(offset, Math.floor(value / 0x1_0000_0000), false);
  view.setUint32(offset + 4, value >>> 0, false);
}

function readU64BE(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hi = view.getUint32(offset, false);
  const lo = view.getUint32(offset + 4, false);
  return hi * 0x1_0000_0000 + lo;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new FrameError(`invalid uuid: ${uuid}`);
  const out = new Uint8Array(UUID_LEN);
  for (let i = 0; i < UUID_LEN; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}
