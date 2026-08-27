import { clamp01 } from "../shared/easing";
import { edgeClamp } from "../shared/handmap";
import { createOverlay, type Overlay } from "./overlay";
import { SPARK_TUNING, SparkSystem } from "./renderer/sparks";
import type { RenderState } from "./renderer/types";

/**
 * The trail of sparks left while the hand is still drawing the circle.
 *
 * Sparks ONLY — no filament, no glow, no closed ring. The ring is what a
 * completed portal looks like; drawing it while the gesture is still being made
 * claims something that has not happened. The arc of embers growing round is
 * the feedback, and it is also the progress bar: it is emitted along the swept
 * angle, so it closes exactly when the gesture fires.
 *
 * The embers ride the FITTED circle, not the raw hand path. The path itself
 * wanders — that is what the pale polyline on the camera page shows — and the
 * arc has to read as round.
 *
 * Same particle system as the real thing, and on completion the overlay is
 * handed straight to Departure, so the ring lights up on the frame the circle
 * closes with no teardown-and-rebuild flicker.
 */
/**
 * Lifetime multiplier for sparks thrown off the moving fingertip. Kept near 1:
 * these are the ones flying away, and they are also the high-rate population,
 * so their lifetime dominates the particle budget below.
 */
export const LEAD_LIFE = 1.0;
export const LEAD_RATE_FRACTION = 0.4;
/**
 * The already-drawn arc has to survive until the user drops the pose, so these
 * both outlive any plausible stroke and barely fall.
 */
export const TRAIL_LIFE = 5.5;
const TRAIL_GRAVITY = 0.04;
/** Embers per second scattered along the part already swept. */
export const TRAIL_RATE = 1200;

/**
 * Steady-state population is roughly rate * meanLife * lifeScale, and it must
 * stay clear of MAX_SPARKS. Overshoot and the recycler starts overwriting
 * particles that are still alive, which reads as a thin, flickering trail that
 * no amount of rate tuning fixes. tests/handpreview.test.ts holds the margin.
 */
export const SPARK_MEAN_LIFE = 0.72;

/**
 * Silence after which the preview takes itself down.
 *
 * Nothing else would. The preview is destroyed by `HAND_ARMED: false`, and the
 * offscreen tracker can stop without ever sending one — a worker killed
 * mid-relay, a camera permission revoked from the omnibox, the document closed
 * because the trigger changed in another window. The rAF loop and the WebGL
 * context it owns would then run on the user's page until they navigated away.
 *
 * Well clear of the ~45 ms cadence of HAND_PREVIEW (22 Hz) and of any plausible
 * stall in the offscreen -> worker -> tab relay, so a live hand never trips it.
 * By this point `presence` has been at zero for well over a second and there
 * has been nothing on screen to remove for just as long.
 */
const PREVIEW_SILENCE_MS = 2000;

export class HandPreview {
  private overlay: Overlay | null;
  private sparks = new SparkSystem();
  private raf = 0;
  private t0 = performance.now();
  private last = this.t0;
  private released = false;

  private cx = 0;
  private cy = 0;
  private radius = 0;
  private progress = 0;
  private startAngle = 0;
  private direction = 1;
  /** Ramps down when updates stop arriving, so a dropped hand fades out. */
  private presence = 0;
  private lastUpdate = 0;

  /** The tracked fingertip, and how fast it is moving. */
  private px = 0;
  private py = 0;
  private pvx = 0;
  private pvy = 0;
  private hasPointer = false;
  private hasFit = false;

  constructor() {
    this.overlay = createOverlay();
    if (!this.overlay) return;
    window.addEventListener("resize", this.onResize, true);
    this.raf = requestAnimationFrame(this.frame);
  }

  get alive(): boolean {
    return this.overlay !== null && !this.released && !this.overlay.disposed;
  }

  private onResize = (): void => this.overlay?.resize();

  update(p: {
    /** The tracked fingertip, always present while the pose is held. */
    pointerXFrac: number;
    pointerYFrac: number;
    /** The fitted circle. Null until there are enough samples to fit one. */
    centerXFrac: number | null;
    centerYFrac: number | null;
    radiusFrac: number | null;
    startAngle: number;
    direction: number;
    progress: number;
  }): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const now = performance.now();

    // --- the fingertip: this is where sparks are born ---
    const px = p.pointerXFrac * vw;
    const py = p.pointerYFrac * vh;
    if (this.hasPointer) {
      // Smoothed, because landmark inference jitters frame to frame and an
      // unsmoothed emission point visibly stutters.
      const prevX = this.px;
      const prevY = this.py;
      this.px += (px - this.px) * 0.45;
      this.py += (py - this.py) * 0.45;
      const dt = Math.max(0.001, (now - this.lastUpdate) / 1000);
      this.pvx = (this.px - prevX) / dt;
      this.pvy = (this.py - prevY) / dt;
    } else {
      this.px = px;
      this.py = py;
      this.hasPointer = true;
    }

