import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceRef } from "../store/types";
import { cbFromPin, fromHex, restSignHeaders, sha256 } from "./swbauth";
import {
  downloadFiles,
  downloadFolderFiles,
  openPreview,
  uploadBinaryUpgrade,
  uploadFiles,
} from "./transfer";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args?: Record<string, unknown> }[],
  paths: ["/local/a.bin"] as string[],
  fileHash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
}));

vi.mock("./tauri", () => ({
  isTauri: true,
  assetUrl: async (path: string) => `asset://${path}`,
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args });
    switch (cmd) {
      case "hash_file":
        return bridge.fileHash;
      case "cache_media":
        return "/tmp/preview";
      case "download_file":
      case "upload_file":
        return true;
      case "http_request": {
        // Only the folder walk uses the JSON bridge; answer its listings.
        const path = new URL(String(args?.url)).searchParams.get("path");
        const entries =
          path === "/host/proj"
            ? [
                { name: "a.txt", path: "/host/proj/a.txt", is_dir: false },
                { name: "sub", path: "/host/proj/sub", is_dir: true },
              ]
            : [{ name: "b.txt", path: "/host/proj/sub/b.txt", is_dir: false }];
        return {
          status: 200,
          body: JSON.stringify({ path, parent: null, entries }),
        };
      }
      default:
        return undefined;
    }
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: async () => "/local/dest.bin",
  open: async (options: { multiple?: boolean }) =>
    options.multiple ? bridge.paths : (bridge.paths[0] ?? null),
}));

const svc = { url: "http://host:8787", token: "tok" };

afterEach(() => {
  bridge.calls = [];
  bridge.paths = ["/local/a.bin"];
});

function command(name: string, index = 0): Record<string, unknown> {
  return bridge.calls.filter((call) => call.cmd === name)[index].args!;
}

async function expectMacTarget(
  args: Record<string, unknown>,
  service: ServiceRef,
  method: string,
  target: string,
  bodyHash?: Uint8Array,
): Promise<void> {
  const headers = Object.fromEntries(
    args.headers as [string, string][],
  ) as Record<string, string>;
  const expected = await restSignHeaders({
    token: service.token,
    method,
    pathAndQuery: target,
    bodyHash: bodyHash ?? (await sha256(new Uint8Array(0))),
    cb: cbFromPin(service.certFingerprint),
    ts: Number(headers["x-swb-ts"]),
    nonce: fromHex(headers["x-swb-nonce"]),
  });
  expect(headers["x-swb-mac"]).toBe(expected["x-swb-mac"]);
}

describe("native tagged transfers", () => {
  it("signs tagged downloads and preserves direct URLs", async () => {
    const tagged = { ...svc, tag: "worker-A" };
    await downloadFiles(tagged, ["/host/a.bin"]);
    await downloadFiles(svc, ["/host/a.bin"]);

    const taggedTarget = "/api/fs/download?path=%2Fhost%2Fa.bin&tag=worker-A";
    expect(command("download_file", 0).url).toBe(
      `http://host:8787${taggedTarget}`,
    );
    await expectMacTarget(
      command("download_file", 0),
      tagged,
      "GET",
      taggedTarget,
    );
    expect(command("download_file", 1).url).toBe(
      "http://host:8787/api/fs/download?path=%2Fhost%2Fa.bin",
    );
  });

  it("tags preview requests and isolates A/B cache keys", async () => {
    const a = { ...svc, tag: "worker-A" };
    const b = { ...svc, tag: "worker-B" };
    await openPreview(a, "/host/image.png", "png", 7);
    await openPreview(b, "/host/image.png", "png", 7);

    const first = command("cache_media", 0);
    const second = command("cache_media", 1);
    expect(first.url).toBe(
      "http://host:8787/api/fs/download?path=%2Fhost%2Fimage.png&tag=worker-A",
    );
    expect(second.url).toBe(
      "http://host:8787/api/fs/download?path=%2Fhost%2Fimage.png&tag=worker-B",
    );
    expect(first.key).not.toBe(second.key);
    await expectMacTarget(
      first,
      a,
      "GET",
      "/api/fs/download?path=%2Fhost%2Fimage.png&tag=worker-A",
    );
  });

  it("uses the same tagged native upload URL and body MAC", async () => {
    const tagged = { ...svc, tag: "worker-A" };
    await expect(uploadFiles(tagged, "/host dir", 5)).resolves.toMatchObject({
      done: ["a.bin"],
      failed: [],
    });

    const args = command("upload_file");
    const target = "/api/fs/upload?dir=%2Fhost%20dir&name=a.bin&tag=worker-A";
    expect(args.url).toBe(`http://host:8787${target}`);
    await expectMacTarget(
      args,
      tagged,
      "POST",
      target,
      fromHex(bridge.fileHash),
    );
  });

  it("uses the same tagged native upgrade upload URL and body MAC", async () => {
    const tagged = { ...svc, tag: "worker-A" };
    bridge.paths = ["/local/switchboard"];
    await expect(uploadBinaryUpgrade(tagged)).resolves.toBe(true);

    const args = command("upload_file");
    const target = "/api/admin/upgrade/upload?tag=worker-A";
    expect(args.url).toBe(`http://host:8787${target}`);
    await expectMacTarget(
      args,
      tagged,
      "POST",
      target,
      fromHex(bridge.fileHash),
    );
  });

  it("writes a folder tree to nested local destinations", async () => {
    bridge.paths = ["/local"];

    await expect(
      downloadFolderFiles(svc, "/host/proj", 10),
    ).resolves.toMatchObject({
      done: ["a.txt", "sub/b.txt"],
      failed: [],
    });

    const dests = bridge.calls
      .filter((call) => call.cmd === "download_file")
      .map((call) => call.args!.dest);
    expect(dests).toEqual(["/local/proj/a.txt", "/local/proj/sub/b.txt"]);
  });
});
