import { describe, expect, it } from "vitest";

import { formatBytes, MAX_PREVIEW_BYTES, mediaForPath } from "./media";

describe("mediaForPath", () => {
  it("classifies images, audio, and video", () => {
    expect(mediaForPath("/tmp/shot.png")).toEqual({ kind: "image", ext: "png" });
    expect(mediaForPath("/tmp/take.mp3")).toEqual({ kind: "audio", ext: "mp3" });
    expect(mediaForPath("/tmp/clip.mp4")).toEqual({ kind: "video", ext: "mp4" });
  });

  it("ignores case and leading directories", () => {
    expect(mediaForPath("/a/B.MOV")).toEqual({ kind: "video", ext: "mov" });
    expect(mediaForPath("C:\\media\\Shot.JPEG")).toEqual({
      kind: "image",
      ext: "jpeg",
    });
  });

  it("returns null for text, unknown, and undecodable formats", () => {
    // SVG is editable text, so it stays a CodeMirror tab.
    expect(mediaForPath("/a/logo.svg")).toBeNull();
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

describe("MAX_PREVIEW_BYTES", () => {
  it("allows video to be the largest", () => {
    expect(MAX_PREVIEW_BYTES.image).toBeLessThan(MAX_PREVIEW_BYTES.audio);
    expect(MAX_PREVIEW_BYTES.audio).toBeLessThan(MAX_PREVIEW_BYTES.video);
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
