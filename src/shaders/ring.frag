#version 300 es
precision highp float;

// The rim is not a glowing tube. It is a dense, uneven stream of embers, and it
// has to break up along its length or it reads as a neon hoop. Everything here
// serves that: the filament wanders off-radius, varies in thickness, and is
// chopped by high-frequency angular noise into individual hot cells. The real
// particle system then sits on top of it.
//
// Everything is polar around uCenter. All lengths are DEVICE pixels in
// gl_FragCoord space (origin bottom-left) — the renderer flips y before upload.
uniform vec2  uRes;
uniform vec2  uCenter;
uniform float uRadius;
uniform float uProgress;    // 0..1, how much of the ring has been traced
uniform float uStartAngle;  // where the trace began
uniform float uDir;         // +1 / -1, the direction the hand travelled
uniform float uEnergy;      // master brightness
uniform float uTime;        // seconds
uniform float uSpin;        // slow rotation, radians
uniform float uDissipate;   // 0..1, ring blowing apart
uniform float uPx;          // device pixels per CSS pixel
uniform float uRunes;       // 0..1 rune bands + inscribed polygon (see gl.ts)

// Look parameters. Promoted out of the shader body so tools/tune.html can drive
// them live — tuning by editing constants and reloading an extension is not a
// workflow. Defaults live in renderer/types.ts (DEFAULT_LOOK).
uniform float uCore;        // filament brightness
uniform float uThickness;   // filament half-width, as a fraction of R
uniform float uGrain;       // how hard the speckle chops the filament
uniform float uDust;        // ember dust hugging the outside
uniform float uGlow;        // bloom weight

out vec4 fragColor;

const float TAU = 6.28318530718;

// pow(x, y) is UNDEFINED for x < 0 in GLSL ES, and several drivers return NaN.
// Every squared term below straddles zero, so none of them may use pow().
float sq(float x) { return x * x; }

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

// #C2410C -> #FF8A1F -> #FFD27A -> white-hot. The top stop extends the spec
// palette: embers clip to white at the core, and without it the ring reads as
// flat orange rather than as something burning.
vec3 palette(float t) {
  vec3 c0 = vec3(0.760, 0.255, 0.047);
  vec3 c1 = vec3(1.000, 0.541, 0.121);
  vec3 c2 = vec3(1.000, 0.824, 0.478);
  vec3 c3 = vec3(1.000, 0.957, 0.890);
  t = clamp(t, 0.0, 1.0);
  if (t < 0.34) return mix(c0, c1, t / 0.34);
  if (t < 0.68) return mix(c1, c2, (t - 0.34) / 0.34);
  return mix(c2, c3, (t - 0.68) / 0.32);
}

