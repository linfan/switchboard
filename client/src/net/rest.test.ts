import { afterEach, describe, expect, it, vi } from "vitest";

import { probeService } from "./rest";

const svc = { url: "http://host:8787", token: "tok" };

// WebCrypto (crypto.subtle) resolves on the libuv threadpool, so under fake
// timers it never settles via microtask flushing. Capture the real setTimeout
// before faking and yield to genuine macrotasks to let the request signing
// HMAC complete before we advance the fake clock.
const realSetTimeout = globalThis.setTimeout;
async function settleCrypto(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => realSetTimeout(r, 0));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("probeService", () => {
  it("returns the service info on success and signs without a bearer token", async () => {
    const info = { name: "Box", version: "1.0.0" };
    mockFetch(() => new Response(JSON.stringify(info), { status: 200 }));
    await expect(probeService(svc)).resolves.toEqual({ info });
    const [url, init] = (fetch as unknown as { mock: { calls: any[][] } }).mock
      .calls[0];
    expect(url).toBe("http://host:8787/api/info");
    // Token is proven via the SWB signature headers, never sent in the clear.
    expect(init.headers["x-swb-mac"]).toEqual(expect.any(String));
    expect(init.headers["x-swb-ts"]).toEqual(expect.any(String));
    expect(init.headers["x-swb-nonce"]).toEqual(expect.any(String));
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("strips a trailing slash from the base url", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    await probeService({ ...svc, url: "http://host:8787/" });
    const [url] = (fetch as unknown as { mock: { calls: any[][] } }).mock
      .calls[0];
    expect(url).toBe("http://host:8787/api/info");
  });

  it("reports a wrong token distinctly on 401", async () => {
    mockFetch(() => new Response("{}", { status: 401 }));
    await expect(probeService(svc)).rejects.toThrow("Invalid token.");
  });

  it("surfaces the server message on other non-2xx", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    );
    await expect(probeService(svc)).rejects.toThrow("boom");
  });

  it("reports an unreachable host when fetch throws", async () => {
    mockFetch(() => {
      throw new TypeError("network down");
    });
    await expect(probeService(svc)).rejects.toThrow(/reach the server/i);
  });

  it("times out when the server never responds", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that only settles when its abort signal fires — like a host
      // that accepts the socket but never answers.
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: { signal: AbortSignal }) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        ),
      );
      const p = probeService(svc);
      const assertion = expect(p).rejects.toThrow(/within 5s/i);
      // Let the WebCrypto request signing settle so `fetch` is actually called
      // and its abort listener registered before the abort timer fires.
      await settleCrypto();
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
