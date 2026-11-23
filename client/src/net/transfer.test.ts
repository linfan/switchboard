import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceRef } from "../store/types";
import { cbFromPin, fromHex, restSignHeaders, sha256 } from "./swbauth";
import {
  cancelTransfer,
  downloadArchive,
  downloadFiles,
  downloadFolderFiles,
  joinLocalPath,
  openPreview,
  uploadBinaryUpgrade,
  uploadFiles,
} from "./transfer";

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

async function expectMacTarget(
  init: RequestInit,
  service: ServiceRef,
  method: string,
  target: string,
  body: Uint8Array = new Uint8Array(0),
): Promise<void> {
  const headers = init.headers as Record<string, string>;
  const expected = await restSignHeaders({
    token: service.token,
    method,
    pathAndQuery: target,
    bodyHash: await sha256(body),
    cb: cbFromPin(service.certFingerprint),
    ts: Number(headers["x-swb-ts"]),
    nonce: fromHex(headers["x-swb-nonce"]),
  });
  expect(headers["x-swb-mac"]).toBe(expected["x-swb-mac"]);
}

function pickBrowserFile(file: File): void {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
    this: HTMLInputElement,
  ) {
    Object.defineProperty(this, "files", { value: [file] });
    this.dispatchEvent(new Event("change"));
  });
}

