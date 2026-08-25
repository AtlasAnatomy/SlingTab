#version 300 es
precision highp float;

/**
 * Gravitational lens over a snapshot of the page itself.
 *
 * The page arrives as a texture (chrome.tabs.captureVisibleTab of the active
 * tab), so everything here is GPU work on a quad. That is the whole point: the
 * previous dive transformed <body>, which fought every site's CSS, promoted a
 * document-sized compositor layer, and stuttered. None of that exists once the
 * page is pixels.
 *
 * Two deflections, both falling off as 1/r the way a real lens does:
 *   - radial   (uBend)  light bends toward the mass
 *   - tangential (uSwirl) frame dragging, which is what sells "spacetime" over
 *                        "fisheye"
 *
 * The disc itself is punched out to alpha 0 so the destination — the vision
 * pass above, or a DOM iframe below the canvas — shows through the hole.
 */
uniform vec2      uRes;
uniform vec2      uCenter;     // device px, gl_FragCoord space
uniform float     uRadius;     // ring radius, device px
uniform float     uHole;       // transparent hole radius, device px
uniform float     uBend;       // radial deflection strength
uniform float     uSwirl;      // tangential deflection strength
uniform float     uZoom;       // >1 pulls the whole frame toward the centre
uniform float     uFade;       // 0..1 wash toward uTint at the very end
uniform vec3      uTint;
uniform float     uPx;
uniform sampler2D uPage;
uniform float     uHasPage;

out vec4 fragColor;

float sq(float x) { return x * x; }

void main() {
  if (uHasPage < 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  vec2  p   = gl_FragCoord.xy;
  vec2  d   = p - uCenter;
  float r   = length(d);
  vec2  dir = r > 0.001 ? d / r : vec2(1.0, 0.0);
  vec2  tan = vec2(-dir.y, dir.x);

  // Normalised to the disc, so the effect scales with the circle the user drew.
  float rr = max(r / max(uRadius, 1.0), 0.18);

  // 1/r falloff, windowed so the far corners of the page stay undisturbed.
  float falloff = smoothstep(7.0, 0.7, rr);
  float bend  = uBend  * uRadius * falloff / rr;
  float swirl = uSwirl * uRadius * falloff / rr;

  vec2 src = p - dir * bend + tan * swirl;
  // The dive: everything rushes past the camera.
  src = uCenter + (src - uCenter) / max(uZoom, 0.001);

  // gl_FragCoord has y up; the texture has row 0 (v=0) at the top of the image.
  // Flip here rather than at upload time — see the note in gl.ts.
  vec2 uv = vec2(src.x / uRes.x, 1.0 - src.y / uRes.y);

  // Chromatic split proportional to how hard this pixel is being bent — zero
  // where the page is untouched, so it never looks like a cheap global filter.
  float ca = clamp(bend / max(uRadius, 1.0), 0.0, 1.0) * 0.010;
  vec3 col;
  col.r = texture(uPage, uv + dir * ca).r;
  col.g = texture(uPage, uv).g;
  col.b = texture(uPage, uv - dir * ca).b;

  // Light falls into the well: darken and cool as the bend increases.
  float pull = clamp(bend / max(uRadius, 1.0), 0.0, 1.5);
  col *= 1.0 - 0.55 * smoothstep(0.0, 1.1, pull);
  // Warm rim spill, as if the ring were lighting the page it is bending.
  col += vec3(1.0, 0.62, 0.24) * 0.16 * exp(-sq((r - uRadius) / (uRadius * 0.55)));

  // Wash toward the destination's theme colour for continuity with the arrival
  // animation on the next page.
  col = mix(col, uTint, clamp(uFade, 0.0, 1.0));

  // Punch the hole. The destination shows through it.
  float feather = max(1.5 * uPx, uHole * 0.004);
  float alpha = smoothstep(uHole - feather, uHole + feather, r);

  fragColor = vec4(col, alpha);
}
