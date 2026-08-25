import ringVertSrc from "../../shaders/ring.vert?raw";
import ringFragSrc from "../../shaders/ring.frag?raw";
import visionFragSrc from "../../shaders/vision.frag?raw";
import lensFragSrc from "../../shaders/lens.frag?raw";
import sparkVertSrc from "../../shaders/spark.vert?raw";
import sparkFragSrc from "../../shaders/spark.frag?raw";
import { MAX_SPARKS, SPARK_TUNING, type SparkSystem } from "./sparks";
import {
  DEFAULT_LOOK,
  type LookParams,
  type PortalRenderer,
  type RenderState,
} from "./types";

/**
 * Segments per spark ribbon. More gives a smoother curve on the long whips; the
 * cost is linear and trivial (2200 sparks * 10 segments * 6 verts is ~130k
 * vertices per frame, which is nothing for a GPU).
 */
const TRAIL_SEGMENTS = 8;

/**
 * Static geometry for one ribbon: `segments` quads laid end to end along the
 * trail. x = normalised distance along the trail (0 head, 1 tail), y = side.
 * The vertex shader turns each (x, y) into a point on that particle's own
 * reconstructed path, so this buffer is uploaded once and never changes.
 */
function buildRibbon(segments: number): Float32Array {
  const out = new Float32Array(segments * 6 * 2);
  let o = 0;
  const push = (t: number, side: number) => {
    out[o++] = t;
    out[o++] = side;
  };
  for (let s = 0; s < segments; s++) {
    const t0 = s / segments;
    const t1 = (s + 1) / segments;
    push(t0, -1); push(t1, -1); push(t0, 1);
    push(t0, 1); push(t1, -1); push(t1, 1);
  }
  return out;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("createProgram failed");
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program link failed: ${log}`);
  }
  return p;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Uniforms {
  const out: Uniforms = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}

export class GLRenderer implements PortalRenderer {
  readonly kind = "webgl2" as const;

  private gl: WebGL2RenderingContext;
  private quad: WebGLBuffer;
  private vaoFull: WebGLVertexArrayObject;

  private ringProg: WebGLProgram;
  private ringU: Uniforms;
  private visionProg: WebGLProgram;
  private visionU: Uniforms;
  private sparkProg: WebGLProgram;
  private sparkU: Uniforms;
  private lensProg: WebGLProgram;
  private lensU: Uniforms;

  private sparkVao: WebGLVertexArrayObject;
  private sparkRibbon: WebGLBuffer;
  private sparkData: WebGLBuffer;
  private sparkMisc: WebGLBuffer;
  private sparkVel: WebGLBuffer;
  private sparkDataCpu = new Float32Array(MAX_SPARKS * 4);
  private sparkMiscCpu = new Float32Array(MAX_SPARKS * 2);
  private sparkVelCpu = new Float32Array(MAX_SPARKS * 2);

  private look: LookParams = { ...DEFAULT_LOOK };

  private tex: WebGLTexture | null = null;
  /** Bound whenever `tex` is null: a sampler in a live program must never point
   *  at an incomplete texture, even on a branch the shader does not take. */
  private blankTex: WebGLTexture | null = null;
  private pageTex: WebGLTexture | null = null;
  private texAspect = 1;
  private tint: [number, number, number] = [0.043, 0.039, 0.035];

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      // MUST be true. Additive passes leave the framebuffer holding
      // rgb = sum(col_i * alpha_i), which is premultiplied by construction.
      // With `false` the compositor multiplies rgb by alpha a second time, so a
      // fragment of intensity i composites at i^3 — a 0.3 glow arrives at 0.027
      // and the entire ring is invisible except for a hairline core.
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      // Not desynchronized: the low-latency path composites an alpha overlay
      // through a different route and is not worth the risk here.
      powerPreference: "low-power",
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;

    this.ringProg = link(gl, ringVertSrc, ringFragSrc);
    this.ringU = uniforms(gl, this.ringProg, [
      "uRes", "uCenter", "uRadius", "uProgress", "uStartAngle",
      "uDir", "uEnergy", "uTime", "uSpin", "uDissipate", "uPx", "uRunes",
      "uCore", "uThickness", "uGrain", "uDust", "uGlow",
    ]);

    this.visionProg = link(gl, ringVertSrc, visionFragSrc);
    this.visionU = uniforms(gl, this.visionProg, [
      "uRes", "uCenter", "uRadius", "uOpen", "uTex",
      "uHasTex", "uTint", "uTime", "uPx", "uTexScale", "uFade",
    ]);

    this.lensProg = link(gl, ringVertSrc, lensFragSrc);
    this.lensU = uniforms(gl, this.lensProg, [
      "uRes", "uCenter", "uRadius", "uHole", "uBend", "uSwirl",
      "uZoom", "uFade", "uTint", "uPx", "uPage", "uHasPage",
    ]);

    this.sparkProg = link(gl, sparkVertSrc, sparkFragSrc);
    this.sparkU = uniforms(gl, this.sparkProg, ["uRes", "uTrail", "uGravity"]);

    const quad = gl.createBuffer();
    if (!quad) throw new Error("createBuffer failed");
    this.quad = quad;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );

    const vao = gl.createVertexArray();
    if (!vao) throw new Error("createVertexArray failed");
    this.vaoFull = vao;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // --- spark instancing: one ribbon per particle ---
    const svao = gl.createVertexArray();
    const ribbon = gl.createBuffer();
    const data = gl.createBuffer();
    const miscBuf = gl.createBuffer();
    const velBuf = gl.createBuffer();
    if (!svao || !ribbon || !data || !miscBuf || !velBuf) {
      throw new Error("spark buffers failed");
    }
    this.sparkVao = svao;
    this.sparkRibbon = ribbon;
    this.sparkData = data;
    this.sparkMisc = miscBuf;
    this.sparkVel = velBuf;

    gl.bindVertexArray(svao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ribbon);
    gl.bufferData(gl.ARRAY_BUFFER, buildRibbon(TRAIL_SEGMENTS), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, data);
    gl.bufferData(gl.ARRAY_BUFFER, this.sparkDataCpu.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, miscBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.sparkMiscCpu.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, velBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.sparkVelCpu.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);

    this.blankTex = gl.createTexture();
    if (this.blankTex) {
      gl.bindTexture(gl.TEXTURE_2D, this.blankTex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]),
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssW = Math.max(1, cssWidth);
    this.cssH = Math.max(1, cssHeight);
    this.dpr = Math.min(2, Math.max(1, dpr)); // §10: cap dpr at 2
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  setTint(rgb: readonly [number, number, number]): void {
    this.tint = [rgb[0], rgb[1], rgb[2]];
  }

  setLook(patch: Partial<LookParams>): void {
    this.look = { ...this.look, ...patch };
  }

  setPageImage(bitmap: ImageBitmap | null): void {
    const gl = this.gl;
    if (this.pageTex) {
      gl.deleteTexture(this.pageTex);
      this.pageTex = null;
    }
    if (!bitmap) return;
    const tex = gl.createTexture();
    if (!tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // One convention for every texture: row 0 of the source is texel v=0, and the
// shaders flip when they sample. UNPACK_FLIP_Y_WEBGL is deliberately NOT used —
// whether it applies to an ImageBitmap upload is implementation-dependent, and
// relying on it is how the page snapshot ended up rendering upside down.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    } catch {
      gl.deleteTexture(tex);
      return;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // CLAMP, not REPEAT: the dive samples well outside [0,1] and a wrapped page
    // tiling at the edges is instantly readable as a bug.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.pageTex = tex;
  }

  getLook(): LookParams {
    return { ...this.look };
  }

  setVisionImage(bitmap: ImageBitmap | null): void {
    const gl = this.gl;
    if (this.tex) {
      gl.deleteTexture(this.tex);
      this.tex = null;
    }
    if (!bitmap) return;

    // The bitmap came from a data: URL built in the service worker (§7.4/§7.6),
    // so it is same-origin and uploads without a security error.
    const tex = gl.createTexture();
    if (!tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // One convention for every texture: row 0 of the source is texel v=0, and the
// shaders flip when they sample. UNPACK_FLIP_Y_WEBGL is deliberately NOT used —
// whether it applies to an ImageBitmap upload is implementation-dependent, and
// relying on it is how the page snapshot ended up rendering upside down.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    } catch {
      gl.deleteTexture(tex);
      return;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.tex = tex;
    this.texAspect = bitmap.width / Math.max(1, bitmap.height);
  }

  render(s: RenderState, sparks: SparkSystem): void {
    if (this.disposed) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;

    const dpr = this.dpr;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // gl_FragCoord has its origin bottom-left; CSS coords are top-left.
    const cx = s.cx * dpr;
    const cy = h - s.cy * dpr;
    const radius = s.radius * dpr;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindVertexArray(this.vaoFull);

    // ---- pass -1: gravitational lens over the captured page ----
    // Drawn first and opaquely, so it replaces the real page underneath; the
    // hole it punches is what the destination shows through.
    if (this.pageTex && s.lens > 0.0001) {
      gl.blendFuncSeparate(
        gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE, gl.ONE_MINUS_SRC_ALPHA,
      );
      gl.useProgram(this.lensProg);
      const u = this.lensU;
      gl.uniform2f(u["uRes"]!, w, h);
      gl.uniform2f(u["uCenter"]!, cx, cy);
      gl.uniform1f(u["uRadius"]!, radius);
      gl.uniform1f(u["uHole"]!, s.hole * dpr);
      gl.uniform1f(u["uBend"]!, s.lens);
      gl.uniform1f(u["uSwirl"]!, s.swirl);
      gl.uniform1f(u["uZoom"]!, s.zoom);
      gl.uniform1f(u["uFade"]!, s.fade);
      gl.uniform3f(u["uTint"]!, this.tint[0], this.tint[1], this.tint[2]);
      gl.uniform1f(u["uPx"]!, dpr);
      gl.uniform1f(u["uHasPage"]!, 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.pageTex);
      gl.uniform1i(u["uPage"]!, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---- pass 0: vision disc (normal alpha, it must occlude the page) ----
    if (s.showVision && s.open > 0.001 && s.visionFade > 0.001) {
      // Source is non-premultiplied; the destination must stay premultiplied,
      // hence the separate alpha equation.
      gl.blendFuncSeparate(
        gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE, gl.ONE_MINUS_SRC_ALPHA,
      );
      gl.useProgram(this.visionProg);
      const u = this.visionU;
      gl.uniform2f(u["uRes"]!, w, h);
      gl.uniform2f(u["uCenter"]!, cx, cy);
      gl.uniform1f(u["uRadius"]!, radius);
      gl.uniform1f(u["uOpen"]!, s.open);
      gl.uniform1f(u["uFade"]!, s.visionFade);
      gl.uniform1f(u["uHasTex"]!, this.tex ? 1 : 0);
      gl.uniform3f(u["uTint"]!, this.tint[0], this.tint[1], this.tint[2]);
      gl.uniform1f(u["uTime"]!, s.timeSec);
      gl.uniform1f(u["uPx"]!, dpr);
      // Cover mapping into a square viewport.
      const a = this.texAspect;
      if (a >= 1) gl.uniform2f(u["uTexScale"]!, 1 / a, 1);
      else gl.uniform2f(u["uTexScale"]!, 1, a);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex ?? this.blankTex);
      gl.uniform1i(u["uTex"]!, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---- pass 1: ring (additive) ----
    // RGB is the spec's SRC_ALPHA/ONE. Alpha is ONE/ONE, not SRC_ALPHA/ONE:
    // with a single blendFunc the alpha channel would accumulate as sum(a_i^2),
    // which under-reports coverage and dims the composite.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
    gl.useProgram(this.ringProg);
    {
      const u = this.ringU;
      gl.uniform2f(u["uRes"]!, w, h);
      gl.uniform2f(u["uCenter"]!, cx, cy);
      gl.uniform1f(u["uRadius"]!, radius);
      gl.uniform1f(u["uProgress"]!, s.progress);
      // Screen-space y is flipped relative to gl_FragCoord, so the traced arc's
      // angle and handedness both mirror.
      gl.uniform1f(u["uStartAngle"]!, -s.startAngle);
      gl.uniform1f(u["uDir"]!, -s.direction);
      gl.uniform1f(u["uEnergy"]!, s.energy);
      gl.uniform1f(u["uTime"]!, s.timeSec);
      gl.uniform1f(u["uSpin"]!, s.spin);
      gl.uniform1f(u["uDissipate"]!, s.dissipate);
      gl.uniform1f(u["uPx"]!, dpr);
      // Rune bands and the inscribed polygon are spec'd in §10 but read as
      // occult-circle furniture, which is not the look. Kept in the shader and
      // switched off; setLook({ runes: 1 }) brings them back.
      gl.uniform1f(u["uRunes"]!, this.look.runes);
      gl.uniform1f(u["uCore"]!, this.look.core);
      gl.uniform1f(u["uThickness"]!, this.look.thickness);
      gl.uniform1f(u["uGrain"]!, this.look.grain);
      gl.uniform1f(u["uDust"]!, this.look.dust);
      gl.uniform1f(u["uGlow"]!, this.look.glow);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- pass 2: sparks (additive, one instanced ribbon per particle) ----
    const n = sparks.count;
    if (n > 0) {
      // Convert CSS px -> device px, y-flipped, into the upload staging buffers.
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        this.sparkDataCpu[o] = sparks.packed[o]! * dpr;
        this.sparkDataCpu[o + 1] = h - sparks.packed[o + 1]! * dpr;
        this.sparkDataCpu[o + 2] = sparks.packed[o + 2]! * dpr;
        this.sparkDataCpu[o + 3] = sparks.packed[o + 3]!;
        this.sparkMiscCpu[i * 2] = sparks.tints[i]!;
        this.sparkMiscCpu[i * 2 + 1] = sparks.ages[i]!;
        // y is flipped going into gl_FragCoord space, so vy flips with it.
        this.sparkVelCpu[i * 2] = sparks.vels[i * 2]! * dpr;
        this.sparkVelCpu[i * 2 + 1] = -sparks.vels[i * 2 + 1]! * dpr;
      }
      gl.bindVertexArray(this.sparkVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkData);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparkDataCpu, 0, n * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkMisc);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparkMiscCpu, 0, n * 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkVel);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparkVelCpu, 0, n * 2);

      gl.useProgram(this.sparkProg);
      gl.uniform2f(this.sparkU["uRes"]!, w, h);
      gl.uniform1f(this.sparkU["uTrail"]!, this.look.streak);
      // Screen gravity pulls down (+y); gl_FragCoord space has y up.
      gl.uniform2f(this.sparkU["uGravity"]!, 0, -SPARK_TUNING.gravity * dpr);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, TRAIL_SEGMENTS * 6, n);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    try {
      if (this.tex) gl.deleteTexture(this.tex);
      if (this.pageTex) gl.deleteTexture(this.pageTex);
      if (this.blankTex) gl.deleteTexture(this.blankTex);
      gl.deleteBuffer(this.quad);
      gl.deleteBuffer(this.sparkRibbon);
      gl.deleteBuffer(this.sparkData);
      gl.deleteBuffer(this.sparkMisc);
      gl.deleteBuffer(this.sparkVel);
      gl.deleteVertexArray(this.vaoFull);
      gl.deleteVertexArray(this.sparkVao);
      gl.deleteProgram(this.ringProg);
      gl.deleteProgram(this.visionProg);
      gl.deleteProgram(this.sparkProg);
      gl.deleteProgram(this.lensProg);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      /* context already gone */
    }
  }
}
