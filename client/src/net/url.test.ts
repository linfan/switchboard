import { describe, expect, it } from "vitest";

import { stripImplicitHttps, withImplicitHttps } from "./url";

describe("withImplicitHttps", () => {
  it("prepends https when no scheme is given", () => {
    expect(withImplicitHttps("30.233.64.152:8787")).toBe(
      "https://30.233.64.152:8787",
    );
  });
  it("honors an explicit http:// (local/dev without TLS)", () => {
    expect(withImplicitHttps("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
  });
  it("leaves an explicit https:// untouched", () => {
    expect(withImplicitHttps("https://host:8787")).toBe("https://host:8787");
  });
  it("trims whitespace and maps blank to empty", () => {
    expect(withImplicitHttps("  host:8787  ")).toBe("https://host:8787");
    expect(withImplicitHttps("   ")).toBe("");
  });
});

describe("stripImplicitHttps", () => {
  it("hides the implicit https:// for display", () => {
    expect(stripImplicitHttps("https://30.233.64.152:8787")).toBe(
      "30.233.64.152:8787",
    );
  });
  it("keeps an explicit http:// visible", () => {
    expect(stripImplicitHttps("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
  });
  it("round-trips with withImplicitHttps", () => {
    for (const url of ["https://a:1", "http://b:2"]) {
      expect(withImplicitHttps(stripImplicitHttps(url))).toBe(url);
    }
  });
});
