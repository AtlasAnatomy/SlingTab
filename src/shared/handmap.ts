import { clamp01 } from "./easing";

/**
 * Camera space -> viewport space.
 *
 * The tracker reports landmarks as fractions of the camera frame, and those
 * used to be handed to the viewport 1:1. That is wrong twice over:
 *
 *  1. A hand never reaches the edges of the frame. Shoulders, field of view and
 *     the length of an arm mean the usable region is roughly the middle 60% of
 *     the picture, so a 1:1 map made only the middle 60% of the screen
 *     reachable. That is the "it doesn't cover the whole screen" complaint.
 *
 *  2. The camera is 4:3 and the screen usually is not. Normalising x and y
 *     independently means a circle drawn in the air arrives as an ellipse ~1.33x
 *     wider than tall on a 16:9 display — while the recogniser, working in a
 *     frame-shaped space, sees a perfect circle and happily fires. Where you
 *     point and where the ring lands stop agreeing.
 *
 * The fix for both is one rectangle: an ACTIVE BOX centred in the frame, with
 * the same PHYSICAL aspect ratio as the viewport, stretched to fill [0,1]². The
 * box is smaller than the frame, so the reachable part of the picture now spans
 * the whole screen; the box matches the screen's shape, so a round gesture stays
 * round. Everything here is pure — `tests/handmap.test.ts` covers it.
 */

export interface ActiveBox {
  /** Span of the box along the frame's width, as a fraction of it. */
  w: number;
  /** Span of the box along the frame's height, as a fraction of it. */
  h: number;
}

export const HAND_MAP = {
  /**
   * How much of the frame's width the box spans; the vertical span follows from
   * the viewport aspect, and on a 16:9 screen works out around 0.56.
   *
   * Raising this makes the mapping less twitchy (more hand movement per screen
   * pixel) at the cost of asking the arm to travel further.
   *
   * Was 0.75 on the reasoning that past ~0.85 the corners of the frame need a
   * shoulder and the landmark model loses accuracy near the edges of its own
   * input. Held against a real camera that reasoning was too cautious: the box
   * read as a small window in the middle of the picture. 0.92 leaves 4% of the
   * frame either side, which is enough margin for the model without wasting the
   * usable width.
   *
   * Note the ceiling this cannot escape: the box carries the VIEWPORT's aspect
   * ratio, so on a 16:9 screen its height is only 0.75x its width whatever this
   * is set to. At 0.92 that is 92% of the frame across and 69% down.
   */
  coverage: 0.92,
  /** A box thinner than this on either axis is unusable, whatever the aspect. */
  minSpan: 0.2,
  /**
   * How far the disc centre may sit outside the viewport, as a fraction of its
   * radius. This used to be 0.6, which kept the whole disc on screen but stole
   * back a band of reachable area on every edge — circling a link in a corner
   * simply could not put the centre there. 0.15 keeps most of the disc visible
   * and lets the corners be corners.
   */
  edgePad: 0.15,
} as const;

/**
 * The centred rectangle of the camera frame that maps onto the whole viewport.
 *
 * `frameAspect` and `viewportAspect` are both width/height. The box is chosen so
 * that its physical shape matches the viewport's: a square traced in the air
 * comes out square on screen.
 */
export function activeBox(
  viewportAspect: number,
  frameAspect: number,
  coverage: number = HAND_MAP.coverage,
): ActiveBox {
  // Guard against a zero-sized video element or a viewport measured mid-resize;
  // a NaN here would poison every sample that follows.
  const va = Number.isFinite(viewportAspect) && viewportAspect > 0 ? viewportAspect : 16 / 9;
  const fa = Number.isFinite(frameAspect) && frameAspect > 0 ? frameAspect : 4 / 3;
  const c = Math.min(1, Math.max(HAND_MAP.minSpan, coverage));

  // (w * frameWidth) / (h * frameHeight) = viewportAspect  =>  w/h = va/fa.
  const k = va / fa;

  let w = c;
  let h = w / k;
  if (h > 1) {
    h = 1;
    w = k;
  }
  if (w > 1) {
    w = 1;
    h = 1 / k;
  }

  // On an extreme aspect ratio one axis can still come out unusably thin. Exact
  // shape is worth less than being able to reach the far side of the box, so the
  // clamp wins and the mapping becomes slightly anisotropic.
  return {
    w: Math.min(1, Math.max(HAND_MAP.minSpan, w)),
    h: Math.min(1, Math.max(HAND_MAP.minSpan, h)),
  };
}

/** Frame-space rectangle of the box, for drawing it over the camera picture. */
export function boxRect(box: ActiveBox): { x: number; y: number; w: number; h: number } {
  return { x: (1 - box.w) / 2, y: (1 - box.h) / 2, w: box.w, h: box.h };
}

/**
 * Frame fraction -> viewport fraction. Outside the box saturates at the edge,
 * which is what makes the very edge of the screen reachable at all: you do not
 * have to find an exact spot, you just have to push past it.
 */
export function mapToViewport(x: number, y: number, box: ActiveBox): { x: number; y: number } {
  const r = boxRect(box);
  return {
    x: clamp01((x - r.x) / r.w),
    y: clamp01((y - r.y) / r.h),
  };
}

/**
 * The inverse, for the diagnostic view: the recogniser's buffer holds mapped
 * coordinates, and drawing those straight onto the camera image would show a
 * stroke 1.6x larger than the hand that made it.
 */
export function unmapFromViewport(x: number, y: number, box: ActiveBox): { x: number; y: number } {
  const r = boxRect(box);
  return {
    x: r.x + clamp01(x) * r.w,
    y: r.y + clamp01(y) * r.h,
  };
}

/**
 * Keep the disc's centre near enough to the viewport that it still reads as a
 * portal, without clawing back the reach the active box just bought.
 */
export function edgeClamp(v: number, radius: number, extent: number): number {
  const pad = Math.min(radius * HAND_MAP.edgePad, extent / 2);
  return Math.min(extent - pad, Math.max(pad, v));
}
