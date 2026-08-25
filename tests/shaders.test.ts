import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * We cannot compile GLSL in Node, so this guards the two failure modes that
 * actually bite in practice and are otherwise invisible until runtime:
 *
 *  1. A uniform name drifting between gl.ts and the shader. The GL call then
 *     silently no-ops against a null location and the effect just... stops.
 *  2. pow(x, 2.0) creeping back in on a term that straddles zero. pow() is
 *     undefined for a negative base in GLSL ES; several drivers return NaN,
 *     which blows out the whole fragment.
 */

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const SHADERS = {
  "ring.vert": read("src/shaders/ring.vert"),
  "ring.frag": read("src/shaders/ring.frag"),
  "vision.frag": read("src/shaders/vision.frag"),
  "lens.frag": read("src/shaders/lens.frag"),
  "spark.vert": read("src/shaders/spark.vert"),
  "spark.frag": read("src/shaders/spark.frag"),
};

const GL_TS = read("src/content/renderer/gl.ts");

/** Comments talk about pow() and uniforms; only the code counts. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("shader sources", () => {
  it("every shader declares #version 300 es on line 1", () => {
    for (const [name, src] of Object.entries(SHADERS)) {
      expect(src.split("\n")[0]!.trim(), name).toBe("#version 300 es");
    }
  });

  it("every fragment shader sets a float precision", () => {
    for (const [name, src] of Object.entries(SHADERS)) {
      if (!name.endsWith(".frag")) continue;
      expect(src, name).toMatch(/precision\s+(lowp|mediump|highp)\s+float\s*;/);
    }
  });

  it("no Gaussian whose argument is clamped to zero", () => {
    // exp(-sq(max(0.0, x) / w)) is a trap. It reads as "protect the falloff",
    // but where x < 0 the clamp makes it exp(0) = 1 — full brightness — instead
    // of zero. That is what lit the entire un-traced ring while the hand was
    // still drawing it: the leading-edge term is added outside the arc mask, so
    // nothing downstream could correct it. Gate on the sign, do not clamp.
    for (const [name, src] of Object.entries(SHADERS)) {
      expect(code(src), `${name}: clamped Gaussian argument`).not.toMatch(
        /exp\s*\(\s*-\s*sq\s*\(\s*max\s*\(\s*0\.0\s*,/,
      );
    }
  });

  it("every additive ring term is inside the arc mask", () => {
    // `arc` is what limits the ring to the part the user has actually swept.
    // Any term summed after it escapes that limit.
    const body = code(SHADERS["ring.frag"]);
    const m = /ring\s*=\s*ring\s*\*\s*arc([^;]*);/.exec(body);
    expect(m, "could not find the arc-masking line in ring.frag").not.toBeNull();
    const trailing = m![1]!;
    // Anything added out here must itself be gated on the sweep.
    if (trailing.trim()) {
      expect(trailing, "term added outside the arc mask must be sweep-gated")
        .toMatch(/lead/);
      expect(code(SHADERS["ring.frag"]), "the lead term must be sign-gated")
        .toMatch(/step\s*\(\s*0\.0\s*,\s*behind\s*\)/);
    }
  });

  it("no pow() on a base that can go negative", () => {
    // ring.frag squares distance deltas everywhere; it must use sq(), not pow().
    expect(code(SHADERS["ring.frag"])).not.toMatch(/\bpow\s*\(/);
    // lens.frag squares a signed distance from the rim; same rule.
    expect(code(SHADERS["lens.frag"])).not.toMatch(/\bpow\s*\(/);

    // Everywhere else, pow() is only allowed on a base that is provably >= 0.
    // Add to this list only with the reason, never to make a failure go away.
    const provablyNonNegative: Record<string, string[]> = {
      // nd = clamp(d / uRadius, 0.0, 1.0)
      "vision.frag": ["nd"],
      // across = 1.0 - abs(vSide), guarded by `if (across <= 0.0) discard`
      // along  = 1.0 - vT, and vT interpolates the ribbon buffer's [0,1] range
      "spark.frag": ["across", "along"],
    };

    for (const name of ["vision.frag", "spark.frag"] as const) {
      const bases = [...code(SHADERS[name]).matchAll(/\bpow\s*\(\s*([^,]+),/g)].map((m) =>
        m[1]!.trim(),
      );
      for (const base of bases) {
        expect(
          provablyNonNegative[name]!.includes(base),
          `${name}: pow(${base}, ...) — base not on the proven-non-negative list`,
        ).toBe(true);
      }
    }
  });
});

describe("gl.ts <-> shader uniform agreement", () => {
  // Pull each `uniforms(gl, this.xProg, [ ... ])` list straight out of gl.ts so
  // this test cannot go stale.
  function uniformList(prog: string): string[] {
    const re = new RegExp(
      `uniforms\\(gl,\\s*this\\.${prog},\\s*\\[([\\s\\S]*?)\\]\\)`,
      "m",
    );
    const m = re.exec(GL_TS);
    expect(m, `could not find uniform list for ${prog}`).not.toBeNull();
    return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  }

  const declared = (src: string): Set<string> =>
    new Set(
      [...src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]!),
    );

  it("ring program", () => {
    const names = uniformList("ringProg");
    expect(names.length).toBeGreaterThan(5);
    const have = declared(SHADERS["ring.frag"]);
    for (const n of names) expect(have.has(n), `ring.frag missing ${n}`).toBe(true);
  });

  it("lens program", () => {
    const names = uniformList("lensProg");
    expect(names.length).toBeGreaterThan(8);
    const have = declared(SHADERS["lens.frag"]);
    for (const n of names) expect(have.has(n), `lens.frag missing ${n}`).toBe(true);
  });

  it("vision program", () => {
    const names = uniformList("visionProg");
    const have = declared(SHADERS["vision.frag"]);
    for (const n of names) expect(have.has(n), `vision.frag missing ${n}`).toBe(true);
  });

  it("spark program", () => {
    const names = uniformList("sparkProg");
    const have = new Set([
      ...declared(SHADERS["spark.vert"]),
      ...declared(SHADERS["spark.frag"]),
    ]);
    for (const n of names) expect(have.has(n), `spark shaders missing ${n}`).toBe(true);
  });

  it("spark instancing matches the vertex attribute layout", () => {
    // 0 = ribbon vertex (vec2, per-vertex), 1 = data (vec4), 2 = misc (vec2),
    // 3 = velocity (vec2). 1-3 are per-instance.
    const v = SHADERS["spark.vert"];
    expect(v).toMatch(/layout\(location\s*=\s*0\)\s+in\s+vec2\s+aCorner/);
    expect(v).toMatch(/layout\(location\s*=\s*1\)\s+in\s+vec4\s+aData/);
    expect(v).toMatch(/layout\(location\s*=\s*2\)\s+in\s+vec2\s+aMisc/);
    expect(v).toMatch(/layout\(location\s*=\s*3\)\s+in\s+vec2\s+aVel/);

    expect(GL_TS).toMatch(/vertexAttribPointer\(0,\s*2,\s*gl\.FLOAT/);
    expect(GL_TS).toMatch(/vertexAttribPointer\(1,\s*4,\s*gl\.FLOAT/);
    expect(GL_TS).toMatch(/vertexAttribPointer\(2,\s*2,\s*gl\.FLOAT/);
    expect(GL_TS).toMatch(/vertexAttribPointer\(3,\s*2,\s*gl\.FLOAT/);

    for (const loc of [1, 2, 3]) {
      expect(GL_TS, `attribute ${loc} must be per-instance`)
        .toMatch(new RegExp(`vertexAttribDivisor\\(${loc},\\s*1\\)`));
    }
    // Attribute 0 must NOT be instanced — it is the ribbon's own geometry.
    expect(GL_TS).not.toMatch(/vertexAttribDivisor\(0,/);

    // The draw call must cover every ribbon segment, not a single quad.
    expect(GL_TS).toMatch(/drawArraysInstanced\(\s*gl\.TRIANGLES,\s*0,\s*TRAIL_SEGMENTS \* 6/);
  });
});