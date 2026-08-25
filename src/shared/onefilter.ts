/**
 * One Euro filter (Casiez, Roussel, Vogel — CHI 2012), for the tracked
 * fingertip.
 *
 * The active box amplifies camera motion by roughly 1.6x horizontally and 2.1x
 * vertically, and it amplifies the landmark jitter by exactly as much. A fixed
 * low-pass would trade that jitter for lag, which on a gesture that has to close
 * a circle in about a second is the worse of the two problems.
 *
 * One Euro adapts instead: the cutoff frequency rises with the speed of the
 * signal, so a hand holding still is smoothed hard and a hand mid-stroke is
 * barely touched. Two parameters do the work — `minCutoff` sets how still a
 * still hand looks, `beta` sets how quickly the filter gets out of the way.
 *
 * Pure, and `tests/onefilter.test.ts` covers it. Inputs are viewport fractions
 * and time is in seconds, so `dx` is "screens per second" and beta is tuned for
 * that scale, not for pixels.
 */

export interface OneEuroOptions {
  /** Hz. Lower = steadier at rest, and laggier. */
  minCutoff?: number;
  /** How much speed raises the cutoff. Higher = less lag, more jitter. */
  beta?: number;
  /** Hz. Cutoff of the derivative estimate itself. Rarely worth changing. */
  dCutoff?: number;
}

export const ONE_EURO_DEFAULTS: Required<OneEuroOptions> = {
  // Reasoned, not tuned against a real webcam — see §11. Start here if the
  // pointer feels either sticky (raise minCutoff) or noisy (lower beta).
  minCutoff: 1.2,
  beta: 0.5,
  dCutoff: 1.0,
};

const TAU = Math.PI * 2;

/** Smoothing factor of a first-order low-pass at `cutoff` Hz over `dt` seconds. */
export function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (TAU * Math.max(1e-6, cutoff));
  return 1 / (1 + tau / Math.max(1e-6, dt));
}

export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;

  /** The last FILTERED value, not the last input. */
  private xHat: number | null = null;
  private dxHat = 0;
  private tPrev = 0;

  constructor(opts: OneEuroOptions = {}) {
    this.minCutoff = opts.minCutoff ?? ONE_EURO_DEFAULTS.minCutoff;
    this.beta = opts.beta ?? ONE_EURO_DEFAULTS.beta;
    this.dCutoff = opts.dCutoff ?? ONE_EURO_DEFAULTS.dCutoff;
  }

  reset(): void {
    this.xHat = null;
    this.dxHat = 0;
    this.tPrev = 0;
  }

  /** `t` is seconds, any epoch, monotonic within a run. */
  filter(x: number, t: number): number {
    if (!Number.isFinite(x)) return this.xHat ?? 0;

    if (this.xHat === null) {
      this.xHat = x;
      this.tPrev = t;
      return x;
    }

    // A dropped frame or a clock that went backwards must not produce a divide
    // by zero and a NaN that then sticks forever.
    const dt = t > this.tPrev ? Math.min(0.5, t - this.tPrev) : 1 / 25;
    this.tPrev = t;

    const dx = (x - this.xHat) / dt;
    this.dxHat += alpha(this.dCutoff, dt) * (dx - this.dxHat);

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    this.xHat += alpha(cutoff, dt) * (x - this.xHat);
    return this.xHat;
  }
}

/** Two independent filters. x and y jitter independently, so they smooth independently. */
export class OneEuroFilter2D {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(opts: OneEuroOptions = {}) {
    this.fx = new OneEuroFilter(opts);
    this.fy = new OneEuroFilter(opts);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  filter(x: number, y: number, t: number): { x: number; y: number } {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }
}
