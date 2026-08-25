#version 300 es
/**
 * Each spark is a RIBBON along its own past trajectory, not a quad stretched
 * along its instantaneous velocity. That is the whole difference between "hair"
 * and "elongated dots": a straight smear has no path, and the eye reads it as a
 * dash. These curve, taper, and cool along their length.
 *
 * The path is reconstructed analytically instead of from a stored history, so
 * there is nothing per-particle to keep, shift, or compact on the CPU. Going
 * backwards in time by tau from a particle at (p, v) under constant gravity g:
 *
 *     p(-tau) = p - v*tau + 0.5*g*tau^2
 *
 * which is a parabola — exactly the gentle curve a thrown ember leaves. Drag is
 * ignored over the trail window; this is a look, not a physics integrator.
 *
 * aCorner arrives from a static buffer of TRAIL_SEGMENTS quads:
 *   x = normalised position along the trail, 0 at the head, 1 at the tail
 *   y = which side of the ribbon, -1 or +1
 */
layout(location = 0) in vec2  aCorner;
layout(location = 1) in vec4  aData;   // xy = device px, z = half-width px, w = alpha
layout(location = 2) in vec2  aMisc;   // x = palette position, y = age in seconds
layout(location = 3) in vec2  aVel;    // device px/s

uniform vec2  uRes;
uniform float uTrail;     // seconds of path to draw behind the head
uniform vec2  uGravity;   // device px/s^2, already in gl_FragCoord space

out float vT;      // 0 head .. 1 tail
out float vSide;
out float vAlpha;
out float vTint;

void main() {
  float tn   = aCorner.x;
  float side = aCorner.y;

  // A spark 40ms old must not trail 200ms of path it never travelled.
  float trail = min(uTrail, aMisc.y);
  float tau   = tn * trail;

  vec2 p = aData.xy - aVel * tau + 0.5 * uGravity * tau * tau;

  // d(p)/d(tau) — the tangent of the reconstructed path at this point.
  vec2  dv = -aVel + uGravity * tau;
  float dl = length(dv);
  vec2  dir  = dl > 0.001 ? dv / dl : vec2(1.0, 0.0);
  vec2  perp = vec2(-dir.y, dir.x);

  // Taper to nothing at the tail. The floor keeps a strand from disappearing
  // between samples once it is thinner than a pixel.
  float halfW = aData.z * (1.0 - tn) * (1.0 - tn) + 0.28;

  vec2 px  = p + perp * side * halfW;
  vec2 ndc = px / uRes * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);

  vT     = tn;
  vSide  = side;
  vAlpha = aData.w;
  vTint  = aMisc.x;
}
