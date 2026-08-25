import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The attribution that has to ship INSIDE the package, not just in the repo.
 *
 * The root LICENSE names every third-party component correctly, and it is not
 * in `dist/` — nothing copies it there, and `dist/` is what gets zipped and
 * uploaded. Apache-2.0 §4 asks for the licence to travel with the thing it
 * covers, and the two fonts already manage it (their OFL text sits next to the
 * .ttf in `public/fonts/`); the MediaPipe runtime and model, which are 19 of
 * the package's 21 MB, did not.
 *
 * `public/` is copied verbatim into `dist/`, so a file here is a file in the
 * upload. This test is the guard that it stays one.
 */
const NOTICE = resolve(__dirname, "..", "public", "THIRD-PARTY.txt");

describe("third-party notice", () => {
  const text = readFileSync(NOTICE, "utf-8");

  it("names every redistributed component", () => {
    for (const file of [
      "vision_wasm_internal.wasm",
      "hand_landmarker.task",
      "AlumniSans-var.ttf",
      "AlbertSans-var.ttf",
    ]) {
      expect(text, file).toContain(file);
    }
  });

  it("carries the full Apache-2.0 text, not a link to it", () => {
    expect(text).toContain("Apache License");
    expect(text).toContain("Version 2.0, January 2004");
    expect(text).toContain("END OF TERMS AND CONDITIONS");
    // The grant itself, so a truncated copy cannot pass.
    expect(text).toContain("Redistribution. You may reproduce and distribute");
    expect(text).toContain("Copyright 2019-2024 The MediaPipe Authors");
  });

  it("points at the fonts' own OFL text rather than restating it", () => {
    expect(text).toContain("fonts/OFL-AlumniSans.txt");
    expect(text).toContain("fonts/OFL-AlbertSans.txt");
  });
});
