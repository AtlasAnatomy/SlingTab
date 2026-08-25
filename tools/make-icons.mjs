/**
 * Generates the extension icons from the source logo.
 *
 *   npm run icons     assets/logo.png -> public/icons/icon-{16,32,48,128}.png
 *
 * This used to render a procedural ring instead. It now downsamples the real
 * logo, because the extension has one — and because a generator that ignores
 * the logo is a loaded gun: running `npm run icons` would silently overwrite
 * the shipped icons with something else entirely.
 *
 * No image library. Decoding, resampling and encoding are all here, which is
 * about a hundred lines and removes a dependency from a project that has none
 * at runtime and almost none at build time.
 *
 * NOTE on the source: `assets/logo.png` is the master, and it has to be a
 * real PNG — 8-bit RGBA, non-interlaced. The first logo arrived as an ICO file
 * with a .png extension, Chrome refused to decode it, and the icon was blank in
 * chrome://extensions with nothing said about why; `decodePng` checks the
 * signature and says so now. `assets/logo-original.ico` is that first delivery,
 * kept under its true extension, superseded, and shipped nowhere.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_DIR = resolve(ROOT, "public", "icons");
/*
 * The source lives OUTSIDE public/ on purpose. Anything under public/ is copied
 * verbatim into the published package, and a 256px master shipped alongside the
 * four sizes generated from it is 115 KB of payload nothing references.
 */
const SOURCE = resolve(ROOT, "assets", "logo.png");
const SIZES = [16, 32, 48, 128];

/**
 * Fraction cropped from each edge before resampling.
 *
 * ZERO, and it has to stay zero unless the artwork changes shape.
 *
 * This was 51/1254 — the flat black band between the canvas edge and the amber
 * ring on the master. Cropping it made the ring 9% larger inside the same icon
 * box, which is the only lever there is on "the toolbar icon is too small",
 * since Chrome fixes the slot at 16 logical pixels.
 *
 * It also squared off the corners, and that was the wrong trade. The master is
 * a rounded square with a 91px radius — 7.3% of the side — so a 51px crop cuts
 * well inside the arc and the icon lands as a hard-cornered black tile. At 128
 * it is obvious; at 16 it is still the difference between a rounded badge and a
 * black square. The rounding is part of the mark, not packaging around it.
 *
 * The crop had a second, quieter job: 1254 - 2*51 = 1152, which is 72*16,
 * 36*32, 24*48 and 9*128, so every output pixel was the average of one whole
 * block of source pixels with no bucket a row wider than its neighbour. At
 * TRIM = 0 the ratios are 78.375, 39.1875, 26.125 and 9.797 — all uneven. That
 * used to matter. It no longer does: `resize` weights partial source pixels by
 * how much of them the output pixel actually covers, so an uneven bucket is
 * averaged correctly instead of being rounded to a whole pixel too many.
 *
 * Set it non-zero only for artwork that is already tight to its edges AND has
 * no rounded corner to lose, and measure the band again if the logo is replaced.
 */
const TRIM = 0;

// ------------------------------------------------------------ PNG encoding

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `rgba` is a Uint8Array of size*size*4. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter byte (0 = None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (size * 4 + 1);
    raw[off] = 0;
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), off + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ PNG decoding

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Handles exactly what the source is: 8-bit RGBA, non-interlaced. */
function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => buf[i] === b)) {
    throw new Error(
      `${SOURCE} is not a PNG. A file with a .png name can still be an ICO or a ` +
        `JPEG, and Chrome will refuse it — which is exactly how the icon went blank.`,
    );
  }

  let width = 0;
  let height = 0;
  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(
          `unsupported PNG: depth ${depth}, colour type ${colour}, interlace ` +
            `${interlace}. Re-export the logo as non-interlaced 8-bit RGBA.`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    off += 12 + len;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * bpp);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const v = line[x];
      out[y * stride + x] =
        filter === 0 ? v
        : filter === 1 ? (v + a) & 0xff
        : filter === 2 ? (v + b) & 0xff
        : filter === 3 ? (v + ((a + b) >> 1)) & 0xff
        : (v + paeth(a, b, c)) & 0xff;
    }
  }
  return { width, height, rgba: out };
}

