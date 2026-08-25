#version 300 es
precision highp float;

// Mode C. Composites "a glimpse of somewhere else" inside the disc: the preview
// image scaled to cover, blurred progressively (sharp at centre, heavy at the
// rim), tinted toward the destination theme-color, plus additive golden haze,
// film grain and radially increasing chromatic aberration.
//
// A crisp preview reads as a thumbnail in a circle and looks wrong. The haze is
// the point.
uniform vec2      uRes;
uniform vec2      uCenter;
uniform float     uRadius;
uniform float     uOpen;      // 0..1 puncture growth
uniform sampler2D uTex;
uniform float     uHasTex;
uniform vec3      uTint;      // destination theme-color, linear-ish sRGB
uniform float     uTime;
uniform float     uPx;
uniform vec2      uTexScale;  // cover mapping for the image aspect
uniform float     uFade;      // 1 = preview fully covers, 0 = framed page shows

out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

const int TAPS = 12;
vec2 kernel(int i) {
  // Fixed poisson-ish disc. Cheap, and the result is meant to be soft anyway.
  if (i == 0)  return vec2( 0.000,  0.000);
  if (i == 1)  return vec2( 0.527, -0.085);
  if (i == 2)  return vec2(-0.040, -0.612);
  if (i == 3)  return vec2(-0.673,  0.230);
  if (i == 4)  return vec2( 0.276,  0.756);
  if (i == 5)  return vec2( 0.876,  0.404);
  if (i == 6)  return vec2(-0.560, -0.740);
  if (i == 7)  return vec2(-0.905, -0.220);
  if (i == 8)  return vec2( 0.640, -0.700);
  if (i == 9)  return vec2( 0.120,  0.980);
  if (i == 10) return vec2(-0.320,  0.560);
  return vec2( 0.980, -0.130);
}

vec2 toUv(vec2 p) {
  vec2 q = p / uRadius * 0.5 + 0.5;
  // v=0 is the top of the image; gl_FragCoord y runs the other way.
  q.y = 1.0 - q.y;
  return (q - 0.5) * uTexScale + 0.5;
}

void main() {
  vec2  p  = gl_FragCoord.xy - uCenter;
  float d  = length(p);
  float px = max(uPx, 1.0);
  float Ro = uRadius * uOpen;

  if (Ro <= 0.5 || d > Ro + 2.0 * px) {
    fragColor = vec4(0.0);
    return;
  }

  float nd = clamp(d / max(uRadius, 1.0), 0.0, 1.0);

  vec3 col;
  if (uHasTex > 0.5) {
    // Progressive blur: sharp at the centre, heavy at the rim.
    float blur = (0.008 + pow(nd, 1.6) * 0.075) * max(uTexScale.x, uTexScale.y);
    // Chromatic aberration grows with the square of the radius.
    float ca = pow(nd, 2.0) * 0.022;

    vec3 acc = vec3(0.0);
    for (int i = 0; i < TAPS; i++) {
      vec2 o = kernel(i) * blur;
      vec2 uvBase = toUv(p) + o;
      vec2 dir = d > 0.001 ? p / d : vec2(0.0);
      acc.r += texture(uTex, uvBase + dir * ca).r;
      acc.g += texture(uTex, uvBase).g;
      acc.b += texture(uTex, uvBase - dir * ca).b;
    }
    col = acc / float(TAPS);
  } else {
    // No preview: a soft radial wash of the theme-color still reads as depth.
    col = uTint * (0.55 + 0.45 * (1.0 - nd));
  }

  // Tint toward the destination, more strongly at the rim.
  col = mix(col, uTint, 0.22 + 0.42 * pow(nd, 1.7));
  // Darken the rim so the disc has a lip and does not look pasted on.
  col *= mix(1.06, 0.34, pow(nd, 2.4));
  // Additive golden haze: a centre bloom plus a rim halo.
  col += vec3(1.0, 0.62, 0.22) * (0.06 + 0.30 * pow(nd, 3.2));
  col += vec3(1.0, 0.80, 0.50) * 0.07 * (1.0 - smoothstep(0.0, 0.55, nd));

  // Film grain. Animated, so it does not read as a texture on the glass.
  float g = hash21(gl_FragCoord.xy + fract(uTime * 7.13) * 311.0) - 0.5;
  col += g * 0.055;

  col = clamp(col, 0.0, 1.0);

  float alpha = (1.0 - smoothstep(Ro - 1.5 * px, Ro, d)) * clamp(uFade, 0.0, 1.0);
  fragColor = vec4(col, alpha);
}