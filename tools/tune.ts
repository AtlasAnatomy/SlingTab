/**
 * Rim tuner.
 *
 * The spec's build order calls step 3 "the step worth iterating on visually",
 * and tuning a shader by editing a constant, rebuilding, reloading an unpacked
 * extension, reloading the page and redrawing a gesture is not iteration — it
 * is about fifteen seconds per look at a number.
 *
 * This runs the same GLRenderer, the same shaders and the same SparkSystem the
 * extension uses, on a loop, with live sliders. It writes straight into
 * SPARK_TUNING and LookParams, which are the values that ship — there is no
 * separate copy to keep in sync.
 *
 *   npm run tune
 *
 * Vite HMR applies shader edits without even a page reload.
 */
import { GLRenderer } from "../src/content/renderer/gl";
import { SPARK_TUNING, SparkSystem } from "../src/content/renderer/sparks";
import { DEFAULT_LOOK, type LookParams, type RenderState } from "../src/content/renderer/types";
import { clamp01, easeOutCubic, easeInCubic, easeOutQuint } from "../src/shared/easing";

const T_IGNITE = 220;
const T_OPEN = 180;
const T_HOLD = 2600;
const T_DISSIPATE = 380;
const T_GAP = 260;
const T_TOTAL = T_IGNITE + T_OPEN + T_HOLD + T_DISSIPATE + T_GAP;

const look: LookParams = { ...DEFAULT_LOOK };

const stage = document.getElementById("stage") as HTMLDivElement;
const panel = document.getElementById("panel") as HTMLDivElement;

const canvas = document.createElement("canvas");
stage.append(canvas);

let renderer: GLRenderer;
try {
  renderer = new GLRenderer(canvas);
} catch (err) {
  panel.textContent = `WebGL2 failed: ${String(err)}`;
  throw err;
}

const sparks = new SparkSystem();

let cx = window.innerWidth * 0.42;
let cy = window.innerHeight * 0.5;
let radius = 170;
let frozen = false;
let showVision = false;

function resize(): void {
  renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
}
resize();
window.addEventListener("resize", resize);

stage.addEventListener("pointerdown", (e) => {
  cx = e.clientX;
  cy = e.clientY;
});

window.addEventListener("keydown", (e) => {
  if (e.key === "h" || e.key === "H") panel.classList.toggle("hidden");
  if (e.code === "Space") {
    e.preventDefault();
    frozen = !frozen;
  }
});

// ---------------------------------------------------------------- controls

interface Ctl {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
}

const ctl = (
  label: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (v: number) => void,
): Ctl => ({ label, min, max, step, get, set });

const L = <K extends keyof LookParams>(k: K, min: number, max: number, step: number) =>
  ctl(k, min, max, step, () => look[k], (v) => (look[k] = v));

const S = <K extends keyof typeof SPARK_TUNING>(
  k: K,
  min: number,
  max: number,
  step: number,
) => ctl(k, min, max, step, () => SPARK_TUNING[k], (v) => (SPARK_TUNING[k] = v));

const GROUPS: Array<[string, Ctl[]]> = [
  ["scene", [
    ctl("radius", 40, 420, 1, () => radius, (v) => (radius = v)),
  ]],
  ["filament", [
    L("core", 0, 6, 0.05),
    L("thickness", 0.001, 0.06, 0.0005),
    L("grain", 0, 1, 0.01),
    L("dust", 0, 3, 0.05),
    L("glow", 0, 2, 0.01),
    L("runes", 0, 1, 0.01),
  ]],
  ["sparks — shape", [
    L("streak", 0, 0.6, 0.005),
    S("size", 0.2, 4, 0.05),
    S("gravity", 0, 1400, 10),
    S("drag", 0.3, 1, 0.01),
  ]],
  ["sparks — long & oblique", [
    S("whipChance", 0, 1, 0.01),
    S("whipSpeed", 0, 6, 0.05),
    S("whipSpeedVar", 0, 8, 0.05),
    S("skewWhip", 0, 3, 0.02),
    S("skewBed", 0, 3, 0.02),
    S("bedSpeed", 0, 2, 0.01),
    S("bedSpeedVar", 0, 5, 0.05),
    S("inwardChance", 0, 0.5, 0.01),
  ]],
  ["emission", [
    S("rateIgnite", 0, 8000, 50),
    S("igniteSpeed", 40, 900, 10),
    S("igniteSpread", 0, 2, 0.05),
    S("rateOpen", 0, 5000, 50),
    S("rateHold", 0, 4000, 50),
    S("shedSpeed", 20, 600, 5),
    S("shedSpread", 0, 2, 0.05),
  ]],
];

const outputs: Array<() => void> = [];

