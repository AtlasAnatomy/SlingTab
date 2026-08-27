import { describe, expect, it } from "vitest";
import {
  GESTURE_TUNING,
  GestureBuffer,
  HAND_WINDOW,
  MOUSE_WINDOW,
  measure,
  type Sample,
} from "../src/content/gesture";

/**
 * Recognition when the buffer holds more than the circle.
 *
 * Lengthening the hand's buffer from 1200 ms to 3000 ms — so a circle drawn in
 * the air has time to close — had a consequence that was not obvious: the old
 * length was also a noise filter. At 1200 ms the buffer WAS the circle, because
 * anything older had already aged out. At 3000 ms it also holds the second or
 * two of hovering and drifting before the user began to draw, and measured as
 * one shape that is not a circle at all. Every good circle with any lead-in
 * stopped being recognised.
 *
 * `trimLeadIn` could not reach it: it removes at most a third of the buffer and
 * only points INSIDE the ring, while a hand waiting to start is usually outside
 * it. So `recognize` now also asks of progressively shorter tails — a circle is
 * always the newest contiguous run of samples.
 */

const VIEWPORT = { width: 1280, height: 720 };
const CX = 640;
const CY = 360;
const R = 120;
const STEP = 40; // 25 Hz, the tracker's interval

function handStroke(leadInFrames: number, turns = 1.85, circleFrames = 30): Sample[] {
  const out: Sample[] = [];
  let t = 1000;
  // The hand is visible and the pose is held well before the circle starts.
  for (let i = 0; i < leadInFrames; i++) {
    const k = i / Math.max(1, leadInFrames);
    out.push({
      x: CX - 210 + 70 * k + 18 * Math.sin(i * 0.7),
      y: CY + 190 - 60 * k + 18 * Math.cos(i * 0.5),
      t,
    });
    t += STEP;
  }
  for (let i = 0; i < circleFrames; i++) {
    const a = (i / (circleFrames - 1)) * turns * Math.PI * 2;
    out.push({
      x: CX + Math.cos(a) * R + 4 * Math.sin(i * 1.3),
      y: CY + Math.sin(a) * R + 4 * Math.cos(i * 1.1),
      t,
    });
    t += STEP;
  }
  return out;
}

const fires = (stroke: Sample[], window = HAND_WINDOW): boolean => {
  const b = new GestureBuffer(window);
  for (const s of stroke) if (b.feed(s, VIEWPORT)) return true;
  return false;
};

const build = (n: number, f: (i: number) => { x: number; y: number }): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ ...f(i), t: 1000 + i * STEP }));

/** Deterministic, so a failure is always reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("a hand circle preceded by a lead-in", () => {
  for (const leadIn of [0, 10, 20, 30, 45, 60]) {
    it(`fires with ${leadIn} lead-in frames (${(leadIn * STEP) / 1000}s of hovering)`, () => {
      expect(fires(handStroke(leadIn))).toBe(true);
    });
  }

  it("fires on the mouse window too, which never regressed", () => {
    expect(fires(handStroke(20), MOUSE_WINDOW)).toBe(true);
  });
});

describe("the tail scan must not invent circles", () => {
  it("a hand held still", () => {
    const r = rng(1);
    expect(fires(build(75, () => ({ x: CX + r() * 6, y: CY + r() * 6 })))).toBe(false);
  });

  it("a random walk", () => {
    const r = rng(2);
    let x = CX;
    let y = CY;
    expect(
      fires(
        build(75, () => {
          x += (r() - 0.5) * 40;
          y += (r() - 0.5) * 40;
          return { x, y };
        }),
      ),
    ).toBe(false);
  });

  it("a straight sweep across the screen", () => {
    expect(fires(build(75, (i) => ({ x: 100 + i * 14, y: CY })))).toBe(false);
  });

  it("a back-and-forth wave", () => {
    expect(fires(build(75, (i) => ({ x: CX + Math.sin(i * 0.4) * 220, y: CY + i })))).toBe(
      false,
    );
  });

  /**
   * The case that made the angular-step rule necessary. Points alternating
   * either side of the centroid jump close to 180 degrees each time, which
   * accumulates as apparent rotation while the radii stay uniform enough to
   * pass the roundness test. Before the rule, a tail of this fired.
   */
  it("a zigzag scribble", () => {
    expect(
      fires(build(75, (i) => ({ x: 500 + i * 4, y: CY + (i % 2 ? 90 : -90) }))),
    ).toBe(false);
  });

  it("half a circle, twice, in opposite directions", () => {
    expect(
      fires(
        build(75, (i) => {
          const half = i < 37 ? i / 36 : (74 - i) / 36;
          const a = half * Math.PI;
          return { x: CX + Math.cos(a) * 140, y: CY + Math.sin(a) * 140 };
        }),
      ),
    ).toBe(false);
  });

  it("a circle far too small to mean anything", () => {
    expect(
      fires(
        build(75, (i) => {
          const a = (i / 74) * Math.PI * 4;
          return { x: CX + Math.cos(a) * 18, y: CY + Math.sin(a) * 18 };
        }),
      ),
    ).toBe(false);
  });

});

/**
 * A run-in, a clean loop, and a run-out.
 *
 * This one DOES fire, and that is the tail scan working rather than failing.
 * It was written as a rejection case on the assumption that a lasso is a
 * scribble, but the shape contains a real closed circle and the recogniser
 * finds it — with a centre and radius that match the drawn loop almost exactly,
 * which is what a portal needs to land in the right place.
 *
 * Worth knowing, because it is a genuine behaviour change: before the tail scan
 * this was rejected, since `trimLeadIn` cannot remove a lead-in that sits
 * OUTSIDE the ring. A stroke that wanders in, circles something, and wanders
 * out now counts.
 */
describe("a circle with a run-in and a run-out", () => {
  const lasso = build(75, (i) => {
    if (i < 25) return { x: 300 + i * 9, y: 500 - i * 4 };
    const a = ((i - 25) / 30) * Math.PI * 2;
    if (i < 55) return { x: 560 + Math.cos(a) * 60, y: 380 + Math.sin(a) * 60 };
    return { x: 620 + (i - 55) * 9, y: 380 + (i - 55) * 5 };
  });

  it("is recognised, on the loop it actually contains", () => {
    const b = new GestureBuffer(HAND_WINDOW);
    let hit = null;
    for (const s of lasso) {
      hit = b.feed(s, VIEWPORT);
      if (hit) break;
    }
    expect(hit).not.toBeNull();
    // The drawn loop is centred (560, 380) with radius 60. The accepted tail
    // carries a few frames of the run-out, which pulls the centroid about 6 px
    // — a tenth of the radius, and well inside the disc either way.
    expect(Math.abs(hit!.centerX - 560)).toBeLessThan(12);
    expect(Math.abs(hit!.centerY - 380)).toBeLessThan(12);
    expect(Math.abs(hit!.radius - 60)).toBeLessThan(12);
  });
});

describe("angular step", () => {
  it("a real stroke stays far below the ceiling", () => {
    const m = measure(handStroke(0).slice(-30))!;
    // 1.85 turns over 30 frames is ~22 degrees a frame.
    expect(m.maxStepTurn).toBeLessThan(GESTURE_TUNING.maxStepTurn / 2);
  });

  it("alternating points either side of the centroid do not", () => {
    const m = measure(build(20, (i) => ({ x: 600 + i * 4, y: CY + (i % 2 ? 90 : -90) })))!;
    expect(m.maxStepTurn).toBeGreaterThan(GESTURE_TUNING.maxStepTurn);
  });
});
