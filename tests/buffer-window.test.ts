import { describe, expect, it } from "vitest";
import {
  GESTURE_TUNING,
  GestureBuffer,
  HAND_WINDOW,
  MOUSE_WINDOW,
} from "../src/content/gesture";

/**
 * The time budget for drawing a circle, which is not the same for both inputs.
 *
 * `maxAgeMs` drops samples off the head of the buffer, so it IS how long a
 * stroke may take. The arc drawn back to the user is measured from that same
 * buffer, so overrunning the budget does not just fail to fire - the ring
 * visibly un-draws itself from its own start while the circle is still being
 * made. At the mouse's 60-120 Hz the budget never binds; at the tracker's
 * 25 Hz, 1200 ms left thirty frames to cover 1.75 turns, and that is what made
 * the hand gesture demand a fast sweep and feel impossible to close.
 */

/** Feed `n` samples `stepMs` apart, starting at `t0`. */
const feed = (b: GestureBuffer, n: number, stepMs: number, t0 = 1000): void => {
  for (let i = 0; i < n; i++) b.push({ x: i, y: i, t: t0 + i * stepMs });
};

describe("buffer window", () => {
  it("keeps the mouse budget as the default, for every existing caller", () => {
    expect(MOUSE_WINDOW.maxAgeMs).toBe(GESTURE_TUNING.maxAgeMs);
    expect(MOUSE_WINDOW.idleResetMs).toBe(GESTURE_TUNING.idleResetMs);
  });

  it("gives the hand a longer stroke than the mouse", () => {
    expect(HAND_WINDOW.maxAgeMs).toBeGreaterThan(MOUSE_WINDOW.maxAgeMs);
    expect(HAND_WINDOW.idleResetMs).toBeGreaterThan(MOUSE_WINDOW.idleResetMs);
  });

  /**
   * The tracker disarms after 9 frames of a lost pose at 40 ms, and dropping
   * the pose is what is meant to clear a stroke. If the idle reset fired first,
   * a single flickered landmark would wipe a circle mid-draw.
   */
  it("keeps the hand idle reset above the tracker's disarm time", () => {
    expect(HAND_WINDOW.idleResetMs).toBeGreaterThan(9 * 40);
  });

  it("a 25 Hz stroke survives two seconds on the hand window", () => {
    const b = new GestureBuffer(HAND_WINDOW);
    feed(b, 50, 40); // 50 frames at 40 ms = 2.0 s
    expect(b.length).toBe(50);
  });

  it("the same stroke would have been truncated by the mouse window", () => {
    const b = new GestureBuffer(MOUSE_WINDOW);
    feed(b, 50, 40);
    // The regression this pins: the head of the circle is gone before the hand
    // has finished drawing it.
    expect(b.length).toBeLessThan(50);
  });

  it("still trims beyond its own window", () => {
    const b = new GestureBuffer(HAND_WINDOW);
    feed(b, 200, 40, 1000); // 8 s of samples
    const last = b.samples[b.samples.length - 1]!.t;
    for (const s of b.samples) {
      expect(s.t).toBeGreaterThanOrEqual(last - HAND_WINDOW.maxAgeMs);
    }
  });

  it("still self-resets after its own idle gap", () => {
    const b = new GestureBuffer(HAND_WINDOW);
    feed(b, 5, 40);
    const last = b.samples[b.samples.length - 1]!.t;
    expect(b.isStale(last + HAND_WINDOW.idleResetMs - 1)).toBe(false);
    expect(b.isStale(last + HAND_WINDOW.idleResetMs + 1)).toBe(true);
  });

  it("a bare buffer is still a mouse buffer", () => {
    const bare = new GestureBuffer();
    const mouse = new GestureBuffer(MOUSE_WINDOW);
    feed(bare, 50, 40);
    feed(mouse, 50, 40);
    expect(bare.length).toBe(mouse.length);
  });
});
