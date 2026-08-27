/**
 * Circle recogniser. Pure — no DOM, no globals, no timers. Everything it needs
 * arrives as arguments so it can be unit-tested against synthetic point arrays.
 *
 * The algorithm is accumulated turning angle around the running centroid. The
 * only subtle part is the (−π, π] unwrap in step 2: without it, every crossing
 * of the ±π branch cut injects a ±2π spike and the total never converges.
 */

export interface Sample {
  x: number;
  y: number;
  /** Milliseconds, any epoch, monotonic within a buffer. */
  t: number;
}

export interface GestureResult {
  centerX: number;
  centerY: number;
  radius: number;
  /** +1 or −1: the direction the hand travelled. The ring traces this way. */
  direction: number;
  /** Angle of the first buffered sample about the centroid, radians. */
  startAngle: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const GESTURE_TUNING = {
  /** Samples older than this are dropped from the buffer. */
  maxAgeMs: 1200,
  /** Hard cap on buffer length. */
  maxPoints: 200,
  /** Below this we do not even try. */
  minPoints: 12,
  /** Deliberately under 2π: fires just before the loop closes, which reads as
   *  responsive rather than laggy. */
  minTurn: 1.75 * Math.PI,
  minRadiusPx: 40,
  /** As a fraction of min(vw, vh). */
  maxRadiusFrac: 0.45,
  /** Radial jitter tolerance. Rejects scribbles and lassos. */
  maxRadiusCv: 0.3,
  /**
   * Largest angular step, about the centroid, between two consecutive samples.
   *
   * A stroke is sampled far above the rate at which it turns: a hand at 25 Hz
   * drawing 1.85 turns in 30 frames moves 22 degrees a frame, and a mouse at
   * 120 Hz moves far less. A step approaching 180 degrees is not a fast circle,
   * it is aliasing — and it is how a zigzag reads as a gesture. Points that
   * alternate either side of the centroid jump close to 180 degrees each time,
   * which accumulates as apparent rotation while the radii stay uniform enough
   * to pass the roundness test.
   *
   * 90 degrees is four times the fastest real hand stroke, so it rejects the
   * degenerate case without coming near a genuine one.
   */
  maxStepTurn: Math.PI / 2,
  minPathLengthPx: 150,
  /** Buffer self-resets this long after the last sample. */
  idleResetMs: 300,
} as const;

/**
 * How long a stroke may take, per input device.
 *
 * `maxAgeMs` is not a detail: samples older than it are dropped from the head
 * of the buffer, so it IS the time budget for drawing a whole circle. And
 * because the arc drawn back to the user is measured from the same buffer, a
 * stroke that outruns the budget does not merely fail to fire — it visibly
 * un-draws itself from the start while the user is still making it.
 *
 * A mouse samples at 60-120 Hz, so 1200 ms is over a hundred points and the
 * budget never binds; it binds on the hand, which samples at 25 Hz. Thirty
 * frames to cover 1.75 turns forced a fast, sharp movement, and moving a hand
 * in the air fast enough to satisfy it is exactly what made the gesture hard to
 * close.
 *
 * `idleResetMs` must stay above the tracker's disarm time (9 frames at 40 ms =
 * 360 ms) so that dropping the pose, not a momentary landmark flicker, is what
 * clears a stroke.
 */
export interface BufferWindow {
  maxAgeMs: number;
  idleResetMs: number;
}

/** The original numbers, still the single source of truth for the mouse. */
export const MOUSE_WINDOW: BufferWindow = {
  maxAgeMs: GESTURE_TUNING.maxAgeMs,
  idleResetMs: GESTURE_TUNING.idleResetMs,
};

export const HAND_WINDOW: BufferWindow = {
  maxAgeMs: 3000,
  idleResetMs: 700,
};

const TAU = Math.PI * 2;

/** Wrap an angle delta into (−π, π]. */
export function unwrap(delta: number): number {
  let d = delta;
  while (d > Math.PI) d -= TAU;
  while (d <= -Math.PI) d += TAU;
  return d;
}

export interface GestureMetrics {
  count: number;
  centerX: number;
  centerY: number;
  totalTurn: number;
  /** Largest single-step angular jump about the centroid, radians. */
  maxStepTurn: number;
  radiusMean: number;
  radiusStd: number;
  pathLength: number;
  startAngle: number;
}

/** Everything the predicate needs, exposed so tests can assert on the middle. */
export function measure(points: readonly Sample[]): GestureMetrics | null {
  const n = points.length;
  if (n < 2) return null;

  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const cx = sx / n;
  const cy = sy / n;

  const first = points[0]!;
  let prevTheta = Math.atan2(first.y - cy, first.x - cx);
  const startAngle = prevTheta;

  let totalTurn = 0;
  let maxStepTurn = 0;
  let pathLength = 0;
  let rSum = 0;
  let rSqSum = 0;

  {
    const r0 = Math.hypot(first.x - cx, first.y - cy);
    rSum += r0;
    rSqSum += r0 * r0;
  }

  for (let i = 1; i < n; i++) {
    const p = points[i]!;
    const q = points[i - 1]!;

    const theta = Math.atan2(p.y - cy, p.x - cx);
    const step = unwrap(theta - prevTheta);
    totalTurn += step;
    maxStepTurn = Math.max(maxStepTurn, Math.abs(step));
    prevTheta = theta;

    pathLength += Math.hypot(p.x - q.x, p.y - q.y);

    const r = Math.hypot(p.x - cx, p.y - cy);
    rSum += r;
    rSqSum += r * r;
  }

  const radiusMean = rSum / n;
  const variance = Math.max(0, rSqSum / n - radiusMean * radiusMean);

  return {
    count: n,
    centerX: cx,
    centerY: cy,
    totalTurn,
    maxStepTurn,
    radiusMean,
    radiusStd: Math.sqrt(variance),
    pathLength,
    startAngle,
  };
}

/**
 * Returns a gesture when every criterion in §5 holds, otherwise null.
 * Safe to call on every sample.
 */
export function recognizeCircle(
  points: readonly Sample[],
  viewport: Viewport,
): GestureResult | null {
  if (points.length < GESTURE_TUNING.minPoints) return null;

  const m = measure(points);
  if (!m) return null;

  if (Math.abs(m.totalTurn) < GESTURE_TUNING.minTurn) return null;
  // Before trusting totalTurn at all: a step near PI is aliasing, not rotation.
  if (m.maxStepTurn > GESTURE_TUNING.maxStepTurn) return null;
  if (m.pathLength < GESTURE_TUNING.minPathLengthPx) return null;
  if (m.radiusMean < GESTURE_TUNING.minRadiusPx) return null;

  const maxRadius =
    GESTURE_TUNING.maxRadiusFrac * Math.min(viewport.width, viewport.height);
  if (m.radiusMean > maxRadius) return null;

  if (m.radiusStd / m.radiusMean >= GESTURE_TUNING.maxRadiusCv) return null;

  return {
    centerX: m.centerX,
    centerY: m.centerY,
    radius: m.radiusMean,
    direction: Math.sign(m.totalTurn) || 1,
    startAngle: m.startAngle,
  };
}

/**
 * Ring buffer with the age/length policy from §5. Also pure: `now` is passed in
 * rather than read from a clock, so tests control time.
 */
export class GestureBuffer {
  private points: Sample[] = [];

