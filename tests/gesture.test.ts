import { describe, expect, it } from "vitest";
import {
  GestureBuffer,
  GESTURE_TUNING,
  explain,
  measure,
  recognize,
  recognizeCircle,
  trimLeadIn,
  unwrap,
  type GestureCheck,
  type Sample,
} from "../src/content/gesture";

const VIEWPORT = { width: 1440, height: 900 };
const TAU = Math.PI * 2;

/** Deterministic PRNG so "noisy" cases are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface ArcOptions {
  cx?: number;
  cy?: number;
  r?: number;
  from?: number;
  sweep?: number;
  n?: number;
  dtMs?: number;
  jitter?: number;
  seed?: number;
}

function arc(o: ArcOptions = {}): Sample[] {
  const {
    cx = 500,
    cy = 400,
    r = 120,
    from = 0,
    sweep = TAU,
    n = 40,
    dtMs = 12,
    jitter = 0,
    seed = 1,
  } = o;
  const rand = rng(seed);
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const a = from + (sweep * i) / (n - 1);
    const rr = r + (jitter ? (rand() * 2 - 1) * jitter : 0);
    out.push({
      x: cx + Math.cos(a) * rr,
      y: cy + Math.sin(a) * rr,
      t: 1000 + i * dtMs,
    });
  }
  return out;
}

describe("unwrap", () => {
  it("maps deltas into (-PI, PI]", () => {
    expect(unwrap(0)).toBeCloseTo(0);
    expect(unwrap(Math.PI)).toBeCloseTo(Math.PI);
    expect(unwrap(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 10);
    expect(unwrap(-Math.PI)).toBeCloseTo(Math.PI);
    expect(unwrap(TAU - 0.25)).toBeCloseTo(-0.25, 10);
    expect(unwrap(-TAU + 0.25)).toBeCloseTo(0.25, 10);
  });

  it("survives the branch cut in an accumulating sum", () => {
    // A full turn sampled across atan2's discontinuity must total ~2*PI.
    const m = measure(arc({ from: Math.PI * 0.9 }))!;
    expect(Math.abs(m.totalTurn)).toBeCloseTo(TAU, 1);
  });
});

describe("recognizeCircle — must fire", () => {
  it("perfect circle, clockwise (screen coords: increasing angle)", () => {
    const g = recognizeCircle(arc({ sweep: TAU }), VIEWPORT);
    expect(g).not.toBeNull();
    expect(g!.direction).toBe(1);
    // The centroid of a finite sample set is only approximately the true centre
    // (a closed stroke double-counts its start point). Within a few px is fine.
    expect(g!.centerX).toBeCloseTo(500, -1);
    expect(g!.centerY).toBeCloseTo(400, -1);
    expect(g!.radius).toBeCloseTo(120, 0);
  });

  it("perfect circle, counter-clockwise", () => {
    const g = recognizeCircle(arc({ sweep: -TAU }), VIEWPORT);
    expect(g).not.toBeNull();
    expect(g!.direction).toBe(-1);
    expect(g!.radius).toBeCloseTo(120, 0);
  });

  it("reports startAngle at the first sample", () => {
    const from = 1.1;
    const g = recognizeCircle(arc({ from }), VIEWPORT)!;
    expect(Math.abs(unwrap(g.startAngle - from))).toBeLessThan(0.05);
  });

  it("noisy hand-drawn circle", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const g = recognizeCircle(
        arc({ r: 110, jitter: 14, n: 46, seed, from: seed * 0.7 }),
        VIEWPORT,
      );
      expect(g, `seed ${seed}`).not.toBeNull();
    }
  });

  it("fires slightly before the loop closes (1.75*PI is enough)", () => {
    expect(recognizeCircle(arc({ sweep: TAU * 0.88 }), VIEWPORT)).not.toBeNull();
    expect(recognizeCircle(arc({ sweep: TAU * 0.82 }), VIEWPORT)).toBeNull();
  });
});

describe("recognizeCircle — must not fire", () => {
  it("half circle", () => {
    expect(recognizeCircle(arc({ sweep: Math.PI }), VIEWPORT)).toBeNull();
    expect(recognizeCircle(arc({ sweep: -Math.PI }), VIEWPORT)).toBeNull();
  });

  it("straight line", () => {
    const pts: Sample[] = [];
    for (let i = 0; i < 40; i++) {
      pts.push({ x: 200 + i * 12, y: 380, t: 1000 + i * 12 });
    }
    expect(recognizeCircle(pts, VIEWPORT)).toBeNull();
  });

  it("diagonal line", () => {
    const pts: Sample[] = [];
    for (let i = 0; i < 40; i++) {
      pts.push({ x: 200 + i * 10, y: 200 + i * 9, t: 1000 + i * 12 });
    }
    expect(recognizeCircle(pts, VIEWPORT)).toBeNull();
  });

  it("figure eight", () => {
    // Lemniscate: turning angle about the centroid cancels to ~0.
    const pts: Sample[] = [];
    const n = 80;
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / (n - 1);
      pts.push({
        x: 500 + 160 * Math.sin(a),
        y: 400 + 110 * Math.sin(a) * Math.cos(a),
        t: 1000 + i * 10,
      });
    }
    expect(recognizeCircle(pts, VIEWPORT)).toBeNull();
  });

  it("two stacked loops (figure eight drawn as circles)", () => {
    const pts = [
      ...arc({ cx: 500, cy: 300, r: 90, sweep: TAU, n: 40 }),
      ...arc({ cx: 500, cy: 480, r: 90, sweep: -TAU, n: 40, dtMs: 10 }).map(
        (p, i) => ({ ...p, t: 1500 + i * 10 }),
      ),
    ];
    expect(recognizeCircle(pts, VIEWPORT)).toBeNull();
  });

  it("scribble / lasso (radial variance too high)", () => {
    const rand = rng(99);
    const pts: Sample[] = [];
    for (let i = 0; i < 60; i++) {
      const a = (TAU * i) / 59;
      const r = 40 + rand() * 190;
      pts.push({
        x: 500 + Math.cos(a) * r,
        y: 400 + Math.sin(a) * r,
        t: 1000 + i * 10,
      });
    }
    expect(recognizeCircle(pts, VIEWPORT)).toBeNull();
  });

  it("circle too small", () => {
    expect(recognizeCircle(arc({ r: 18 }), VIEWPORT)).toBeNull();
  });

  it("circle too large for the viewport", () => {
    // 0.45 * min(1440, 900) = 405
    expect(recognizeCircle(arc({ r: 420 }), VIEWPORT)).toBeNull();
    expect(recognizeCircle(arc({ r: 380 }), VIEWPORT)).not.toBeNull();
  });

  it("too few points", () => {
    expect(recognizeCircle(arc({ n: GESTURE_TUNING.minPoints - 1 }), VIEWPORT)).toBeNull();
  });

  it("tiny fast circle below the path-length floor", () => {
    // r=45 clears minRadius but a 3/4 sweep is short and under-turned.
    expect(recognizeCircle(arc({ r: 45, sweep: TAU * 0.5, n: 14 }), VIEWPORT)).toBeNull();
  });
});

describe("lead-in tolerance", () => {
  /** Press on the target, swing out to the rim, then circle it. */
  function withLeadIn(o: ArcOptions = {}, leadPoints = 14): Sample[] {
    const circle = arc(o);
    const cx = o.cx ?? 500;
    const cy = o.cy ?? 400;
    const first = circle[0]!;
    const lead: Sample[] = [];
    for (let i = 0; i < leadPoints; i++) {
      const f = i / leadPoints;
      lead.push({
        x: cx + (first.x - cx) * f,
        y: cy + (first.y - cy) * f,
        t: first.t - (leadPoints - i) * 12,
      });
    }
    return [...lead, ...circle];
  }

  it("the raw recogniser rejects a circle with a lead-in", () => {
    // This is the failure the trim exists to fix: the run-out from the centre
    // blows up rStd/rMean and the scribble filter kills a perfectly good circle.
    expect(recognizeCircle(withLeadIn(), VIEWPORT)).toBeNull();
  });

  it("recognize() accepts it", () => {
    const g = recognize(withLeadIn(), VIEWPORT);
    expect(g).not.toBeNull();
    // Whatever lead-in survives the trim pulls the mean radius down a little.
    // Within 12% of the drawn circle is close enough that the disc looks right.
    expect(g!.radius).toBeGreaterThan(120 * 0.88);
    expect(g!.radius).toBeLessThan(120 * 1.12);
  });

  it("works for a noisy hand-drawn circle with a lead-in", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const pts = withLeadIn({ r: 105, jitter: 12, n: 44, seed, from: seed });
      expect(recognize(pts, VIEWPORT), `seed ${seed}`).not.toBeNull();
    }
  });

  it("trimLeadIn removes only the leading run inside the ring", () => {
    const pts = withLeadIn({}, 14);
    const trimmed = trimLeadIn(pts);
    expect(trimmed.length).toBeLessThan(pts.length);
    // Never eats into the circle itself, and never more than a third.
    expect(pts.length - trimmed.length).toBeLessThanOrEqual(14);
    expect(pts.length - trimmed.length).toBeLessThanOrEqual(Math.floor(pts.length / 3));
  });

  it("leaves a clean circle untouched", () => {
    const pts = arc();
    expect(trimLeadIn(pts)).toBe(pts);
  });

  it("still rejects everything that must not fire", () => {
    const line: Sample[] = [];
    for (let i = 0; i < 40; i++) line.push({ x: 200 + i * 12, y: 380, t: i * 12 });
    expect(recognize(line, VIEWPORT)).toBeNull();

    expect(recognize(arc({ sweep: Math.PI }), VIEWPORT)).toBeNull();

    const eight: Sample[] = [];
    for (let i = 0; i < 80; i++) {
      const a = (TAU * i) / 79;
      eight.push({
        x: 500 + 160 * Math.sin(a),
        y: 400 + 110 * Math.sin(a) * Math.cos(a),
        t: i * 10,
      });
    }
    expect(recognize(eight, VIEWPORT)).toBeNull();

    const stacked = [
      ...arc({ cx: 500, cy: 300, r: 90, sweep: TAU, n: 40 }),
      ...arc({ cx: 500, cy: 480, r: 90, sweep: -TAU, n: 40 }).map((p, i) => ({
        ...p,
        t: 1500 + i * 10,
      })),
    ];
    expect(recognize(stacked, VIEWPORT)).toBeNull();

    const rand = rng(7);
    const scribble: Sample[] = [];
    for (let i = 0; i < 60; i++) {
      const a = (TAU * i) / 59;
      const r = 40 + rand() * 190;
      scribble.push({
        x: 500 + Math.cos(a) * r,
        y: 400 + Math.sin(a) * r,
        t: i * 10,
      });
    }
    expect(recognize(scribble, VIEWPORT)).toBeNull();
  });
});

