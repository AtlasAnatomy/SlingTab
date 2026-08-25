import { SPARK_TUNING, type SparkSystem } from "./sparks";
import { DEFAULT_LOOK, type LookParams, type PortalRenderer, type RenderState } from "./types";

/**
 * Graceful degradation, not a second implementation held at parity.
 * No runes, no chromatic aberration, no grain — gradients, `filter: blur()` and
 * `globalCompositeOperation = "lighter"`.
 */
export class Canvas2DRenderer implements PortalRenderer {
  readonly kind = "canvas2d" as const;

  private ctx: CanvasRenderingContext2D;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private bitmap: ImageBitmap | null = null;
  private page: ImageBitmap | null = null;
  private tintCss = "rgb(11, 10, 9)";
  private tint: [number, number, number] = [0.043, 0.039, 0.035];
  private look: LookParams = { ...DEFAULT_LOOK };
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssW = Math.max(1, cssWidth);
    this.cssH = Math.max(1, cssHeight);
    this.dpr = Math.min(2, Math.max(1, dpr));
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** The fallback honours thickness and glow; grain, dust and runes are the
   *  parts it never had. */
  setLook(patch: Partial<LookParams>): void {
    this.look = { ...this.look, ...patch };
  }

  setTint(rgb: readonly [number, number, number]): void {
    this.tint = [rgb[0], rgb[1], rgb[2]];
    const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    this.tintCss = `rgb(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])})`;
  }

  setVisionImage(bitmap: ImageBitmap | null): void {
    this.bitmap = bitmap;
  }

  /** No warp here — Canvas2D cannot displace per pixel at a usable frame rate.
   *  The frozen page plus the growing hole still carries the dive. */
  setPageImage(bitmap: ImageBitmap | null): void {
    this.page = bitmap;
  }

  private drawLens(s: RenderState): void {
    const ctx = this.ctx;
    if (!this.page || s.lens <= 0.0001) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.cssW, this.cssH);
    ctx.arc(s.cx, s.cy, Math.max(0, s.hole), 0, Math.PI * 2, true);
    ctx.clip("evenodd");

    const z = Math.max(0.001, s.zoom);
    const w = this.cssW * z;
    const h = this.cssH * z;
    ctx.drawImage(this.page, s.cx - (s.cx * z), s.cy - (s.cy * z), w, h);

    if (s.fade > 0.001) {
      ctx.globalAlpha = Math.min(1, s.fade);
      ctx.fillStyle = this.tintCss;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  render(s: RenderState, sparks: SparkSystem): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    const dpr = this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    const R = s.radius * (1 + s.dissipate * 0.16);
    const energy = s.energy * (1 - s.dissipate * 0.85);

    this.drawLens(s);
    if (s.showVision && s.open > 0.001 && s.visionFade > 0.001) this.drawVision(s);

    ctx.globalCompositeOperation = "lighter";
    this.drawRing(s, R, energy);
    this.drawSparks(sparks);

    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawVision(s: RenderState): void {
    const ctx = this.ctx;
    const Ro = s.radius * s.open;

    ctx.save();
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, Ro, 0, Math.PI * 2);
    ctx.clip();

    // Everything in this pass sits above the framed page, so the whole pass
    // fades out together when the frame takes over.
    ctx.globalAlpha = Math.max(0, Math.min(1, s.visionFade));

    ctx.fillStyle = this.tintCss;
    ctx.fillRect(s.cx - Ro, s.cy - Ro, Ro * 2, Ro * 2);

    if (this.bitmap) {
      const bw = this.bitmap.width;
      const bh = this.bitmap.height;
      const scale = Math.max((Ro * 2) / bw, (Ro * 2) / bh);
      const dw = bw * scale;
      const dh = bh * scale;
      const pass = ctx.globalAlpha;
      ctx.globalAlpha = pass * 0.9;
      // One heavy blur pass. Progressive blur is a WebGL-only nicety; here the
      // radial tint gradient below carries the "distance" read instead.
      ctx.filter = `blur(${Math.max(2, Ro * 0.05)}px) saturate(1.15)`;
      ctx.drawImage(this.bitmap, s.cx - dw / 2, s.cy - dh / 2, dw, dh);
      ctx.filter = "none";
      ctx.globalAlpha = pass;
    }

    // Rim tint + vignette.
    const g = ctx.createRadialGradient(s.cx, s.cy, Ro * 0.1, s.cx, s.cy, Ro);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.55, `${this.tintCss.replace("rgb(", "rgba(").replace(")", ", 0.35)")}`);
    g.addColorStop(1, `${this.tintCss.replace("rgb(", "rgba(").replace(")", ", 0.92)")}`);
    ctx.fillStyle = g;
    ctx.fillRect(s.cx - Ro, s.cy - Ro, Ro * 2, Ro * 2);

    // Additive golden haze.
    ctx.globalCompositeOperation = "lighter";
    const haze = ctx.createRadialGradient(s.cx, s.cy, Ro * 0.2, s.cx, s.cy, Ro);
    haze.addColorStop(0, "rgba(255, 205, 130, 0.10)");
    haze.addColorStop(0.7, "rgba(255, 150, 55, 0.10)");
    haze.addColorStop(1, "rgba(255, 120, 30, 0.35)");
    ctx.fillStyle = haze;
    ctx.fillRect(s.cx - Ro, s.cy - Ro, Ro * 2, Ro * 2);