  /**
   * Defaults to the mouse budget, so every existing caller and every test that
   * constructs a bare buffer behaves exactly as it did.
   */
  constructor(private window: BufferWindow = MOUSE_WINDOW) {}

  get length(): number {
    return this.points.length;
  }

  get samples(): readonly Sample[] {
    return this.points;
  }

  get lastTime(): number {
    return this.points.length ? this.points[this.points.length - 1]!.t : -Infinity;
  }

  clear(): void {
    this.points.length = 0;
  }

  /** True when the buffer has gone quiet long enough that it should reset. */
  isStale(now: number): boolean {
    return this.points.length > 0 && now - this.lastTime > this.window.idleResetMs;
  }

  push(sample: Sample): void {
    if (this.isStale(sample.t)) this.clear();
    this.points.push(sample);

    const cutoff = sample.t - this.window.maxAgeMs;
    let drop = 0;
    while (drop < this.points.length && this.points[drop]!.t < cutoff) drop++;
    const overflow = this.points.length - drop - GESTURE_TUNING.maxPoints;
    if (overflow > 0) drop += overflow;
    if (drop > 0) this.points.splice(0, drop);
  }

  /** Push then test, the way the content script uses it. */
  feed(sample: Sample, viewport: Viewport): GestureResult | null {
    this.push(sample);
    return recognize(this.points, viewport);
  }

