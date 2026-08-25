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
  minPathLengthPx: 150,
  /** Buffer self-resets this long after the last sample. */
  idleResetMs: 300,
} as const;

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
    totalTurn += unwrap(theta - prevTheta);
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
    return (
      this.points.length > 0 && now - this.lastTime > GESTURE_TUNING.idleResetMs
    );
  }

  push(sample: Sample): void {
    if (this.isStale(sample.t)) this.clear();
    this.points.push(sample);

    const cutoff = sample.t - GESTURE_TUNING.maxAgeMs;
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

/** What the content script calls: lead-in tolerant recognition. */
export function recognize(
  points: readonly Sample[],
  viewport: Viewport,
): GestureResult | null {
  const direct = recognizeCircle(points, viewport);
  if (direct) return direct;
  const trimmed = trimLeadIn(points);
  return trimmed === points ? null : recognizeCircle(trimmed, viewport);
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
