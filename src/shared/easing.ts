export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => clamp(v, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);

export const easeInCubic = (t: number): number => Math.pow(clamp01(t), 3);

export const easeOutQuint = (t: number): number => 1 - Math.pow(1 - clamp01(t), 5);

export const easeInOutCubic = (t: number): number => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/** Normalised progress of `now` through a [start, start+duration] window. */
export const phase = (now: number, start: number, duration: number): number =>
  duration <= 0 ? 1 : clamp01((now - start) / duration);

/** Equivalent CSS timing functions, for the few places we hand off to WAAPI. */
export const CSS_EASE = {
  outCubic: "cubic-bezier(0.215, 0.61, 0.355, 1)",
  inCubic: "cubic-bezier(0.55, 0.055, 0.675, 0.19)",
  outQuint: "cubic-bezier(0.23, 1, 0.32, 1)",
} as const;
