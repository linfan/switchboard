import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelTransfer, downloadFile } from "./transfer";

const svc = { url: "http://host:8787", token: "tok" };

/**
 * These cover the browser (non-Tauri) path — under vitest `isTauri` is false, so
 * transfers go through `fetch`. The Tauri path's progress/cancel plumbing lives in
 * Rust (`net.rs`) and is exercised by running the app.
 */
type FetchImpl = (url: string, init: RequestInit) => Response;

function mockFetch(impl: FetchImpl) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

/** A response whose body arrives as `chunks`, with the given `Content-Length`. */
function streamed(chunks: number[], total?: number, signal?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const n of chunks) c.enqueue(new Uint8Array(n));
      if (signal) {
        // The mock stands in for a real abort: an aborted request errors the body.
        signal.addEventListener("abort", () => c.error(new Error("aborted")));
      } else {
        c.close();
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: total === undefined ? {} : { "content-length": String(total) },
  });
}

beforeEach(() => {
  // jsdom implements neither; the anchor download path only needs them to exist.
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  // Clicking the save anchor would be a navigation, which jsdom refuses noisily.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadFile", () => {
  it("reports the file, then every chunk, up to the total", async () => {
    mockFetch(() => streamed([4, 6], 10));
    const started: { id: number; name: string; total?: number }[] = [];
    const ticks: [number, number | undefined][] = [];

    await expect(
      downloadFile(svc, "/host/big.bin", "big.bin", {
        onStart: (t) => started.push(t),
        onProgress: (_id, done, total) => ticks.push([done, total]),
      }),
    ).resolves.toBe(true);

    expect(started).toEqual([{ id: expect.any(Number), name: "big.bin" }]);
    // An opening 0% tick, then one per chunk, ending exactly on the total.
    expect(ticks).toEqual([
      [0, 10],
      [4, 10],
      [10, 10],
    ]);
  });

  it("still reports bytes moved when the response has no Content-Length", async () => {
    mockFetch(() => streamed([8], undefined));
    const ticks: [number, number | undefined][] = [];

    await expect(
      downloadFile(svc, "/host/big.bin", "big.bin", {
        onStart: () => {},
        onProgress: (_id, done, total) => ticks.push([done, total]),
      }),
    ).resolves.toBe(true);

    expect(ticks).toEqual([
      [0, undefined],
      [8, undefined],
    ]);
  });

  it("resolves false without throwing when cancelled mid-stream", async () => {
    mockFetch((_url, init) => streamed([4], 10, init.signal ?? undefined));
    let id = 0;

    await expect(
      downloadFile(svc, "/host/big.bin", "big.bin", {
        onStart: (t) => (id = t.id),
        // Cancel as soon as the transfer is under way.
        onProgress: () => cancelTransfer(id),
      }),
    ).resolves.toBe(false);
    // A cancelled download never reaches the save anchor.
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("propagates a server error", async () => {
    mockFetch(() => new Response(JSON.stringify({ message: "gone" }), { status: 404 }));
    await expect(
      downloadFile(svc, "/host/big.bin", "big.bin"),
    ).rejects.toThrow("gone");
  });
});