  /** Diagnostics for the current buffer, without consuming it. */
  explain(viewport: Viewport): GestureExplain {
    return explain(this.points, viewport);
  }

  /**
   * The stroke so far, for drawing it back to the user while they are still
   * making it. Deliberately far more permissive than recognition: this is
   * feedback, and refusing to show anything until every criterion already
   * passes would defeat the point.
   */
  preview(): StrokePreview | null {
    return preview(this.points);
  }
}

export interface StrokePreview {
  centerX: number;
  centerY: number;
  radius: number;
  startAngle: number;
  direction: number;
  /** 0..1 of the turn needed to fire. Reaches 1 exactly as the gesture fires. */
  progress: number;
}

/** Live stroke metrics. Null until there is enough of a stroke to draw. */
export function preview(points: readonly Sample[]): StrokePreview | null {
  if (points.length < 5) return null;
  const m = measure(points);
  if (!m || m.radiusMean < 8) return null;
  return {
    centerX: m.centerX,
    centerY: m.centerY,
    radius: m.radiusMean,
    startAngle: m.startAngle,
    direction: Math.sign(m.totalTurn) || 1,
    progress: Math.min(1, Math.abs(m.totalTurn) / GESTURE_TUNING.minTurn),
  };
}

/**
 * Drop a leading run of samples that sit well inside the ring.
 *
 * People press the button on the thing they want and *then* swing outward, so
 * the first samples of a real gesture are often near the centre. Those points
 * wreck rStd/rMean — the scribble filter — and the circle never fires even
 * though the hand drew a perfectly good one.
 *
 * Only a contiguous prefix is trimmed, only points inside 55% of the ring, and
 * never more than a third of the buffer. That is enough to swallow a lead-in
 * and not enough to swallow a lobe of a figure-eight.
 */
export function trimLeadIn(points: readonly Sample[]): readonly Sample[] {
  const n = points.length;
  if (n < GESTURE_TUNING.minPoints * 2) return points;

  const maxCut = Math.floor(n / 3);
  const tail = points.slice(maxCut);
  const m = measure(tail);
  if (!m || m.radiusMean <= 0) return points;

  // 0.8 rather than something timid: a run-out from the centre passes through
  // every radius on the way to the rim, and leaving the tail of it behind still
  // drags rMean down. A real circle's first sample already sits near rMean
  // (rStd/rMean < 0.30 means roughly 0.7-1.3 rMean), so this stops immediately
  // on a gesture that had no lead-in.
  const floor = m.radiusMean * 0.8;
  let cut = 0;
  while (cut < maxCut) {
    const p = points[cut]!;
    if (Math.hypot(p.x - m.centerX, p.y - m.centerY) >= floor) break;
    cut++;
  }
  return cut === 0 ? points : points.slice(cut);
}

/**
 * How many progressively shorter tails to try before giving up.
 *
 * `trimLeadIn` alone was enough while the buffer was 1200 ms long, because at
 * that length the buffer WAS the circle: anything older had already been
 * dropped, and the only lead-in left to remove was the short run-out from the
 * centre that trimLeadIn was written for. It is not enough at the hand's 3000 ms,
 * where the buffer also holds the second or two of hovering and drifting before
 * the user began to draw. trimLeadIn cannot reach that: it removes at most a
 * third of the buffer, and only points that sit INSIDE the ring, while a hand
 * waiting to start is usually outside it.
 *
 * Six is enough to bracket a lead-in of any length from a tenth of the buffer
 * to six sevenths of it, and cheap: the tails shrink, so the whole scan costs
 * about four times a single measure of the buffer.
 */
const TAIL_ATTEMPTS = 6;

/** One window, with and without its own lead-in removed. */
function recognizeWindow(
  points: readonly Sample[],
  viewport: Viewport,
): GestureResult | null {
  const direct = recognizeCircle(points, viewport);
  if (direct) return direct;
  const trimmed = trimLeadIn(points);
  return trimmed === points ? null : recognizeCircle(trimmed, viewport);
}

/**
 * What the content script calls: lead-in tolerant recognition.
 *
 * A circle is always the NEWEST contiguous run of samples — whatever came
 * before it is approach, hesitation, or a previous idea. So when the buffer as
 * a whole is not a circle, ask again of progressively shorter tails of it.
 *
 * The longest tail that passes wins, so the answer keeps as much of the real
 * stroke as it can and the centre and radius come from the whole circle rather
 * than an arc of it.
 */
export function recognize(
  points: readonly Sample[],
  viewport: Viewport,
): GestureResult | null {
  const whole = recognizeWindow(points, viewport);
  if (whole) return whole;

  const n = points.length;
  for (let i = 1; i <= TAIL_ATTEMPTS; i++) {
    const start = Math.round((n * i) / (TAIL_ATTEMPTS + 1));
    if (n - start < GESTURE_TUNING.minPoints) break;
    const hit = recognizeWindow(points.slice(start), viewport);
    if (hit) return hit;
  }
  return null;
}

export interface GestureCheck {
  ok: boolean;
  value: number;
  need: string;
}

export interface GestureExplain {
  fired: boolean;
  trimmed: number;
  metrics: GestureMetrics | null;
  checks: Record<string, GestureCheck>;
}

/**
 * Why a buffer did or did not fire. Used by the in-page diagnostics so a
 * "nothing happens" report becomes a number instead of a guess.
 */
export function explain(
  points: readonly Sample[],
  viewport: Viewport,
): GestureExplain {
  // Report on whichever buffer actually produced the result. When nothing
  // fires, report the raw buffer: metrics from a trimmed buffer that was itself
  // rejected describe a stroke the user never drew, which is worse than no
  // diagnostic at all.
  const trimmed = trimLeadIn(points);
  const used =
    recognizeCircle(points, viewport) || !recognizeCircle(trimmed, viewport)
      ? points
      : trimmed;
  const m = measure(used);
  const maxRadius =
    GESTURE_TUNING.maxRadiusFrac * Math.min(viewport.width, viewport.height);

  const checks: Record<string, GestureCheck> = {
    points: {
      ok: used.length >= GESTURE_TUNING.minPoints,
      value: used.length,
      need: `>= ${GESTURE_TUNING.minPoints}`,
    },
    turn: {
      ok: !!m && Math.abs(m.totalTurn) >= GESTURE_TUNING.minTurn,
      value: m ? Math.abs(m.totalTurn) : 0,
      need: `>= ${GESTURE_TUNING.minTurn.toFixed(2)} rad (1.75 PI)`,
    },
    pathLength: {
      ok: !!m && m.pathLength >= GESTURE_TUNING.minPathLengthPx,
      value: m?.pathLength ?? 0,
      need: `>= ${GESTURE_TUNING.minPathLengthPx} px`,
    },
    radiusMin: {
      ok: !!m && m.radiusMean >= GESTURE_TUNING.minRadiusPx,
      value: m?.radiusMean ?? 0,
      need: `>= ${GESTURE_TUNING.minRadiusPx} px`,
    },
    radiusMax: {
      ok: !!m && m.radiusMean <= maxRadius,
      value: m?.radiusMean ?? 0,
      need: `<= ${maxRadius.toFixed(0)} px`,
    },
    smoothness: {
      ok: !!m && m.maxStepTurn <= GESTURE_TUNING.maxStepTurn,
      value: m?.maxStepTurn ?? 0,
      need: `<= ${GESTURE_TUNING.maxStepTurn.toFixed(2)} rad per sample`,
    },
    roundness: {
      ok: !!m && m.radiusMean > 0 && m.radiusStd / m.radiusMean < GESTURE_TUNING.maxRadiusCv,
      value: m && m.radiusMean > 0 ? m.radiusStd / m.radiusMean : Infinity,
      need: `< ${GESTURE_TUNING.maxRadiusCv}`,
    },
  };

  return {
    fired: Boolean(recognize(points, viewport)),
    trimmed: points.length - used.length,
    metrics: m,
    checks,
  };
}
