/**
 * CPU-side particle simulation, shared by the WebGL2 renderer and the Canvas2D
 * fallback. Keeping the sim here is what makes a mid-animation context-loss
 * swap seamless: the particles carry across untouched, only the draw changes.
 *
 * All coordinates are CSS pixels; renderers scale to device pixels themselves.
 */

/**
 * Instanced ribbons are cheap; the look needs a crowd, not a handful.
 *
 * This has to stay above the steady-state population implied by the emission
 * rates below (roughly rate * mean lifetime, ~0.72s). Undershoot it and the
 * recycler starts overwriting particles that are still alive, which reads as a
 * thin, sparse rim no amount of rate tuning can fix.
 */
export const MAX_SPARKS = 12000;

/**
 * Live-tunable particle behaviour. Mutable on purpose: tools/tune.html writes
 * to this so the look can be dialled in without a rebuild-and-reload cycle.
 * Whatever ends up here is what ships — there is no separate "production" copy.
 */
export const SPARK_TUNING = {
  gravity: 400, // px/s^2
  drag: 0.8, // survival fraction per second

  /**
   * Fraction of emissions that are "whips": long, fast, obliquely launched.
   * A cubic falloff on a single population makes these vanishingly rare and the
   * spray reads as a uniform fuzzy halo. Two populations is what gives a dense
   * slow bed with a few streaks flung clear of it.
   */
  whipChance: 0.3,
  whipSpeed: 2.2,
  whipSpeedVar: 3.4,
  bedSpeed: 0.18,
  bedSpeedVar: 1.9,

  /**
   * Random rotation of the launch vector, radians. Zero means every spark
   * leaves on the tangent and they all lie parallel to the rim; this is what
   * makes them cut across it at an angle.
   */
  skewBed: 0.75,
  skewWhip: 1.6,

  /** Half-width of a spark quad, px, before the age taper. */
  size: 1.1,
  /** Chance a spark drifts inward across the disc instead of outward. */
  inwardChance: 0.21,

  // --- emission, particles/second. Read by departure.ts and arrival.ts, so
  // what the tuner changes is what ships. ---
  /** While the ring traces, from the leading edge. */
  rateIgnite: 14000,
  igniteSpeed: 560,
  igniteSpread: 1.25,
  /** While the disc punctures. */
  rateOpen: 5200,
  /** While the ring waits for the cursor. */
  rateHold: 4200,
  shedSpeed: 220,
  shedSpread: 1.0,
};

export class SparkSystem {
  private x = new Float32Array(MAX_SPARKS);
  private y = new Float32Array(MAX_SPARKS);
  private vx = new Float32Array(MAX_SPARKS);
  private vy = new Float32Array(MAX_SPARKS);
  private age = new Float32Array(MAX_SPARKS);
  private life = new Float32Array(MAX_SPARKS);
  private size = new Float32Array(MAX_SPARKS);
  private tintSeed = new Float32Array(MAX_SPARKS);
  /** Per-particle gravity multiplier. Embers resting on a drawn arc use ~0. */
  private gscale = new Float32Array(MAX_SPARKS);

  private live = 0;
  /** Fractional carry so emission is rate-based, not per-frame. */
  private carry = 0;

  /** Interleaved x, y, halfWidth, alpha — CSS px, one vec4 per particle. */
  readonly packed = new Float32Array(MAX_SPARKS * 4);
  /** Interleaved vx, vy — CSS px/s. The trail ribbon is built from this. */
  readonly vels = new Float32Array(MAX_SPARKS * 2);
  /** One float per particle, palette position. */
  readonly tints = new Float32Array(MAX_SPARKS);
  /** Seconds since spawn. Clamps the trail so a new spark has no false past. */
  readonly ages = new Float32Array(MAX_SPARKS);

  get count(): number {
    return this.live;
  }

  clear(): void {
    this.live = 0;
    this.carry = 0;
  }

