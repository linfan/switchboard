import { describe, expect, it } from "vitest";

import { buildServiceUrl, DEFAULT_PORT, parseServiceUrl } from "./url";

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
