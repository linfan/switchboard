import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_PREVIEW_BYTES,
  formatBytes,
  mediaForPath,
  previewBlobType,
} from "./media";

describe("mediaForPath", () => {
  it("classifies images, audio, and video", () => {
    expect(mediaForPath("/tmp/shot.png")).toEqual({
      kind: "image",
      ext: "png",
    });
    expect(mediaForPath("/tmp/take.mp3")).toEqual({
      kind: "audio",
      ext: "mp3",
    });
    expect(mediaForPath("/tmp/clip.mp4")).toEqual({
      kind: "video",
      ext: "mp4",
    });
    expect(mediaForPath("/a/logo.svg")).toEqual({
      kind: "image",
      ext: "svg",
    });
  });

  it("ignores case and leading directories", () => {
    expect(mediaForPath("/a/B.MOV")).toEqual({ kind: "video", ext: "mov" });
    expect(mediaForPath("C:\\media\\Shot.JPEG")).toEqual({
      kind: "image",
      ext: "jpeg",
    });
  });

  it("returns null for text, unknown, and undecodable formats", () => {
    expect(mediaForPath("/a/main.rs")).toBeNull();
    // Containers a webview can't decode aren't claimed as previewable.
    expect(mediaForPath("/a/movie.mkv")).toBeNull();
    expect(mediaForPath("/a/movie.avi")).toBeNull();
  });

  it("returns null without an extension", () => {
    expect(mediaForPath("/a/README")).toBeNull();
    expect(mediaForPath("/a/.gitignore")).toBeNull();
  });
});

describe("DEFAULT_MAX_PREVIEW_BYTES", () => {
  it("allows video to be the largest", () => {
    const caps = DEFAULT_MAX_PREVIEW_BYTES;
    expect(caps.image).toBeLessThan(caps.audio);
    expect(caps.audio).toBeLessThan(caps.video);
  });
});

describe("previewBlobType", () => {
  it("retypes SVG for the browser preview path", () => {
    expect(previewBlobType("svg")).toBe("image/svg+xml");
    // Raster images and A/V are sniffed from the octet-stream response.
    expect(previewBlobType("png")).toBeUndefined();
    expect(previewBlobType("mp4")).toBeUndefined();
  });
});

describe("formatBytes", () => {
  it("scales to the largest fitting unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(16 * 1024 * 1024)).toBe("16.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});
