import { describe, expect, it } from "vitest";

import {
  cbFromPin,
  fromHex,
  hex,
  restSignHeaders,
  sha256,
  wsMac,
} from "./swbauth";

const enc = new TextEncoder();

describe("swbauth known-answer vectors", () => {
  // These MUST match `known_answer_vectors` in shared/src/auth.rs, so the JS and
  // Rust signers can never drift.
  it("reproduces the ws_mac vector", async () => {
    const m = await wsMac(
      "kat-token",
      new Uint8Array(32).fill(0x11),
      new Uint8Array(32).fill(0x22),
      enc.encode("kat-cb"),
    );
    expect(hex(m)).toBe(
      "fe078d368552867c359838f41602bfaa8f83787e36de22b7040a39effc6ff78f",
    );
  });

  it("reproduces the rest_mac vector", async () => {
    const bodyHash = await sha256(enc.encode('{"hello":"world"}'));
    const headers = await restSignHeaders({
      token: "kat-token",
      method: "POST",
      pathAndQuery: "/api/file?x=1",
      bodyHash,
      cb: enc.encode("kat-cb"),
      ts: 1_700_000_000_000,
      nonce: new Uint8Array(16).fill(0x33),
    });
    expect(headers["x-swb-mac"]).toBe(
      "b5f3a80f83747edddae69190dcc56a82f90d35f8cca9628efeae3c71409311e4",
    );
    expect(headers["x-swb-ts"]).toBe("1700000000000");
    expect(headers["x-swb-nonce"]).toBe("33".repeat(16));
  });
});

describe("hex helpers", () => {
  it("round-trips", () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xa5, 0xff, 0x10]);
    expect(hex(bytes)).toBe("000fa5ff10");
    expect(Array.from(fromHex("000fa5ff10"))).toEqual(Array.from(bytes));
  });

  it("treats an absent pin as empty channel binding", () => {
    expect(cbFromPin(undefined).length).toBe(0);
    expect(cbFromPin("").length).toBe(0);
    expect(Array.from(cbFromPin("00ff"))).toEqual([0, 255]);
  });
});
