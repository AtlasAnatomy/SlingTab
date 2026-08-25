#version 300 es
precision mediump float;

in float vT;      // 0 head .. 1 tail
in float vSide;
in float vAlpha;
in float vTint;

out vec4 fragColor;

// #C2410C -> #FF8A1F -> #FFD27A -> white-hot.
// The top stop is an addition to the spec palette: real embers have a white
// core and clip to it, and without that stop the sparks read as orange plastic.
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
  // Across the strand. The soft shoulder is what stops a 1px ribbon from
  // shimmering as it crosses the pixel grid.
  float across = 1.0 - abs(vSide);
  if (across <= 0.0) discard;

  // Along the strand: bright at the head, cooling and thinning to the tail.
  float along = 1.0 - vT;

  float a = pow(across, 0.65) * pow(along, 1.25) * vAlpha;
  if (a <= 0.002) discard;

  // The tip is white-hot, the tail falls to the deep orange end.
  float heat = clamp(vTint * 0.25 + pow(along, 2.2) * 0.85, 0.0, 1.0);

  fragColor = vec4(palette(heat), clamp(a, 0.0, 1.0));
}