    ctx.restore();
  }

  private drawRing(s: RenderState, R: number, energy: number): void {
    const ctx = this.ctx;
    if (energy <= 0.001) return;

    const sweep = s.progress * Math.PI * 2;
    const from = s.startAngle;
    const to = s.startAngle + sweep * s.direction;
    const ccw = s.direction < 0;

    ctx.save();
    ctx.globalAlpha = Math.min(1, energy);

    // Outer glow.
    ctx.lineWidth = Math.max(6, R * 0.13);
    ctx.strokeStyle = "rgba(194, 65, 12, 0.35)";
    ctx.shadowBlur = Math.max(10, R * 0.30 * (this.look.glow / 0.45));
    ctx.shadowColor = "rgba(255, 138, 31, 0.85)";
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, R, from, to, ccw);
    ctx.stroke();

    // Mid body.
    ctx.shadowBlur = Math.max(6, R * 0.14);
    ctx.lineWidth = Math.max(2.5, R * this.look.thickness * 3.2);
    ctx.strokeStyle = "rgba(255, 138, 31, 0.8)";
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, R, from, to, ccw);
    ctx.stroke();

    // Hot core line.
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1, R * this.look.thickness);
    ctx.strokeStyle = "rgba(255, 210, 122, 0.95)";
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, R, from, to, ccw);
    ctx.stroke();

    // Inscribed polygon, faint. Only once the ring has actually closed — while
    // the arc is still being traced there is nothing for it to be inscribed in.
    const n = 7;
    const rp = R * 0.6;
    if (s.progress < 0.995) {
      ctx.restore();
      return;
    }
    ctx.globalAlpha = Math.min(1, energy) * 0.28;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 190, 110, 0.9)";
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = s.spin * 0.22 + (i / n) * Math.PI * 2;
      const x = s.cx + Math.cos(a) * rp;
      const y = s.cy + Math.sin(a) * rp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Leading-edge flare.
    if (s.progress > 0.02 && s.progress < 0.98) {
      const lx = s.cx + Math.cos(to) * R;
      const ly = s.cy + Math.sin(to) * R;
      const flare = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(8, R * 0.18));
      flare.addColorStop(0, "rgba(255, 235, 190, 0.9)");
      flare.addColorStop(1, "rgba(255, 138, 31, 0)");
      ctx.globalAlpha = Math.min(1, energy);
      ctx.fillStyle = flare;
      ctx.beginPath();
      ctx.arc(lx, ly, Math.max(8, R * 0.18), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Streaks, not dots. Round sparks are the single thing that makes this read
   * as "glowing confetti" instead of as embers, so even the fallback draws the
   * motion smear — a tapered line along the velocity with a hot head.
   */
  private drawSparks(sparks: SparkSystem): void {
    const ctx = this.ctx;
    const n = sparks.count;
    if (n === 0) return;

    ctx.save();
    ctx.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const x = sparks.packed[o]!;
      const y = sparks.packed[o + 1]!;
      const r = sparks.packed[o + 2]!;
      const a = sparks.packed[o + 3]!;
      if (a <= 0.02) continue;

      const vx = sparks.vels[i * 2]!;
      const vy = sparks.vels[i * 2 + 1]!;
      const speed = Math.hypot(vx, vy);
      const t = sparks.tints[i]!;
      const hot = Math.round(150 + t * 90);

      if (speed > 40) {
        // Same reconstructed parabola as the WebGL ribbon:
        //   p(-tau) = p - v*tau + 0.5*g*tau^2
        // walked backwards as a polyline. Straight segments here would put the
        // fallback visibly out of step with the real renderer.
        const trail = Math.min(this.look.streak, sparks.ages[i]!);
        const g = SPARK_TUNING.gravity;
        const STEPS = 6;

        const tailX = x - vx * trail;
        const tailY = y - vy * trail + 0.5 * g * trail * trail;
        const grad = ctx.createLinearGradient(tailX, tailY, x, y);
        grad.addColorStop(0, "rgba(194, 65, 12, 0)");
        grad.addColorStop(0.7, `rgba(255, ${hot}, 60, ${a * 0.5})`);
        grad.addColorStop(1, `rgba(255, 244, 220, ${a})`);

        ctx.strokeStyle = grad;
        ctx.lineWidth = Math.max(0.7, r * 1.2);
        ctx.beginPath();
        for (let k = STEPS; k >= 0; k--) {
          const tau = (k / STEPS) * trail;
          const px = x - vx * tau;
          const py = y - vy * tau + 0.5 * g * tau * tau;
          if (k === STEPS) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      } else {
        const rad = Math.max(1, r * 1.8);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, `rgba(255, 244, 220, ${a})`);
        g.addColorStop(0.45, `rgba(255, ${hot}, 45, ${a * 0.5})`);
        g.addColorStop(1, "rgba(194, 65, 12, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  dispose(): void {
    this.disposed = true;
    this.bitmap = null;
  }
}