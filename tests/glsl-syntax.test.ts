import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "@shaderfrog/glsl-parser";
import { describe, expect, it } from "vitest";

/**
 * Real GLSL parsing, in Node, with no browser.
 *
 * This does not replace a driver compile (it will not catch a type mismatch or
 * an undeclared identifier), but it does catch every syntax error — which is
 * the failure that turns the whole feature into "nothing happens", because a
 * throw inside the GLRenderer constructor degrades the portal to a plain
 * navigation.
 */

const root = resolve(__dirname, "..");
const SHADERS = [
  "src/shaders/ring.vert",
  "src/shaders/ring.frag",
  "src/shaders/vision.frag",
  "src/shaders/lens.frag",
  "src/shaders/spark.vert",
  "src/shaders/spark.frag",
] as const;

describe("GLSL syntax", () => {
  for (const path of SHADERS) {
    it(`${path} parses`, () => {
      const src = readFileSync(resolve(root, path), "utf8");
      expect(() => parse(src, { quiet: true })).not.toThrow();
    });
  }

  it("every function used is defined in the same translation unit", () => {
    // No #include machinery here, so a helper referenced but not defined is a
    // link error at runtime and nothing else would catch it.
    const builtins = new Set([
      "main", "texture", "mix", "clamp", "smoothstep", "step", "length", "atan",
      "mod", "floor", "fract", "dot", "exp", "pow", "cos", "sin", "sqrt", "abs",
      "max", "min", "sign", "normalize", "vec2", "vec3", "vec4", "ivec2", "mat2",
      "mat3", "mat4", "float", "int", "bool", "discard", "return", "if", "for",
      "while", "distance", "reflect", "inversesqrt", "degrees", "radians",
      // Not calls: qualifiers and control flow that the regex sees as `name(`.
      "layout", "switch",
    ]);

    for (const path of SHADERS) {
      const src = readFileSync(resolve(root, path), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");

      const defined = new Set(
        [...src.matchAll(/^\s*\w+\s+(\w+)\s*\([^)]*\)\s*\{/gm)].map((m) => m[1]!),
      );
      const called = new Set(
        [...src.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1]!),
      );

      for (const name of called) {
        if (builtins.has(name) || defined.has(name)) continue;
        throw new Error(`${path}: calls ${name}() which is neither builtin nor defined`);
      }
    }
  });
});