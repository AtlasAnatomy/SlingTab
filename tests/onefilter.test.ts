import { describe, expect, it } from "vitest";
import { OneEuroFilter, OneEuroFilter2D, alpha } from "../src/shared/onefilter";

/**
 * The filter sits between the active box and the recogniser, so a defect here
 * either destroys the stroke (over-smoothing, the circle never closes) or does
 * nothing (under-smoothing, amplified jitter wrecks rStd/rMean). Both look like
 * "the gesture stopped working", so the properties are pinned rather than the
 * numbers.
 */

const HZ = 25;
const DT = 1 / HZ;

/** Deterministic pseudo-noise: a seeded LCG, so a failure is reproducible. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

const std = (xs: number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

describe("alpha", () => {
  it("rises with the cutoff and with the timestep", () => {
    expect(alpha(10, DT)).toBeGreaterThan(alpha(1, DT));
    expect(alpha(1, 0.2)).toBeGreaterThan(alpha(1, 0.01));
    expect(alpha(1, DT)).toBeGreaterThan(0);
    expect(alpha(1, DT)).toBeLessThan(1);
  });

  it("survives a zero timestep rather than dividing by it", () => {
    expect(Number.isFinite(alpha(1, 0))).toBe(true);
  });
});

describe("OneEuroFilter", () => {
  it("passes the first sample through untouched", () => {
    expect(new OneEuroFilter().filter(0.42, 0)).toBe(0.42);
  });

  it("converges onto a constant", () => {
    const f = new OneEuroFilter();
    f.filter(0, 0);
    let y = 0;
    for (let i = 1; i < 100; i++) y = f.filter(0.7, i * DT);
    expect(y).toBeCloseTo(0.7, 3);
  });

  it("attenuates jitter on a hand holding still", () => {
    const rnd = noise(7);
    const f = new OneEuroFilter();
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 200; i++) {
      const x = 0.5 + rnd() * 0.02;
      raw.push(x);
      out.push(f.filter(x, i * DT));
    }
    // Ignore the warm-up: the first sample is passed through by definition.
    expect(std(out.slice(20))).toBeLessThan(std(raw.slice(20)) * 0.5);
  });

  it("gets out of the way of a fast stroke", () => {
    // A hand crossing the screen in half a second. Lag has to stay small enough
    // that the fitted circle still matches where the hand actually was.
    const f = new OneEuroFilter();
    const speed = 2; // screens per second
    let y = 0;
    let x = 0;
    for (let i = 0; i < Math.round(0.5 / DT); i++) {
      x = i * DT * speed;
      y = f.filter(x, i * DT);
    }
    const lagSeconds = (x - y) / speed;
    expect(lagSeconds).toBeLessThan(0.08);
    expect(lagSeconds).toBeGreaterThanOrEqual(0);
  });

  it("lags less at speed than a fixed low-pass would", () => {
    // The whole reason for One Euro over a plain EMA: the adaptive cutoff must
    // actually adapt.
    const adaptive = new OneEuroFilter();
    const fixed = new OneEuroFilter({ minCutoff: 1.2, beta: 0 });
    let a = 0;
    let b = 0;
    let x = 0;
    for (let i = 0; i < 40; i++) {
      x = i * DT * 2;
      a = adaptive.filter(x, i * DT);
      b = fixed.filter(x, i * DT);
    }
    expect(x - a).toBeLessThan(x - b);
  });

  it("does not produce NaN on a repeated or backwards timestamp", () => {
    const f = new OneEuroFilter();
    f.filter(0.5, 1);
    expect(Number.isFinite(f.filter(0.6, 1))).toBe(true);
    expect(Number.isFinite(f.filter(0.7, 0.5))).toBe(true);
    expect(Number.isFinite(f.filter(0.8, 2))).toBe(true);
  });

  it("ignores a non-finite input instead of latching onto it", () => {
    const f = new OneEuroFilter();
    f.filter(0.5, 0);
    f.filter(NaN, DT);
    expect(Number.isFinite(f.filter(0.5, 2 * DT))).toBe(true);
  });

  it("forgets everything on reset", () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 50; i++) f.filter(0.2, i * DT);
    f.reset();
    expect(f.filter(0.9, 0)).toBe(0.9);
  });
});

describe("OneEuroFilter2D", () => {
  it("filters the axes independently", () => {
    const f = new OneEuroFilter2D();
    f.filter(0, 0, 0);
    let p = { x: 0, y: 0 };
    for (let i = 1; i < 60; i++) p = f.filter(1, 0, i * DT);
    expect(p.x).toBeCloseTo(1, 3);
    expect(p.y).toBeCloseTo(0, 6);
  });
});
