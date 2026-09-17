import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelTransfer, downloadFiles, joinLocalPath } from "./transfer";

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
function streamed(
  chunks: number[],
  total?: number,
  signal?: AbortSignal,
): Response {
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

describe("downloadFiles", () => {
  it("reports the file, then every chunk, up to the total", async () => {
    mockFetch(() => streamed([4, 6], 10));
    const started: { id: number; name: string; total?: number }[] = [];
    const ticks: [number, number | undefined][] = [];

    await expect(
      downloadFiles(svc, ["/host/big.bin"], {
        onStart: (t) => started.push(t),
        onProgress: (_id, done, total) => ticks.push([done, total]),
      }),
    ).resolves.toMatchObject({ done: ["big.bin"], failed: [], cancelled: 0 });

    expect(started).toEqual([
      { id: expect.any(Number), name: "big.bin", total: undefined },
    ]);
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
      downloadFiles(svc, ["/host/big.bin"], {
        onStart: () => {},
        onProgress: (_id, done, total) => ticks.push([done, total]),
      }),
    ).resolves.toMatchObject({ done: ["big.bin"] });

    expect(ticks).toEqual([
      [0, undefined],
      [8, undefined],
    ]);
  });

  it("counts a mid-stream cancel without calling it a failure", async () => {
    mockFetch((_url, init) => streamed([4], 10, init.signal ?? undefined));
    let id = 0;

    await expect(
      downloadFiles(svc, ["/host/big.bin"], {
        onStart: (t) => (id = t.id),
        // Cancel as soon as the transfer is under way.
        onProgress: () => cancelTransfer(id),
      }),
    ).resolves.toMatchObject({ done: [], failed: [], cancelled: 1 });
    // A cancelled download never reaches the save anchor.
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("sends one request per file, in order, saving each under its own name", async () => {
    const urls: string[] = [];
    const saved: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return streamed([2], 2);
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    const started: number[] = [];

    const outcome = await downloadFiles(
      svc,
      ["/host/a.bin", "/host/b.bin", "/host/c.bin"],
      { onStart: (t) => started.push(t.id), onProgress: () => {} },
    );

    // Sequential, so the host never sees a burst of signed requests at once.
    expect(urls.map((u) => new URL(u).searchParams.get("path"))).toEqual([
      "/host/a.bin",
      "/host/b.bin",
      "/host/c.bin",
    ]);
    expect(new Set(started).size).toBe(3);
    expect(saved).toEqual(["a.bin", "b.bin", "c.bin"]);
    expect(outcome.done).toEqual(["a.bin", "b.bin", "c.bin"]);
  });

  it("keeps going past a file the host rejects", async () => {
    const urls: string[] = [];
    const started: number[] = [];
    const ended: number[] = [];
    mockFetch((url) => {
      urls.push(url);
      return url.includes("b.bin")
        ? new Response(JSON.stringify({ message: "gone" }), { status: 404 })
        : streamed([2], 2);
    });

    const outcome = await downloadFiles(
      svc,
      ["/host/a.bin", "/host/b.bin", "/host/c.bin"],
      {
        onStart: (t) => started.push(t.id),
        onProgress: () => {},
        onEnd: (id) => ended.push(id),
      },
    );

    expect(outcome.done).toEqual(["a.bin", "c.bin"]);
    expect(outcome.failed).toEqual([{ name: "b.bin", message: "gone" }]);
    expect(urls).toHaveLength(3);
    // A failing file closes its own row too — it doesn't sit there showing stale
    // progress until the rest of the batch finishes.
    expect(ended).toEqual(started);
  });

  it("requests nothing for an empty selection", async () => {
    mockFetch(() => streamed([1], 1));
    await expect(downloadFiles(svc, [])).resolves.toMatchObject({
      done: [],
      failed: [],
      cancelled: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("joinLocalPath", () => {
  it("joins with the separator the folder was spelled with", () => {
    expect(joinLocalPath("/Users/me/Downloads", "a.bin")).toBe(
      "/Users/me/Downloads/a.bin",
    );
    expect(joinLocalPath("/tmp/x/", "a.bin")).toBe("/tmp/x/a.bin");
    expect(joinLocalPath(String.raw`C:\Users\me`, "a.bin")).toBe(
      String.raw`C:\Users\me\a.bin`,
    );
  });
});