void main() {
  vec2  p  = gl_FragCoord.xy - uCenter;
  float d  = length(p);
  float a  = atan(p.y, p.x);
  float px = max(uPx, 1.0);

  float R = uRadius * (1.0 + uDissipate * 0.16);

  if (d > R * 1.75 + 30.0 * px) {
    fragColor = vec4(0.0);
    return;
  }

  // ---- arc mask: the ring follows the hand, it does not appear pre-formed ----
  float rel   = mod((a - uStartAngle) * uDir, TAU);
  float sweep = uProgress * TAU;
  float arc   = 1.0 - smoothstep(sweep - 0.08, sweep + 0.02, rel);
  arc = mix(arc, 1.0, smoothstep(0.985, 1.0, uProgress));

  // Distance BEHIND the leading edge: positive inside the traced arc, negative
  // ahead of it.
  //
  // Do NOT write exp(-sq(max(0.0, behind) / w)). Clamping the argument to zero
  // makes the Gaussian evaluate to exp(0) = 1 for every angle ahead of the
  // sweep, so the whole un-traced ring lights at full core brightness — the arc
  // mask below cannot help, because this term is added outside it. Gate on the
  // sign instead.
  float behind = sweep - rel;
  float lead = step(0.0, behind) * exp(-sq(behind / 0.26))
             * smoothstep(0.02, 0.12, uProgress)
             * smoothstep(1.0, 0.86, uProgress);

  // ---- the filament ----
  // Wander: a hand-drawn burning circle is never a perfect circle.
  float wobble = (fbm(vec2(a * 4.0 + 11.0, uTime * 0.5)) - 0.5) * R * 0.030;
  float rr = R + wobble;

  // Thickness varies slowly around the arc; brightness is chopped fast.
  float swell   = fbm(vec2(a * 8.0 + uSpin * 1.2, uTime * 0.9));
  float speckle = fbm(vec2(a * 52.0 + uSpin * 3.0, uTime * 2.4));

  float w = max(1.4 * px, R * uThickness) * (0.55 + 0.95 * swell);
  float core = exp(-sq((d - rr) / w));
  core *= (1.0 - uGrain) + uGrain * speckle;   // break the line into embers

  // ---- ember dust hugging the outside of the filament ----
  // Fills the gap between the analytic filament and the real particles, so the
  // rim has depth instead of a hard silhouette.
  float sprayW = R * 0.14;
  float sprayD = max(0.0, d - rr) / sprayW;
  float dust = exp(-sq(sprayD * 1.15))
             * smoothstep(0.55, 0.95, fbm(vec2(a * 130.0 + uSpin * 5.0,
                                               d * 0.26 - uTime * 5.0)));

  // ---- bloom ----
  float gw = max(R * 0.15, 11.0 * px);
  float dd = (d - rr) / gw;
  float glow = (d > rr ? 1.0 : 0.7) / (1.0 + dd * dd * 5.0);

  // ---- optional occult furniture, off by default (see uRunes in gl.ts) ----
  float runes = 0.0;
  float poly = 0.0;
  if (uRunes > 0.001) {
    for (int b = 0; b < 2; b++) {
      float inner = b == 0 ? 1.0 : 0.0;
      float br = R * mix(1.082, 0.884, inner);
      float bw = R * 0.050;
      float band = exp(-sq((d - br) / bw));
      if (band < 0.003) continue;

      float rot   = uSpin * mix(-0.62, 1.0, inner);
      float cells = mix(52.0, 34.0, inner);
      float ang   = (a + rot) / TAU * cells;
      float ci    = floor(ang);
      float cf    = fract(ang);

      float row = floor(((d - br) / bw + 1.2) * 1.6);
      float on  = step(0.50, hash21(vec2(ci, row + inner * 17.0)));
      float stroke = smoothstep(0.13, 0.25, cf) * (1.0 - smoothstep(0.75, 0.87, cf));
      float flicker = 0.55 + 0.45 * fbm(vec2(ci * 0.31, uTime * 0.35 + inner * 9.0));
      runes += band * on * stroke * flicker;
    }

    float n    = 7.0;
    float seg  = TAU / n;
    float pa   = mod(a + uSpin * 0.22 + seg * 0.5, seg) - seg * 0.5;
    float rp   = R * 0.60 * cos(seg * 0.5) / max(0.25, cos(pa));
    poly = exp(-sq((d - rp) / max(1.2 * px, R * 0.004))) * 0.30;
    poly *= smoothstep(R * 1.05, R * 0.30, d);
  }

  float breathe = 0.88 + 0.12 * fbm(vec2(uTime * 0.55, 3.7));
  float energy  = uEnergy * breathe * (1.0 - uDissipate * 0.85);

  float ring = core * uCore
             + dust * uDust
             + glow * uGlow
             + (runes * 0.85 + poly) * uRunes;
  ring = ring * arc + core * lead * 2.2;

  float intensity = clamp(ring * energy, 0.0, 1.7);
  float heat = clamp(core * 1.20 + lead * 0.45 + dust * 0.30 + glow * 0.08, 0.0, 1.0);

  // Additive: the pipeline blends with SRC_ALPHA / ONE, onto a premultiplied
  // framebuffer. See the note in gl.ts before changing any of this.
  fragColor = vec4(palette(heat), clamp(intensity, 0.0, 1.0));
}