import { describe, expect, it } from "vitest";

import {
  decode,
  encode,
  encodeInput,
  Frame,
  FrameError,
  KIND_INPUT,
  KIND_OUTPUT,
  KIND_SNAPSHOT,
} from "./frame";

const TID = "11223344-5566-7788-99aa-bbccddeeff00";

// vitest's `toEqual` mis-reports equal Uint8Arrays ("no visual difference"), so
// compare fields explicitly with `data` normalized to a plain number array.
function expectSameFrame(got: Frame, want: Frame): void {
  expect(got.kind).toBe(want.kind);
  expect(got.taskId).toBe(want.taskId);
  if (want.kind !== "input" && got.kind !== "input") {
    expect(got.seq).toBe(want.seq);
  }
  expect(Array.from(got.data)).toEqual(Array.from(want.data));
}

function roundTrip(f: Frame): Frame {
  return decode(encode(f));
}

describe("binary frame codec", () => {
  it("round-trips OUTPUT with a large seq and ANSI data", () => {
    const data = new TextEncoder().encode("hello \x1b[31mred\x1b[0m");
    const f: Frame = { kind: "output", taskId: TID, seq: 0x0102030405, data };
    const bytes = encode(f);
    expect(bytes[0]).toBe(KIND_OUTPUT);
    expectSameFrame(roundTrip(f), f);
  });

  it("round-trips SNAPSHOT", () => {
    const data = new TextEncoder().encode("\x1b[2J\x1b[H$ ");
    const f: Frame = { kind: "snapshot", taskId: TID, seq: 42, data };
    expect(encode(f)[0]).toBe(KIND_SNAPSHOT);
    expectSameFrame(roundTrip(f), f);
  });

  it("round-trips INPUT (no seq)", () => {
    const data = new TextEncoder().encode("ls -la\r");
    const f: Frame = { kind: "input", taskId: TID, data };
    expect(encode(f)[0]).toBe(KIND_INPUT);
    expectSameFrame(roundTrip(f), f);
  });

  it("round-trips empty data", () => {
    for (const f of [
      { kind: "output", taskId: TID, seq: 1, data: new Uint8Array() } as Frame,
      { kind: "input", taskId: TID, data: new Uint8Array() } as Frame,
    ]) {
      expectSameFrame(roundTrip(f), f);
    }
  });

  it("encodes task_id as 16 raw big-endian UUID bytes", () => {
    const bytes = encodeInput(TID, new Uint8Array());
    expect(Array.from(bytes.subarray(1, 17))).toEqual([
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
      0xdd, 0xee, 0xff, 0x00,
    ]);
  });

  it("preserves seq bit-exactly across the 32-bit boundary", () => {
    const seq = 0xdeadbeef; // > 2^31, exercises the unsigned high bit of the low word
    const f: Frame = {
      kind: "output",
      taskId: TID,
      seq,
      data: new Uint8Array(),
    };
    expect((roundTrip(f) as { seq: number }).seq).toBe(seq);
  });

  it("rejects empty input", () => {
    expect(() => decode(new Uint8Array())).toThrow(FrameError);
  });

  it("rejects unknown kinds", () => {
    expect(() => decode(new Uint8Array([0xff]))).toThrow(FrameError);
  });

  it("rejects truncated headers", () => {
    expect(() => decode(new Uint8Array([KIND_OUTPUT, 0, 0, 0]))).toThrow(
      FrameError,
    );
    expect(() => decode(new Uint8Array([KIND_INPUT, 0, 0]))).toThrow(
      FrameError,
    );
  });
});
