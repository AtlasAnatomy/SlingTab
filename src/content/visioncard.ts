import { toCssColor } from "./renderer/types";

/**
 * The disc's stand-in when the destination refuses to be framed AND has no
 * og:image — which, before this existed, meant a 64px favicon stretched across
 * the whole portal. A logo blown up 8x and then blurred by `vision.frag` reads
 * as a smear of colour and tells you nothing about where you are going.
 *
 * So: compose a card instead. Favicon at its own size, hostname in large type,
 * page title under it, over a wash of the destination's theme colour.
 *
 * Two constraints shape the layout, both of them from `vision.frag`:
 *
 *  - The image is mapped to COVER a circle, so anything outside the inscribed
 *    circle is cropped. Everything here stays well inside it.
 *  - The blur grows as `nd^1.6` from the centre — roughly 4 texture pixels at
 *    the middle and 16 by half radius. Type has to be large and bold, and there
 *    is no point putting a description on it. That haze is deliberate ("a crisp
 *    preview reads as a thumbnail in a circle"), so the card leans into it and
 *    carries three things at most.
 */

/** Square, because the disc is round and cover-mapping a square never crops. */
const SIZE = 512;
const C = SIZE / 2;

const FONT_STACK = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/** Radius inside which type stays legible through the progressive blur. */
const TEXT_HALF_WIDTH = 158;

export interface VisionCardInput {
  /** Already stripped of "www.". */
  hostname: string;
  title: string | null;
  icon: ImageBitmap | null;
  /** Destination theme colour, linear-ish sRGB in 0..1, as the renderer holds it. */
  rgb: readonly [number, number, number];
}

/** Truncate to fit `max` px at the current font, with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
             text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** Greedy wrap to at most `maxLines`, the last one ellipsised. */
function wrap(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
              text: string, max: number, maxLines: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= max) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);

  if (!lines.length) return [];
  // Whatever did not fit is folded into the last line as an ellipsis.
  const consumed = lines.join(" ");
  if (consumed.length < text.length) {
    lines[lines.length - 1] = fit(ctx, `${lines[lines.length - 1]!} …`, max);
  }
  return lines.map((l) => fit(ctx, l, max));
}

function draw(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  input: VisionCardInput,
): void {
  const tint = toCssColor(input.rgb);

  // Ground: the theme colour lifted at the centre, falling to near-black. The
  // shader tints toward the same colour again at the rim, so this only has to
  // establish that the destination has a colour at all.
  const bg = ctx.createRadialGradient(C, C * 0.86, 0, C, C, C * 1.15);
  bg.addColorStop(0, tint);
  bg.addColorStop(0.55, tint);
  bg.addColorStop(1, "#070605");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // A darkening pass under the type. Theme colours are frequently bright (a lot
  // of sites ship #ffffff), and white text on white is the failure mode.
  const shade = ctx.createLinearGradient(0, C * 0.5, 0, SIZE);
  shade.addColorStop(0, "rgba(6, 4, 3, 0)");
  shade.addColorStop(1, "rgba(6, 4, 3, 0.86)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Favicon, at a size it was actually drawn for, on a rounded plate so a
  // transparent or white-on-white icon still reads.
  const iconY = 168;
  const plate = 116;
  ctx.save();
  ctx.fillStyle = "rgba(255, 244, 226, 0.10)";
  ctx.strokeStyle = "rgba(255, 214, 150, 0.30)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(C - plate / 2, iconY - plate / 2, plate, plate, 26);
  ctx.fill();
  ctx.stroke();
  if (input.icon) {
    const s = 74;
    ctx.drawImage(input.icon, C - s / 2, iconY - s / 2, s, s);
  } else {
    ctx.fillStyle = "rgba(255, 226, 190, 0.92)";
    ctx.font = `700 56px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((input.hostname[0] ?? "?").toUpperCase(), C, iconY + 2);
  }
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Hostname: the one thing that must survive the blur, so it is the largest
  // and the brightest element on the card.
  ctx.font = `700 44px ${FONT_STACK}`;
  ctx.fillStyle = "#fff6e8";
  ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
  ctx.shadowBlur = 18;
  ctx.fillText(fit(ctx, input.hostname, TEXT_HALF_WIDTH * 2), C, 282);

  if (input.title) {
    ctx.font = `500 27px ${FONT_STACK}`;
    ctx.fillStyle = "rgba(255, 232, 205, 0.86)";
    ctx.shadowBlur = 12;
    const lines = wrap(ctx, input.title, TEXT_HALF_WIDTH * 2, 2);
    lines.forEach((line, i) => ctx.fillText(line, C, 334 + i * 36));
  }
  ctx.shadowBlur = 0;
}

/**
 * Returns null rather than throwing: a missing card costs the tinted wash the
 * shader already draws without a texture, and must never cost the portal.
 */
export async function composeVisionCard(
  input: VisionCardInput,
): Promise<ImageBitmap | null> {
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(SIZE, SIZE);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        draw(ctx, input);
        return canvas.transferToImageBitmap();
      }
    }
    // Chrome 120+ always has OffscreenCanvas, but a 2D context can still be
    // refused under memory pressure, and this path costs three lines.
    const el = document.createElement("canvas");
    el.width = SIZE;
    el.height = SIZE;
    const ctx = el.getContext("2d");
    if (!ctx) return null;
    draw(ctx, input);
    return await createImageBitmap(el);
  } catch {
    return null;
  }
}
