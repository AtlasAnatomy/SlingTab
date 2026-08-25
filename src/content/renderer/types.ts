import type { SparkSystem } from "./sparks";

export interface RenderState {
  /** Seconds since the sequence began. */
  timeSec: number;
  /** Disc centre and radius, CSS pixels, viewport space. */
  cx: number;
  cy: number;
  radius: number;
  /** 0..1 arc trace. */
  progress: number;
  startAngle: number;
  direction: number;
  /** Master brightness / flare. */
  energy: number;
  /** Slow rotation offset, radians. */
  spin: number;
  /** 0..1, ring blowing apart. */
  dissipate: number;
  /** 0..1 puncture growth for the mode-C vision disc. */
  open: number;
  /** False in iframe mode — the DOM iframe is the portal content instead. */
  showVision: boolean;
  /**
   * Opacity of the composed preview, 0..1.
   *
   * The preview sits ON TOP of the framed page until the frame is worth
   * showing, so handing over is a dissolve rather than a swap. A hard cut from a
   * blurred card to a live page inside a small disc reads as a glitch.
   */
  visionFade: number;

  // ---- gravitational lens over the captured page ----
  /** Radial deflection strength. 0 disables the lens pass entirely. */
  lens: number;
  /** Tangential deflection — frame dragging. */
  swirl: number;
  /** >1 pulls the whole frame toward the centre. 1 = no dive. */
  zoom: number;
  /** Radius, CSS px, of the transparent hole the destination shows through. */
  hole: number;
  /** 0..1 wash toward the destination theme colour at the very end. */
  fade: number;
}

/**
 * Everything about how the rim *looks*, in one place, so it can be driven live
 * by tools/tune.html instead of by editing constants and reloading an
 * extension. These values are the shipping defaults.
 */
export interface LookParams {
  /** Filament brightness. */
  core: number;
  /** Filament half-width as a fraction of the disc radius. */
  thickness: number;
  /** How hard the high-frequency speckle chops the filament into embers. */
  grain: number;
  /** Ember dust hugging the outside of the filament. */
  dust: number;
  /** Bloom weight. */
  glow: number;
  /**
   * Seconds of past trajectory drawn behind each spark. This is a *trail
   * length*, not a motion-blur amount: the ribbon follows the particle's own
   * parabolic path, which is what makes the strands curve like hair instead of
   * lying flat like dashes.
   */
  streak: number;
  /** Rune bands + inscribed polygon. Spec'd in §10, off by default. */
  runes: number;
}

/** Tuned in tools/tune.html. Do not edit blind — run `npm run tune`. */
export const DEFAULT_LOOK: LookParams = {
  core: 1.05,
  thickness: 0.0315,
  grain: 0,
  dust: 0,
  glow: 0.97,
  streak: 0.22,
  runes: 0,
};

export interface PortalRenderer {
  readonly kind: "webgl2" | "canvas2d";
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  setVisionImage(bitmap: ImageBitmap | null): void;
  setTint(rgb: readonly [number, number, number]): void;
  /** Snapshot of the page the portal was opened on, for the lens pass. */
  setPageImage(bitmap: ImageBitmap | null): void;
  setLook(patch: Partial<LookParams>): void;
  render(state: RenderState, sparks: SparkSystem): void;
  dispose(): void;
}

/** Parse #rgb / #rrggbb / rgb(...) into 0..1 triples. Never throws. */
export function parseColor(
  input: string | null | undefined,
  fallback: [number, number, number] = [0.043, 0.039, 0.035],
): [number, number, number] {
  if (!input) return fallback;
  const s = input.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    const short = h.length <= 4;
    const grab = (i: number): number => {
      const part = short ? h[i]!.repeat(2) : h.slice(i * 2, i * 2 + 2);
      return parseInt(part, 16) / 255;
    };
    return [grab(0), grab(1), grab(2)];
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(s);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length === 3) {
      const vals = parts.map((p) =>
        p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p) / 255,
      );
      if (vals.every((v) => Number.isFinite(v))) {
        return [vals[0]!, vals[1]!, vals[2]!];
      }
    }
  }

  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0],
    white: [1, 1, 1],
  };
  return named[s] ?? fallback;
}

export function toCssColor(rgb: readonly [number, number, number]): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])})`;
}