describe("explain", () => {
  it("names the criterion that failed", () => {
    const e = explain(arc({ sweep: Math.PI }), VIEWPORT);
    expect(e.fired).toBe(false);
    expect(e.checks["turn"]!.ok).toBe(false);
    // Note: a half circle turns ~4.25 rad about its *centroid*, not PI — the
    // centroid of an arc sits inside the arc, not at the circle's centre. The
    // margin to the 5.50 threshold is therefore smaller than it looks.
    expect(e.checks["turn"]!.value).toBeGreaterThan(Math.PI);
    expect(e.checks["turn"]!.value).toBeLessThan(GESTURE_TUNING.minTurn);

    const small = explain(arc({ r: 18 }), VIEWPORT);
    expect(small.checks["radiusMin"]!.ok).toBe(false);
  });

  it("reports every check passing on a good circle", () => {
    const e = explain(arc(), VIEWPORT);
    expect(e.fired).toBe(true);
    for (const [name, c] of Object.entries(e.checks) as [string, GestureCheck][]) {
      expect(c.ok, name).toBe(true);
    }
  });
});

describe("GestureBuffer", () => {
  it("drops samples older than the age window during a continuous stroke", () => {
    const b = new GestureBuffer();
    // 100ms apart never trips the 300ms idle reset, so this exercises maxAgeMs.
    for (let i = 0; i <= 20; i++) b.push({ x: i, y: i, t: i * 100 });
    expect(b.lastTime).toBe(2000);
    for (const s of b.samples) expect(s.t).toBeGreaterThanOrEqual(2000 - GESTURE_TUNING.maxAgeMs);
    expect(b.length).toBe(13); // t = 800..2000
  });

  it("a long pause discards the buffer rather than ageing it out", () => {
    const b = new GestureBuffer();
    b.push({ x: 0, y: 0, t: 0 });
    b.push({ x: 1, y: 1, t: 100 });
    b.push({ x: 2, y: 2, t: 200 });
    expect(b.length).toBe(3);
    b.push({ x: 3, y: 3, t: 1300 });
    expect(b.length).toBe(1);
    expect(b.samples[0]!.t).toBe(1300);
  });

  it("resets after an idle gap", () => {
    const b = new GestureBuffer();
    for (let i = 0; i < 20; i++) b.push({ x: i, y: i, t: i * 10 });
    expect(b.length).toBe(20);
    b.push({ x: 0, y: 0, t: 190 + GESTURE_TUNING.idleResetMs + 1 });
    expect(b.length).toBe(1);
  });

  it("caps at maxPoints", () => {
    const b = new GestureBuffer();
    for (let i = 0; i < 400; i++) b.push({ x: i, y: i, t: i * 2 });
    expect(b.length).toBeLessThanOrEqual(GESTURE_TUNING.maxPoints);
  });

  it("feed() fires mid-stroke on a circle drawn point by point", () => {
    const b = new GestureBuffer();
    const pts = arc({ n: 60, dtMs: 8 });
    let fired: number | null = null;
    for (let i = 0; i < pts.length; i++) {
      if (b.feed(pts[i]!, VIEWPORT)) {
        fired = i;
        break;
      }
    }
    expect(fired).not.toBeNull();
    // Should trigger before the stroke completes.
    expect(fired!).toBeLessThan(pts.length - 1);
  });

  it("feed() never fires while the user drags a straight line", () => {
    const b = new GestureBuffer();
    for (let i = 0; i < 200; i++) {
      expect(b.feed({ x: 100 + i * 5, y: 300, t: i * 6 }, VIEWPORT)).toBeNull();
    }
  });
});