  private spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    tint: number,
    gravityScale = 1,
  ): void {
    let i: number;
    if (this.live < MAX_SPARKS) {
      i = this.live++;
    } else {
      // Recycle the oldest-looking slot rather than dropping the emission.
      i = 0;
      let worst = -1;
      for (let k = 0; k < MAX_SPARKS; k += 13) {
        const frac = this.age[k]! / this.life[k]!;
        if (frac > worst) {
          worst = frac;
          i = k;
        }
      }
    }
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.tintSeed[i] = tint;
    this.gscale[i] = gravityScale;
  }

  /**
   * A spray from a single point, thrown along `dirX/dirY` — a sparkler held in
   * the hand rather than shed from a rim. Used for the live stroke, where the
   * emission point is the fingertip and there may be no fitted circle yet.
   */
  emitAtPoint(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    count: number,
    speed = 220,
    lifeScale = 1,
    gravityScale = 1,
  ): void {
    const T = SPARK_TUNING;
    const len = Math.hypot(dirX, dirY);
    const ux = len > 0.001 ? dirX / len : 0;
    const uy = len > 0.001 ? dirY / len : 0;

    for (let n = 0; n < count; n++) {
      const whip = Math.random() < T.whipChance;
      const u = Math.random();
      const s = whip
        ? speed * (T.whipSpeed + u * T.whipSpeedVar)
        : speed * (T.bedSpeed + u * u * T.bedSpeedVar);

      // Mostly trailing the hand's motion, with a wide scatter around it.
      const a = Math.atan2(uy, ux) + (Math.random() - 0.5) * 2.4;
      this.spawn(
        x + (Math.random() - 0.5) * 6,
        y + (Math.random() - 0.5) * 6,
        Math.cos(a) * s,
        Math.sin(a) * s,
        (whip ? 0.62 + Math.random() * 0.5 : 0.4 + Math.random() * 0.5) * lifeScale,
        T.size * (whip ? 0.4 + Math.random() * 0.7 : 0.5 + Math.random() * 1.5),
        Math.random(),
        gravityScale,
      );
    }
  }

  emitAtPointRate(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    ratePerSecond: number,
    dt: number,
    speed = 220,
    lifeScale = 1,
    gravityScale = 1,
  ): void {
    const n = this.budget(ratePerSecond, dt);
    if (n > 0) {
      this.emitAtPoint(x, y, dirX, dirY, n, speed, lifeScale, gravityScale);
    }
  }

  /** Convert a rate in particles/second into a whole count for this frame. */
  private budget(rate: number, dt: number): number {
    this.carry += rate * dt;
    const n = Math.floor(this.carry);
    this.carry -= n;
    return n;
  }

  /**
   * Emit tangentially from the rim around `angle` — where the ring's leading
   * edge currently is. `spread` widens the arc it is thrown from.
   *
   * The speed spread is deliberately huge: a narrow one gives a uniform fuzzy
   * halo, and what makes this read as sparks is a few fast whips flung clear of
   * a dense slow bed.
   */
  emitAtRim(
    cx: number,
    cy: number,
    radius: number,
    angle: number,
    direction: number,
    count: number,
    speed = 260,
    spread = 0.30,
    /** Multiplies the lifetime. The live stroke preview needs embers that
     *  outlive the whole gesture, so the part already drawn stays visible. */
    lifeScale = 1,
    gravityScale = 1,
  ): void {
    const T = SPARK_TUNING;
    for (let n = 0; n < count; n++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const r = radius * (1 + (Math.random() - 0.5) * 0.045);
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;

      const tx = -Math.sin(a) * direction;
      const ty = Math.cos(a) * direction;
      const nx = Math.cos(a);
      const ny = Math.sin(a);

      const whip = Math.random() < T.whipChance;
      const u = Math.random();
      const s = whip
        ? speed * (T.whipSpeed + u * T.whipSpeedVar)
        : speed * (T.bedSpeed + u * u * T.bedSpeedVar);

      // A minority drift inward across the disc, which stops the rim reading
      // as a hard silhouette.
      const outward =
        Math.random() < T.inwardChance ? -0.35 : 0.2 + Math.random() * 0.75;

      let vx = tx * s + nx * s * outward;
      let vy = ty * s + ny * s * outward;

      // Rotate the launch vector so the streak cuts across the rim instead of
      // lying along it.
      const skew = (Math.random() - 0.5) * (whip ? T.skewWhip : T.skewBed);
      const cs = Math.cos(skew);
      const sn = Math.sin(skew);
      [vx, vy] = [vx * cs - vy * sn, vx * sn + vy * cs];

      this.spawn(
        px,
        py,
        vx + (Math.random() - 0.5) * 40,
        vy + (Math.random() - 0.5) * 40,
        // Whips live longer so they actually get clear of the ring; the bed
        // stays inside the 400-900ms of the spec.
        (whip ? 0.62 + Math.random() * 0.5 : 0.4 + Math.random() * 0.5) * lifeScale,
        T.size * (whip ? 0.4 + Math.random() * 0.7 : 0.5 + Math.random() * 1.5),
        Math.random(),
        gravityScale,
      );
    }
  }

  /** Rate-based version of the above, so density is frame-rate independent. */
  emitAtRimRate(
    cx: number,
    cy: number,
    radius: number,
    angle: number,
    direction: number,
    ratePerSecond: number,
    dt: number,
    speed = 260,
    spread = 0.30,
    lifeScale = 1,
    gravityScale = 1,
  ): void {
    const n = this.budget(ratePerSecond, dt);
    if (n > 0) {
      this.emitAtRim(
        cx, cy, radius, angle, direction, n, speed, spread, lifeScale, gravityScale,
      );
    }
  }

  /**
   * Scatter embers along an arc that has already been swept, so the part of the
   * circle the user has drawn stays lit while they finish it. Separate from the
   * leading edge, and far slower, because these are embers resting on the path
   * rather than being thrown off it.
   */
  emitAlongArc(
    cx: number,
    cy: number,
    radius: number,
    startAngle: number,
    sweep: number,
    direction: number,
    ratePerSecond: number,
    dt: number,
    speed = 70,
    lifeScale = 2,
    gravityScale = 0.06,
  ): void {
    const n = this.budget(ratePerSecond, dt);
    for (let i = 0; i < n; i++) {
      const a = startAngle + Math.random() * sweep * direction;
      this.emitAtRim(
        cx, cy, radius, a, direction, 1, speed, 0.05, lifeScale, gravityScale,
      );
    }
  }

  /** Ring letting go: emit evenly all the way round, pushed outward. */
  emitBurst(cx: number, cy: number, radius: number, count: number, speed = 320): void {
    for (let n = 0; n < count; n++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * (1 + (Math.random() - 0.5) * 0.06);
      const u = Math.random();
      const s = speed * (0.2 + u * u * 2.6);
      const tangent = (Math.random() - 0.5) * 1.4;
      this.spawn(
        cx + Math.cos(a) * r,
        cy + Math.sin(a) * r,
        Math.cos(a) * s - Math.sin(a) * s * tangent,
        Math.sin(a) * s + Math.cos(a) * s * tangent,
        0.4 + Math.random() * 0.5,
        0.6 + Math.random() * 1.8,
        Math.random(),
      );
    }
  }

  /** Advance and repack. `dt` in seconds. */
  update(dt: number): void {
    const d = Math.min(dt, 0.05);
    const drag = Math.pow(SPARK_TUNING.drag, d);
    const gravity = SPARK_TUNING.gravity;

    let w = 0;
    for (let i = 0; i < this.live; i++) {
      const age = this.age[i]! + d;
      if (age >= this.life[i]!) continue;

      const vx = this.vx[i]! * drag;
      const vy = this.vy[i]! * drag + gravity * this.gscale[i]! * d;
      const x = this.x[i]! + vx * d;
      const y = this.y[i]! + vy * d;

      // Compact in place: survivors move down to index w.
      this.x[w] = x;
      this.y[w] = y;
      this.vx[w] = vx;
      this.vy[w] = vy;
      this.age[w] = age;
      this.life[w] = this.life[i]!;
      this.size[w] = this.size[i]!;
      this.tintSeed[w] = this.tintSeed[i]!;
      this.gscale[w] = this.gscale[i]!;

      const t = age / this.life[w]!;
      // Embers hold their brightness then drop off a cliff, rather than fading
      // linearly — a linear fade looks like dimming LEDs, not like cooling.
      const alpha = (1 - t) * (1 - t) * (1 - t * 0.35);
      const o = w * 4;
      this.packed[o] = x;
      this.packed[o + 1] = y;
      this.packed[o + 2] = this.size[w]! * (0.45 + 0.55 * (1 - t));
      this.packed[o + 3] = alpha;
      this.vels[w * 2] = vx;
      this.vels[w * 2 + 1] = vy;
      this.ages[w] = age;
      this.tints[w] = this.tintSeed[w]! * 0.35 + (1 - t) * 0.65;

      w++;
    }
    this.live = w;
  }
}