// ------------------------------------------------------------- resampling

/** Crop `fraction` off every edge, before any resampling. */
function crop(src, w, h, fraction) {
  const dx = Math.round(w * fraction);
  const dy = Math.round(h * fraction);
  const cw = w - dx * 2;
  const ch = h - dy * 2;
  if (cw <= 0 || ch <= 0) return { rgba: src, width: w, height: h };

  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const from = ((y + dy) * w + dx) * 4;
    out.set(src.subarray(from, from + cw * 4), y * cw * 4);
  }
  return { rgba: out, width: cw, height: ch };
}

/**
 * Area-average filter, in PREMULTIPLIED alpha.
 *
 * Two things this has to get right.
 *
 * PREMULTIPLIED: averaging straight RGBA drags the colour of fully transparent
 * pixels into the result, so a logo on a transparent field picks up a dark halo
 * everywhere its edge is soft. Premultiplying first is the whole difference
 * between a clean 16px icon and a smudged one.
 *
 * WEIGHTED: the output pixel covers the source span [x*sx, (x+1)*sx), and that
 * span rarely lands on whole source pixels. Counting every touched pixel once
 * (a plain box filter) gives some output pixels one source row more than their
 * neighbours, which on a ring two pixels thick at 16px is a visibly wrong pixel.
 * Each source pixel is therefore weighted by how much of it the output pixel
 * actually covers, so the result no longer depends on the source size dividing
 * evenly by the target — which is what let TRIM go to zero and the rounded
 * corners come back.
 */
function resize(src, sw, sh, d) {
  const out = new Uint8Array(d * d * 4);
  const sx = sw / d;
  const sy = sh / d;

  for (let y = 0; y < d; y++) {
    const yStart = y * sy;
    const yEnd = (y + 1) * sy;
    const y0 = Math.floor(yStart);
    const y1 = Math.min(sh, Math.ceil(yEnd));

    for (let x = 0; x < d; x++) {
      const xStart = x * sx;
      const xEnd = (x + 1) * sx;
      const x0 = Math.floor(xStart);
      const x1 = Math.min(sw, Math.ceil(xEnd));

      let r = 0, g = 0, b = 0, a = 0, w = 0;
      for (let yy = y0; yy < y1; yy++) {
        const wy = Math.min(yy + 1, yEnd) - Math.max(yy, yStart);
        if (wy <= 0) continue;
        for (let xx = x0; xx < x1; xx++) {
          const wx = Math.min(xx + 1, xEnd) - Math.max(xx, xStart);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const i = (yy * sw + xx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al * weight;
          g += src[i + 1] * al * weight;
          b += src[i + 2] * al * weight;
          a += src[i + 3] * weight;
          w += weight;
        }
      }

      const o = (y * d + x) * 4;
      const am = a / w;
      const un = am > 0 ? 255 / am : 0;
      out[o] = Math.min(255, Math.round((r / w) * un));
      out[o + 1] = Math.min(255, Math.round((g / w) * un));
      out[o + 2] = Math.min(255, Math.round((b / w) * un));
      out[o + 3] = Math.round(am);
    }
  }
  return out;
}

// ------------------------------------------------------------------- main

const decoded = decodePng(readFileSync(SOURCE));
const source = TRIM > 0
  ? crop(decoded.rgba, decoded.width, decoded.height, TRIM)
  : decoded;

mkdirSync(ICON_DIR, { recursive: true });

for (const size of SIZES) {
  const rgba =
    size === source.width && size === source.height
      ? source.rgba
      : resize(source.rgba, source.width, source.height, size);
  writeFileSync(resolve(ICON_DIR, `icon-${size}.png`), encodePng(rgba, size));
  console.log(`icon-${size}.png`);
}
console.log(
  `from ${decoded.width}x${decoded.height} ${SOURCE}` +
    (TRIM > 0 ? ` (cropped ${(TRIM * 100).toFixed(1)}% per edge -> ${source.width}px)` : ""),
);
