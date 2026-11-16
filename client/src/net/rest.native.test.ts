import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceRef } from "../store/types";
import { listDir, probeService } from "./rest";
import { cbFromPin, fromHex, restSignHeaders, sha256 } from "./swbauth";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args?: Record<string, unknown> }[],
}));

vi.mock("./tauri", () => ({
  isTauri: true,
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args });
    if (String(args?.url).includes("/health")) {
      return { status: 200, body: "{}", cert_fp: "aabb" };
    }
    return {
      status: 200,
      body: JSON.stringify({ name: "Box", version: "1.0.0" }),
      cert_fp: "aabb",
    };
  },
}));

afterEach(() => {
  bridge.calls = [];
});

async function expectMac(
  args: Record<string, unknown>,
  service: ServiceRef,
  target: string,
  certFingerprint = service.certFingerprint,
): Promise<void> {
  const headers = Object.fromEntries(
    args.headers as [string, string][],
  ) as Record<string, string>;
  const expected = await restSignHeaders({
    token: service.token,
    method: "GET",
    pathAndQuery: target,
    bodyHash: await sha256(new Uint8Array(0)),
    cb: cbFromPin(certFingerprint),
    ts: Number(headers["x-swb-ts"]),
    nonce: fromHex(headers["x-swb-nonce"]),
  });
  expect(headers["x-swb-mac"]).toBe(expected["x-swb-mac"]);
}

describe("native probeService", () => {
  it("carries TAG through health and the signed info request", async () => {
    const service = { url: "https://host:8787", token: "tok", tag: "worker-A" };
    await expect(probeService(service)).resolves.toMatchObject({
      certFingerprint: "aabb",
    });

    expect(bridge.calls.map((call) => call.args?.url)).toEqual([
      "https://host:8787/health?tag=worker-A",
      "https://host:8787/api/info?tag=worker-A",
    ]);
    await expectMac(
      bridge.calls[1].args!,
      service,
      "/api/info?tag=worker-A",
      "aabb",
    );
  });

  it("preserves untagged direct health and info URLs", async () => {
    const service = { url: "http://host:8787", token: "tok" };
    await probeService(service);

    expect(bridge.calls.map((call) => call.args?.url)).toEqual([
      "http://host:8787/health",
      "http://host:8787/api/info",
    ]);
    await expectMac(bridge.calls[1].args!, service, "/api/info", "aabb");
  });

  it("uses one tagged target for ordinary native REST and its MAC", async () => {
    const service = { url: "https://host:8787", token: "tok", tag: "worker-A" };
    await listDir(service, "/tmp");

    const args = bridge.calls[0].args!;
    const target = "/api/fs?path=%2Ftmp&tag=worker-A";
    expect(args.url).toBe(`https://host:8787${target}`);
    await expectMac(args, service, target);
  });
});
