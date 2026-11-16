import { describe, expect, it } from "vitest";

import {
  buildServiceUrl,
  DEFAULT_PORT,
  isValidServiceTag,
  parseServiceUrl,
  withServiceTag,
} from "./url";

describe("buildServiceUrl", () => {
  it("combines protocol, host, and port", () => {
    expect(
      buildServiceUrl({ protocol: "https", host: "host", port: "8787" }),
    ).toBe("https://host:8787");
  });
  it("defaults the port when blank", () => {
    expect(
      buildServiceUrl({ protocol: "https", host: "10.0.0.5", port: "" }),
    ).toBe(`https://10.0.0.5:${DEFAULT_PORT}`);
  });
  it("supports http for a local server without TLS", () => {
    expect(
      buildServiceUrl({ protocol: "http", host: "localhost", port: "9000" }),
    ).toBe("http://localhost:9000");
  });
  it("trims whitespace in host and port", () => {
    expect(
      buildServiceUrl({ protocol: "https", host: "  host ", port: " 1234 " }),
    ).toBe("https://host:1234");
  });
});

describe("service tags", () => {
  it("accepts the Rust TAG rules including case and length boundaries", () => {
    for (const tag of ["a", "A", "0", "worker_A-1", "a".repeat(64)]) {
      expect(isValidServiceTag(tag)).toBe(true);
    }
    for (const tag of [
      "",
      " ",
      " a",
      "a ",
      "_a",
      "-a",
      "a.b",
      "a/b",
      "é",
      "a".repeat(65),
    ]) {
      expect(isValidServiceTag(tag)).toBe(false);
    }
  });

  it("appends exactly one TAG after a path or existing query", () => {
    expect(withServiceTag("/api/info", "worker-A")).toBe(
      "/api/info?tag=worker-A",
    );
    expect(withServiceTag("/api/fs?path=%2Fa", "worker-A")).toBe(
      "/api/fs?path=%2Fa&tag=worker-A",
    );
  });

  it("returns direct untagged targets byte-for-byte unchanged", () => {
    expect(withServiceTag("/api/fs?path=%2fa&x=", undefined)).toBe(
      "/api/fs?path=%2fa&x=",
    );
  });

  it("fails closed for empty or invalid TAGs", () => {
    for (const tag of ["", " ", "bad.tag", "a".repeat(65)]) {
      expect(() => withServiceTag("/api/info", tag)).toThrow(
        "Invalid service TAG.",
      );
    }
  });
});

describe("parseServiceUrl", () => {
  it("splits a full https url", () => {
    expect(parseServiceUrl("https://host:8787")).toEqual({
      protocol: "https",
      host: "host",
      port: "8787",
    });
  });
  it("recognizes http", () => {
    expect(parseServiceUrl("http://127.0.0.1:9000")).toEqual({
      protocol: "http",
      host: "127.0.0.1",
      port: "9000",
    });
  });
  it("leaves the port blank when the url has none", () => {
    expect(parseServiceUrl("https://host")).toEqual({
      protocol: "https",
      host: "host",
      port: "",
    });
  });
  it("round-trips with buildServiceUrl", () => {
    const u = "https://192.0.2.5:8787";
    expect(buildServiceUrl(parseServiceUrl(u))).toBe(u);
  });
  it("falls back to defaults for an unparseable url", () => {
    expect(parseServiceUrl("not a url")).toEqual({
      protocol: "https",
      host: "",
      port: "",
    });
  });
});