for (const [title, controls] of GROUPS) {
  const h = document.createElement("h2");
  h.textContent = title;
  panel.append(h);

  for (const c of controls) {
    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("label");
    label.textContent = c.label;

    const out = document.createElement("output");
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(c.min);
    input.max = String(c.max);
    input.step = String(c.step);
    input.value = String(c.get());

    const sync = () => {
      const v = c.get();
      out.textContent = v >= 100 ? v.toFixed(0) : v.toFixed(4).replace(/0+$/, "");
      input.value = String(v);
    };
    input.addEventListener("input", () => {
      c.set(parseFloat(input.value));
      sync();
    });
    sync();
    outputs.push(sync);

    row.append(label, out, input);
    panel.append(row);
  }
}

const bar = document.createElement("div");
bar.className = "bar";

const mkButton = (text: string, fn: () => void) => {
  const b = document.createElement("button");
  b.textContent = text;
  b.addEventListener("click", fn);
  bar.append(b);
};

const dump = document.createElement("textarea");
dump.id = "out";
dump.readOnly = true;

function snapshot(): string {
  return [
    "// -> src/content/renderer/types.ts  DEFAULT_LOOK",
    JSON.stringify(look, null, 2),
    "",
    "// -> src/content/renderer/sparks.ts  SPARK_TUNING",
    JSON.stringify(SPARK_TUNING, null, 2),
  ].join("\n");
}

mkButton("copy values", () => {
  dump.value = snapshot();
  void navigator.clipboard?.writeText(dump.value);
});
mkButton("reset", () => {
  Object.assign(look, DEFAULT_LOOK);
  location.reload();
});
mkButton("vision on/off", () => {
  showVision = !showVision;
});

panel.append(bar, dump);

// -------------------------------------------------------------------- loop

renderer.setTint([0.09, 0.11, 0.16]);

// Without an image the vision pass draws a near-black wash, so the "vision"
// button looked broken. Give the tuner a real bitmap to composite.
void (async () => {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 320;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 512, 320);
  grad.addColorStop(0, "#2b5f9e");
  grad.addColorStop(0.5, "#8f4bb8");
  grad.addColorStop(1, "#d4713a");
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 320);
  g.fillStyle = "rgba(255,255,255,0.75)";
  for (let i = 0; i < 22; i++) {
    g.fillRect((i * 61) % 512, ((i * 97) % 300) + 10, 26, 10);
  }
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.fillRect(0, 240, 512, 80);
  renderer.setVisionImage(await createImageBitmap(c));
})();

let t0 = performance.now();
let last = t0;

function frame(now: number): void {
  requestAnimationFrame(frame);

  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (frozen) return;

  renderer.setLook(look);

  let elapsed = (now - t0) % T_TOTAL;

  let progress = 1;
  let open = 0;
  let energy = 1;
  let dissipate = 0;

  let liveRadius = radius;

  if (elapsed < T_IGNITE) {
    // Blooms outward from the centre; the full circle is lit from frame one.
    const t = clamp01(elapsed / T_IGNITE);
    liveRadius = Math.max(2, radius * easeOutQuint(t));
    energy = 0.25 + 0.75 * easeOutCubic(t);
    const rimSpeed = (radius / (T_IGNITE / 1000)) * (1 - t) * 0.55;
    sparks.emitAtRimRate(
      cx, cy, liveRadius, Math.random() * Math.PI * 2, 1,
      SPARK_TUNING.rateIgnite, dt,
      SPARK_TUNING.igniteSpeed + rimSpeed, SPARK_TUNING.igniteSpread,
    );
  } else if ((elapsed -= T_IGNITE) < T_OPEN) {
    open = easeOutQuint(clamp01(elapsed / T_OPEN));
    shed(dt, SPARK_TUNING.rateOpen);
  } else if ((elapsed -= T_OPEN) < T_HOLD) {
    open = 1;
    shed(dt, SPARK_TUNING.rateHold);
  } else if ((elapsed -= T_HOLD) < T_DISSIPATE) {
    if (elapsed < 20) sparks.emitBurst(cx, cy, radius, 520, 300);
    const d = clamp01(elapsed / T_DISSIPATE);
    open = 1 - easeInCubic(d);
    dissipate = d;
    energy = 1 - d;
  } else {
    energy = 0;
  }

  sparks.update(dt);

  const state: RenderState = {
    timeSec: (now - t0) / 1000,
    cx,
    cy,
    radius: liveRadius,
    progress,
    startAngle: 0,
    direction: 1,
    energy,
    spin: ((now - t0) / 1000) * 0.15,
    dissipate,
    open,
    showVision,
    visionFade: 1,
    lens: 0,
    swirl: 0,
    zoom: 1,
    hole: liveRadius * open,
    fade: 0,
  };

  renderer.render(state, sparks);
}

function shed(dt: number, rate: number): void {
  sparks.emitAtRimRate(
    cx, cy, radius, Math.random() * Math.PI * 2, 1,
    rate, dt, SPARK_TUNING.shedSpeed, SPARK_TUNING.shedSpread,
  );
}

requestAnimationFrame(frame);