    // --- the fitted circle: only once one exists ---
    if (p.centerXFrac !== null && p.centerYFrac !== null && p.radiusFrac !== null) {
      const radius = Math.min(0.45 * Math.min(vw, vh), Math.max(48, p.radiusFrac * vw));
      const k = this.hasFit ? 0.35 : 1;
      // Same clamp the real departure uses, so the preview ring and the portal
      // that replaces it sit in exactly the same place.
      const tx = edgeClamp(p.centerXFrac * vw, radius, vw);
      const ty = edgeClamp(p.centerYFrac * vh, radius, vh);
      this.cx += (tx - this.cx) * k;
      this.cy += (ty - this.cy) * k;
      this.radius += (radius - this.radius) * k;
      this.hasFit = true;
    }

    this.startAngle = p.startAngle;
    this.direction = p.direction || 1;
    this.progress = clamp01(p.progress);
    this.lastUpdate = now;
  }

  /**
   * Hand the overlay over to the real departure instead of destroying it. The
   * ring is mid-flight; rebuilding a fresh overlay here would drop a frame and
   * restart the arc from zero.
   */
  release(): Overlay | null {
    if (this.released) return null;
    this.released = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize, true);
    const o = this.overlay;
    this.overlay = null;
    return o;
  }

  destroy(): void {
    const o = this.release();
    o?.destroy();
  }

  private frame = (now: number): void => {
    if (!this.overlay || this.released) return;
    // The overlay was swept out from under us: a newer portal or preview owns
    // the screen now. Without this the loop would run for the life of the
    // document, rendering into a dead host, and `alive` would stay true so no
    // replacement preview could ever be built.
    if (this.overlay.disposed) {
      this.release();
      return;
    }
    this.raf = requestAnimationFrame(this.frame);

    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    // Fade in while updates flow, out when they stop.
    const stale = now - this.lastUpdate > 220;
    this.presence += ((stale ? 0 : 1) - this.presence) * Math.min(1, dt * 9);
    if (this.presence < 0.01 && stale) {
      // `t0`, not just `lastUpdate`: a preview built by HAND_ARMED that never
      // receives a single frame has `lastUpdate` at 0 for ever, and measuring
      // from the epoch would destroy it before its first update could land.
      if (now - Math.max(this.lastUpdate, this.t0) > PREVIEW_SILENCE_MS) {
        this.destroy();
        return;
      }
      this.sparks.update(dt);
      this.overlay.render(this.blankState(now), this.sparks);
      return;
    }

    // The tip of the sparkler, at the fingertip itself — not at a computed
    // angle on a fitted circle, which does not exist for the first handful of
    // samples. This is what makes sparks appear the instant the pose is read.
    if (this.hasPointer) {
      this.sparks.emitAtPointRate(
        this.px, this.py, this.pvx, this.pvy,
        SPARK_TUNING.rateIgnite * LEAD_RATE_FRACTION * this.presence, dt,
        SPARK_TUNING.igniteSpeed * 0.75,
        LEAD_LIFE,
      );
    }

    // What has already been drawn: embers resting along the swept arc. Slow,
    // long-lived, and with gravity almost switched off — at full gravity they
    // fall away from the circle within a second and the drawn arc smears
    // downward into a curtain instead of staying an arc.
    //
    // On the FITTED circle, not the raw hand path: the path wanders, and the
    // arc has to read as round.
    if (this.hasFit && this.radius > 8 && this.progress > 0.015) {
      const sweep = this.progress * Math.PI * 2;
      this.sparks.emitAlongArc(
        this.cx, this.cy, this.radius, this.startAngle, sweep, this.direction,
        TRAIL_RATE * this.presence, dt,
        SPARK_TUNING.shedSpeed * 0.30, TRAIL_LIFE, TRAIL_GRAVITY,
      );
    }
    this.sparks.update(dt);

    const state: RenderState = {
      timeSec: (now - this.t0) / 1000,
      cx: this.cx,
      cy: this.cy,
      radius: this.radius,
      progress: this.progress,
      startAngle: this.startAngle,
      direction: this.direction,
      // ZERO, always. The preview is sparks and nothing else: no filament, no
      // glow, no closed circle. The ring is what a real portal looks like, and
      // showing it before the gesture has been recognised claims something that
      // has not happened yet. Departure lights it at the handover.
      energy: 0,
      spin: ((now - this.t0) / 1000) * 0.15,
      dissipate: 0,
      open: 0,
      showVision: false,
      visionFade: 1,
      lens: 0,
      swirl: 0,
      zoom: 1,
      hole: 0,
      fade: 0,
    };
    this.overlay.render(state, this.sparks);
  };

  private blankState(now: number): RenderState {
    return {
      timeSec: (now - this.t0) / 1000,
      cx: this.cx,
      cy: this.cy,
      radius: this.radius,
      progress: this.progress,
      startAngle: this.startAngle,
      direction: this.direction,
      energy: 0,
      spin: 0,
      dissipate: 1,
      open: 0,
      showVision: false,
      visionFade: 1,
      lens: 0,
      swirl: 0,
      zoom: 1,
      hole: 0,
      fade: 0,
    };
  }
}
