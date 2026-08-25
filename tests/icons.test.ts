import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The shipped icons are real PNGs, at the sizes the manifest claims.
 *
 * `tools/make-icons.mjs` validates its *source* — it refuses a master that is
 * secretly an ICO — but nothing validated its *output*, and the output is the
 * part that ships. Twice now an icon has been replaced by hand, outside the
 * generator, with a .ico file carrying a .png name: Chrome refuses to decode it
 * and draws nothing, with no error anywhere to say why. The 16 and 32 kept
 * working, so the toolbar looked fine and only the extensions card was blank —
 * which is exactly the kind of half-failure nobody goes looking for.
 *
 * This is the cheap check that closes that door: signature, dimensions, and the
 * one colour format `decodePng` can read back in.
 */

const ICONS = resolve(__dirname, "..", "public", "icons");
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The four the manifest declares, under both `icons` and `action.default_icon`. */
const SIZES = [16, 32, 48, 128];

describe("shipped icons", () => {
  for (const size of SIZES) {
    it(`icon-${size}.png is a ${size}x${size} 8-bit RGBA PNG`, () => {
      const buf = readFileSync(resolve(ICONS, `icon-${size}.png`));

      // An ICO opens with 00 00 01 00, which is what slipped through before.
      expect([...buf.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
      expect(buf.toString("ascii", 12, 16)).toBe("IHDR");
      expect(buf.readUInt32BE(16)).toBe(size);
      expect(buf.readUInt32BE(20)).toBe(size);
      expect(buf[24]).toBe(8); // bit depth
      expect(buf[25]).toBe(6); // colour type: RGBA
      expect(buf[28]).toBe(0); // interlace: none
    });
  }
});
