import { describe, expect, it } from "vitest";
import {
  fingersExtended,
  poseSatisfied,
  type Landmark,
} from "../src/shared/handtrack";
import { GestureBuffer, preview, type Sample } from "../src/content/gesture";

/**
 * The gate for the hand trigger: index and middle raised, ring and pinky folded,
 * thumb wherever it likes. Only while that pose is held do samples reach the
 * circle recogniser.
 */

const WRIST = { x: 0.5, y: 0.95, z: 0 };

/**
 * Build a synthetic hand. `up` is [thumb, index, middle, ring, pinky].
 * Only the wrist, PIP and TIP indices matter to fingersExtended; the rest are
 * filled so the array is a well-formed 21-landmark hand.
 */
function hand(up: boolean[]): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ ...WRIST }));
  const bases = [-0.14, -0.05, 0.0, 0.05, 0.10]; // thumb .. pinky, across the palm
  const groups = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 16],
    [17, 18, 19, 20],
  ];
  groups.forEach((idx, f) => {
    const x = WRIST.x + bases[f]!;
    // PIP always sits partway up the finger; the TIP is what moves.
    const pipY = WRIST.y - 0.10;
    const tipY = up[f] ? WRIST.y - 0.24 : WRIST.y - 0.05;
    lm[idx[0]!] = { x, y: WRIST.y - 0.04, z: 0 };
    lm[idx[1]!] = { x, y: pipY, z: 0 };
    lm[idx[2]!] = { x, y: (pipY + tipY) / 2, z: 0 };
    lm[idx[3]!] = { x, y: tipY, z: 0 };
  });
  return lm;
}

describe("fingersExtended", () => {
  it("reads a two-finger pose", () => {
    const f = fingersExtended(hand([false, true, true, false, false]));
    expect(f[1], "index").toBe(true);
    expect(f[2], "middle").toBe(true);
    expect(f[3], "ring").toBe(false);
    expect(f[4], "pinky").toBe(false);
  });

  it("reads an open hand and a fist", () => {
    expect(fingersExtended(hand([true, true, true, true, true])).slice(1)).toEqual([
      true, true, true, true,
    ]);
    expect(fingersExtended(hand([false, false, false, false, false])).slice(1)).toEqual([
      false, false, false, false,
    ]);
  });

  it("is not fooled by a malformed landmark array", () => {
    expect(fingersExtended([])).toEqual([false, false, false, false, false]);
    expect(fingersExtended(hand([true, true, true, true, true]).slice(0, 10))).toEqual([
      false, false, false, false, false,
    ]);
  });
});

describe("poseSatisfied — twoFingers", () => {
  const gate = (up: boolean[]) =>
    poseSatisfied(fingersExtended(hand(up)), "twoFingers");

  it("accepts index + middle regardless of the thumb", () => {
    expect(gate([false, true, true, false, false])).toBe(true);
    expect(gate([true, true, true, false, false])).toBe(true);
  });

  it("rejects everything else", () => {
    expect(gate([false, false, false, false, false]), "fist").toBe(false);
    expect(gate([true, true, true, true, true]), "open hand").toBe(false);
    expect(gate([false, true, false, false, false]), "index only").toBe(false);
    expect(gate([false, false, true, true, false]), "middle + ring").toBe(false);
    expect(gate([false, true, true, true, false]), "three fingers").toBe(false);
    expect(gate([false, true, true, false, true]), "pinky out").toBe(false);
  });

  it('"any" accepts every shape', () => {
    for (const up of [
      [false, false, false, false, false],
      [true, true, true, true, true],
      [false, true, false, false, false],
    ]) {
      expect(poseSatisfied(fingersExtended(hand(up)), "any")).toBe(true);
    }
  });
});

describe("stroke preview", () => {
  function arc(sweep: number, n = 30): Sample[] {
    const out: Sample[] = [];
    for (let i = 0; i < n; i++) {
      const a = (sweep * i) / (n - 1);
      out.push({
        x: 500 + Math.cos(a) * 120,
        y: 400 + Math.sin(a) * 120,
        t: i * 12,
      });
    }
    return out;
  }

  it("is null before there is a stroke to draw", () => {
    expect(preview([])).toBeNull();
    expect(preview(arc(Math.PI, 3))).toBeNull();
  });

  it("progress grows with the swept angle and reaches 1 as it fires", () => {
    const quarter = preview(arc(Math.PI / 2))!;
    const half = preview(arc(Math.PI))!;
    const full = preview(arc(Math.PI * 2))!;

    expect(quarter.progress).toBeLessThan(half.progress);
    expect(half.progress).toBeLessThan(full.progress);
    expect(full.progress).toBe(1);
    // Feedback must appear well before the gesture is recognised, or it is
    // useless as feedback.
    expect(half.progress).toBeGreaterThan(0.3);
  });

  it("reports a usable centre and radius", () => {
    const p = preview(arc(Math.PI * 2))!;
    expect(p.centerX).toBeCloseTo(500, -1);
    expect(p.centerY).toBeCloseTo(400, -1);
    expect(p.radius).toBeCloseTo(120, -1);
  });

  it("is available from a live buffer mid-stroke", () => {
    const b = new GestureBuffer();
    const pts = arc(Math.PI * 2, 40);
    const seen: number[] = [];
    for (const p of pts) {
      b.feed(p, { width: 1280, height: 960 });
      const pv = b.preview();
      if (pv) seen.push(pv.progress);
    }
    expect(seen.length).toBeGreaterThan(10);
    // Monotonic enough to read as a progress indicator.
    expect(seen[seen.length - 1]!).toBeGreaterThan(seen[0]!);
  });
});
