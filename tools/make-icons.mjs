/**
 * Generates the extension icons from the source logo.
 *
 *   npm run icons     public/icons/logo.png -> icon-{16,32,48,128}.png
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
 * NOTE on the source: the logo as delivered was an ICO file with a .png
 * extension. Chrome will not decode that, which is why the icon was blank in
 * chrome://extensions. `assets/logo.png` is the real 256x256 PNG lifted out of
 * that container; `assets/logo-original.ico` is the file as delivered, kept
 * under its true extension and shipped nowhere.
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
 * The logo is a disc that already touches the canvas edge, so there is no
 * transparent margin to trim automatically — but there IS a band of flat dark
 * ground between the canvas edge and the amber ring. Measured on the 256px
 * source, the ring's outer edge sits at x=13, so that band is 13/256 of the
 * width. Cropping it makes the ring 11% larger inside the same icon box, which
 * is the whole of what can be done about "the toolbar icon is too small":
 * Chrome fixes the slot at 16 logical pixels, so the only lever is how much of
 * those pixels the artwork occupies.
 *
 * Set to 0 if the logo is ever replaced with one that is already tight.
 */
const TRIM = 13 / 256;

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
 * Box filter, in PREMULTIPLIED alpha.
 *
 * Averaging straight RGBA drags the colour of fully transparent pixels into the
 * result, so a logo on a transparent field picks up a dark halo everywhere its
 * edge is soft. Premultiplying first is the whole difference between a clean
 * 16px icon and a smudged one.
 */
function resize(src, sw, sh, d) {
  const out = new Uint8Array(d * d * 4);
  const sx = sw / d;
  const sy = sh / d;

  for (let y = 0; y < d; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < d; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al;
          g += src[i + 1] * al;
          b += src[i + 2] * al;
          a += src[i + 3];
          n++;
        }
      }

      const o = (y * d + x) * 4;
      const am = a / n;
      const un = am > 0 ? 255 / am : 0;
      out[o] = Math.min(255, Math.round((r / n) * un));
      out[o + 1] = Math.min(255, Math.round((g / n) * un));
      out[o + 2] = Math.min(255, Math.round((b / n) * un));
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