function browserFile(contents: string, name: string): File {
  const file = new File([contents], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(contents).buffer,
  });
  return file;
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
  vi.unstubAllGlobals();
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

  it("signs the exact tagged download target and keeps direct unchanged", async () => {
    mockFetch(() => streamed([1], 1));
    const tagged = { ...svc, tag: "worker-A" };

    await downloadFiles(tagged, ["/host/a.bin"]);
    await downloadFiles(svc, ["/host/a.bin"]);

    const calls = vi.mocked(fetch).mock.calls;
    const taggedTarget = "/api/fs/download?path=%2Fhost%2Fa.bin&tag=worker-A";
    expect(calls[0][0]).toBe(`http://host:8787${taggedTarget}`);
    await expectMacTarget(calls[0][1]!, tagged, "GET", taggedTarget);
    expect(calls[1][0]).toBe(
      "http://host:8787/api/fs/download?path=%2Fhost%2Fa.bin",
    );
    await expectMacTarget(
      calls[1][1]!,
      svc,
      "GET",
      "/api/fs/download?path=%2Fhost%2Fa.bin",
    );
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

describe("folder downloads", () => {
  /** A `FsListing` response for the tree walk. */
  function listing(
    path: string,
    entries: { name: string; path: string; is_dir: boolean }[],
  ): Response {
    return new Response(JSON.stringify({ path, parent: null, entries }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  interface TestDir {
    getDirectoryHandle(name: string): Promise<TestDir>;
    getFileHandle(name: string): Promise<{
      createWritable(): Promise<{
        write(blob: Blob): Promise<void>;
        close(): Promise<void>;
      }>;
    }>;
  }

  /** Stand in for the picker, recording every file written below `proj/`. */
  function mockDirPicker(written: { path: string; size: number }[]): void {
    const dir = (prefix: string): TestDir => ({
      getDirectoryHandle: async (name: string) => dir(`${prefix}${name}/`),
      getFileHandle: async (name: string) => ({
        createWritable: async () => ({
          write: async (blob: Blob) => {
            written.push({ path: `${prefix}${name}`, size: blob.size });
          },
          close: async () => {},
        }),
      }),
    });
    vi.stubGlobal(
      "showDirectoryPicker",
      vi.fn(async () => dir("")),
    );
  }

  it("downloads a folder as one signed zip", async () => {
    mockFetch(() => streamed([2], 2));
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    const tagged = { ...svc, tag: "worker-A" };

    await expect(downloadArchive(tagged, "/host/proj")).resolves.toMatchObject({
      done: ["proj.zip"],
      failed: [],
      cancelled: 0,
    });

    const target = "/api/fs/archive?path=%2Fhost%2Fproj&tag=worker-A";
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`http://host:8787${target}`);
    await expectMacTarget(init!, tagged, "GET", target);
    expect(saved).toEqual(["proj.zip"]);
  });

  it("recreates the folder structure for a browser folder download", async () => {
    mockFetch((url) => {
      const u = new URL(url);
      if (u.pathname === "/api/fs") {
        return u.searchParams.get("path") === "/host/proj"
          ? listing("/host/proj", [
              { name: "a.txt", path: "/host/proj/a.txt", is_dir: false },
              { name: "sub", path: "/host/proj/sub", is_dir: true },
            ])
          : listing("/host/proj/sub", [
              { name: "b.txt", path: "/host/proj/sub/b.txt", is_dir: false },
            ]);
      }
      return new Response(u.searchParams.get("path"));
    });
    const written: { path: string; size: number }[] = [];
    mockDirPicker(written);

    await expect(
      downloadFolderFiles(svc, "/host/proj", 10),
    ).resolves.toMatchObject({
      done: ["a.txt", "sub/b.txt"],
      failed: [],
      cancelled: 0,
    });
    expect(written.map((w) => w.path)).toEqual([
      "proj/a.txt",
      "proj/sub/b.txt",
    ]);
    expect(written.every((w) => w.size > 0)).toBe(true);
  });

  it("refuses a folder over the file cap with an archive hint", async () => {
    const written: { path: string; size: number }[] = [];
    mockDirPicker(written);
    mockFetch(() =>
      listing("/host/proj", [
        { name: "a.txt", path: "/host/proj/a.txt", is_dir: false },
        { name: "b.txt", path: "/host/proj/b.txt", is_dir: false },
      ]),
    );

    await expect(downloadFolderFiles(svc, "/host/proj", 1)).rejects.toThrow(
      /As archive/,
    );
    expect(written).toEqual([]);
  });

  it("explains the archive fallback when the browser can't pick folders", async () => {
    await expect(downloadFolderFiles(svc, "/host/proj", 10)).rejects.toThrow(
      /As archive/,
    );
  });

  it("treats a dismissed folder picker as a cancel", async () => {
    vi.stubGlobal(
      "showDirectoryPicker",
      vi.fn(async () => {
        throw new DOMException("dismissed", "AbortError");
      }),
    );

    await expect(
      downloadFolderFiles(svc, "/host/proj", 10),
    ).resolves.toMatchObject({ done: [], failed: [], cancelled: 1 });
  });
});

describe("tagged browser transfers", () => {
  it("uses the same tagged preview URL and MAC target", async () => {
    mockFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
    const tagged = { ...svc, tag: "worker-A" };
    const preview = await openPreview(tagged, "/host/image.png", "png", 7);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const target = "/api/fs/download?path=%2Fhost%2Fimage.png&tag=worker-A";
    expect(url).toBe(`http://host:8787${target}`);
    await expectMacTarget(init!, tagged, "GET", target);
    preview.release();
  });

  it("uses the same tagged browser upload URL and body MAC", async () => {
    mockFetch(() => new Response("", { status: 200 }));
    const file = browserFile("abc", "a.bin");
    pickBrowserFile(file);
    const tagged = { ...svc, tag: "worker-A" };

    await expect(uploadFiles(tagged, "/host dir", 5)).resolves.toMatchObject({
      done: ["a.bin"],
      failed: [],
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const target = "/api/fs/upload?dir=%2Fhost%20dir&name=a.bin&tag=worker-A";
    expect(url).toBe(`http://host:8787${target}`);
    await expectMacTarget(
      init!,
      tagged,
      "POST",
      target,
      new TextEncoder().encode("abc"),
    );
  });

  it("uses the same tagged browser upgrade upload URL and body MAC", async () => {
    mockFetch(() => new Response("", { status: 200 }));
    const file = browserFile("new-binary", "switchboard");
    pickBrowserFile(file);
    const tagged = { ...svc, tag: "worker-A" };

    await expect(uploadBinaryUpgrade(tagged)).resolves.toBe(true);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const target = "/api/admin/upgrade/upload?tag=worker-A";
    expect(url).toBe(`http://host:8787${target}`);
    await expectMacTarget(
      init!,
      tagged,
      "POST",
      target,
      new TextEncoder().encode("new-binary"),
    );
  });
});

describe("openPreview", () => {
  it("retypes an SVG blob so browsers render it", async () => {
    mockFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );

    const preview = await openPreview(svc, "/host/logo.svg", "svg", 7);

    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("image/svg+xml");
    preview.release();
  });

  it("leaves a raster preview's blob type as served", async () => {
    mockFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );

    const preview = await openPreview(svc, "/host/pic.png", "png", 7);

    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/octet-stream");
    preview.release();
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
