import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceRef } from "../store/types";
import { listDir, probeService } from "./rest";
import { cbFromPin, fromHex, restSignHeaders, sha256 } from "./swbauth";

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

/** The calls the stubbed `fetch` received, as `[url, init]`. */
function fetchCalls(): [string, { headers: Record<string, string> }][] {
  const stub = fetch as unknown as {
    mock: { calls: [string, { headers: Record<string, string> }][] };
  };
  return stub.mock.calls;
}

async function expectMacTarget(
  init: { headers: Record<string, string> },
  service: ServiceRef,
  target: string,
): Promise<void> {
  const headers = init.headers;
  const expected = await restSignHeaders({
    token: service.token,
    method: "GET",
    pathAndQuery: target,
    bodyHash: await sha256(new Uint8Array(0)),
    cb: cbFromPin(service.certFingerprint),
    ts: Number(headers["x-swb-ts"]),
    nonce: fromHex(headers["x-swb-nonce"]),
  });
  expect(headers["x-swb-mac"]).toBe(expected["x-swb-mac"]);
}

describe("probeService", () => {
  it("returns the service info on success and signs without a bearer token", async () => {
    const info = { name: "Box", version: "1.0.0" };
    mockFetch(() => new Response(JSON.stringify(info), { status: 200 }));
    await expect(probeService(svc)).resolves.toEqual({ info });
    const [url, init] = fetchCalls()[0];
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
    const [url] = fetchCalls()[0];
    expect(url).toBe("http://host:8787/api/info");
  });

  it("uses one tagged target for the browser URL and MAC", async () => {
    const tagged = { ...svc, tag: "worker-A" };
    mockFetch(
      () =>
        new Response(JSON.stringify({ name: "Box", version: "1.0.0" }), {
          status: 200,
        }),
    );
    await probeService(tagged);

    expect(fetchCalls()).toHaveLength(1);
    const [url, init] = fetchCalls()[0];
    expect(url).toBe("http://host:8787/api/info?tag=worker-A");
    await expectMacTarget(init, tagged, "/api/info?tag=worker-A");
  });

  it("reports a wrong token distinctly on 401", async () => {
    mockFetch(() => new Response("{}", { status: 401 }));
    await expect(probeService(svc)).rejects.toThrow("Invalid token.");
  });

  it("surfaces the server message on other non-2xx", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
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

describe("apiRequest", () => {
  it("signs the exact tagged target used by ordinary REST calls", async () => {
    const tagged = { ...svc, tag: "worker-A" };
    mockFetch(() => new Response("{}", { status: 200 }));
    await listDir(tagged, "/tmp");

    const [url, init] = fetchCalls()[0];
    const target = "/api/fs?path=%2Ftmp&tag=worker-A";
    expect(url).toBe(`http://host:8787${target}`);
    await expectMacTarget(init, tagged, target);
  });

  it("preserves untagged direct REST targets", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    await listDir(svc);

    const [url, init] = fetchCalls()[0];
    expect(url).toBe("http://host:8787/api/fs");
    await expectMacTarget(init, svc, "/api/fs");
  });
});
