import { describe, expect, it } from "vitest";
import {
  HAND_MAP,
  activeBox,
  boxRect,
  edgeClamp,
  mapToViewport,
  unmapFromViewport,
} from "../src/shared/handmap";

/**
 * The active box is the whole of the "hand detection covers the screen" fix, and
 * both of the defects it repairs are silent — a hand that cannot reach the
 * corners still tracks fine, and an elliptical circle still fires. Nothing
 * downstream would notice a regression here, so it is pinned.
 */

const FRAME_43 = 4 / 3;
const VIEW_169 = 16 / 9;

/** Physical aspect ratio of the box, in real frame pixels rather than fractions. */
const physicalAspect = (box: { w: number; h: number }, frameAspect: number) =>
  (box.w * frameAspect) / box.h;

describe("activeBox", () => {
  it("matches the viewport's aspect ratio physically, not in fractions", () => {
    const box = activeBox(VIEW_169, FRAME_43);
    expect(physicalAspect(box, FRAME_43)).toBeCloseTo(VIEW_169, 6);
    // Fraction-wise it is NOT 16:9 — that is the point. A box that looked 16:9
    // in normalised coordinates would be the bug this replaces.
    expect(box.w / box.h).toBeCloseTo(VIEW_169 / FRAME_43, 6);
  });

  it("is small enough that the reachable part of the frame covers the screen", () => {
    const box = activeBox(VIEW_169, FRAME_43);
    expect(box.w).toBeCloseTo(HAND_MAP.coverage, 6);
    // A hand comfortably covers this much of the picture; the old 1:1 map
    // required all of it. Stated as a margin rather than a fixed number so
    // retuning `coverage` does not mean rewriting the test.
    expect(box.w).toBeLessThan(1);
    expect(box.h).toBeLessThan(box.w);
    expect(box.h).toBeGreaterThan(HAND_MAP.minSpan);
  });

  it("holds the aspect for portrait and square viewports too", () => {
    for (const va of [9 / 16, 1, 4 / 3, 21 / 9]) {
      const box = activeBox(va, FRAME_43);
      expect(physicalAspect(box, FRAME_43)).toBeCloseTo(va, 6);
    }
  });

  it("never exceeds the frame, whatever it is asked for", () => {
    for (const [va, fa] of [[9 / 16, 4 / 3], [1, 1], [32 / 9, 16 / 9], [1 / 4, 4 / 3]]) {
      const box = activeBox(va!, fa!, 1.5);
      expect(box.w).toBeLessThanOrEqual(1);
      expect(box.h).toBeLessThanOrEqual(1);
      expect(box.w).toBeGreaterThanOrEqual(HAND_MAP.minSpan);
      expect(box.h).toBeGreaterThanOrEqual(HAND_MAP.minSpan);
    }
  });

  it("falls back to sane defaults rather than producing NaN", () => {
    // A <video> measured before metadata arrives reports 0x0, and a NaN box
    // would poison every sample fed to the recogniser from then on.
    for (const box of [activeBox(0, 0), activeBox(NaN, FRAME_43), activeBox(VIEW_169, NaN)]) {
      expect(Number.isFinite(box.w)).toBe(true);
      expect(Number.isFinite(box.h)).toBe(true);
      expect(box.w).toBeGreaterThan(0);
      expect(box.h).toBeGreaterThan(0);
    }
  });
});

describe("mapToViewport", () => {
  const box = activeBox(VIEW_169, FRAME_43);

  it("puts the centre of the frame at the centre of the screen", () => {
    const p = mapToViewport(0.5, 0.5, box);
    expect(p.x).toBeCloseTo(0.5, 6);
    expect(p.y).toBeCloseTo(0.5, 6);
  });

  it("makes every corner of the screen reachable from inside the box", () => {
    const r = boxRect(box);
    const tl = mapToViewport(r.x, r.y, box);
    const br = mapToViewport(r.x + r.w, r.y + r.h, box);
    expect(tl.x).toBeCloseTo(0, 6);
    expect(tl.y).toBeCloseTo(0, 6);
    expect(br.x).toBeCloseTo(1, 6);
    expect(br.y).toBeCloseTo(1, 6);
  });

  it("saturates outside the box instead of overshooting", () => {
    for (const [x, y] of [[0, 0], [1, 1], [-3, 4]]) {
      const p = mapToViewport(x!, y!, box);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it("amplifies, which is the entire point", () => {
    // Half the box width of hand movement must cross half the screen.
    const a = mapToViewport(0.5 - box.w / 4, 0.5, box);
    const b = mapToViewport(0.5 + box.w / 4, 0.5, box);
    expect(b.x - a.x).toBeCloseTo(0.5, 6);
    expect(box.w / 2).toBeLessThan(0.5);
  });

  it("turns a circle in the air into a circle on screen", () => {
    // A physically round gesture, expressed in frame fractions: the x radius is
    // divided by the frame's width and the y radius by its height, so in
    // normalised coordinates it is already an ellipse.
    const rPhysical = 0.18; // fraction of the frame HEIGHT
    const vw = 1920;
    const vh = 1080;
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const fx = 0.5 + (Math.cos(a) * rPhysical) / FRAME_43;
      const fy = 0.5 + Math.sin(a) * rPhysical;
      const m = mapToViewport(fx, fy, box);
      pts.push({ x: m.x * vw, y: m.y * vh });
    }
    const radii = pts.map((p) => Math.hypot(p.x - vw / 2, p.y - vh / 2));
    const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
    const std = Math.sqrt(
      radii.reduce((s, r) => s + (r - mean) ** 2, 0) / radii.length,
    );
    // The recogniser rejects at rStd/rMean >= 0.30; a true circle should be
    // orders of magnitude inside that, not merely passing.
    expect(std / mean).toBeLessThan(0.01);
  });

  it("round-trips through unmapFromViewport", () => {
    const r = boxRect(box);
    for (const [x, y] of [[0.5, 0.5], [r.x + 0.01, r.y + 0.01], [0.6, 0.42]]) {
      const m = mapToViewport(x!, y!, box);
      const back = unmapFromViewport(m.x, m.y, box);
      expect(back.x).toBeCloseTo(x!, 6);
      expect(back.y).toBeCloseTo(y!, 6);
    }
  });
});

describe("edgeClamp", () => {
  it("lets the centre get close to the edge", () => {
    // The old padding was 0.6 * radius, which on a 200px disc pushed the centre
    // 120px in from every edge and made corner links unreachable.
    expect(edgeClamp(0, 200, 1920)).toBeLessThanOrEqual(200 * 0.6);
    expect(edgeClamp(0, 200, 1920)).toBeCloseTo(200 * HAND_MAP.edgePad, 6);
    expect(edgeClamp(1920, 200, 1920)).toBeCloseTo(1920 - 200 * HAND_MAP.edgePad, 6);
  });

  it("leaves an interior point alone", () => {
    expect(edgeClamp(960, 200, 1920)).toBe(960);
  });

  it("cannot invert its own bounds on a disc larger than the viewport", () => {
    const v = edgeClamp(10, 5000, 400);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(400);
  });
});
