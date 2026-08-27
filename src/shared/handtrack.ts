import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import {
  GestureBuffer,
  HAND_WINDOW,
  type GestureResult,
  type StrokePreview,
} from "../content/gesture";
import { activeBox, mapToViewport, type ActiveBox } from "./handmap";
import { OneEuroFilter2D } from "./onefilter";

/**
 * Webcam hand tracking, shared by the offscreen tracker and the diagnostic view
 * on the camera page — so what that page draws is literally what fires the
 * portal, not a reimplementation of it.
 *
 * Primary path: MediaPipe Hand Landmarker (Google, Apache-2.0), bundled locally.
 * 21 landmarks per hand, which buys three things the old skin-colour blob could
 * never do:
 *   - a precise fingertip position instead of a centroid that averaged the hand
 *     with the user's face whenever both were moving
 *   - immunity to skin tone, wooden furniture and warm lighting
 *   - actual finger poses, so "circle with two fingers raised" is detectable
 *
 * Fallback path: the original skin+motion centroid, kept for when the model
 * cannot load (WASM blocked, corrupt asset, ancient hardware). It is much worse.
 * It is not meant to be good; it is meant to be better than nothing.
 */

/** Analysis resolution for the fallback tracker. */
export const TRACK_W = 160;
export const TRACK_H = 120;

/**
 * Viewport assumed until the active tab reports its real size.
 *
 * The recogniser's thresholds are in screen pixels (min radius 40px, max 45% of
 * the smaller side), so it has to be told what a screen pixel is. Once
 * `setViewport()` has been called this is the tab's actual viewport and the
 * thresholds mean exactly what they say; until then it is a plausible stand-in.
 *
 * This used to be a fixed 1280x960 "virtual viewport" that existed to widen the
 * usable range of gesture sizes. That job now belongs to the active box in
 * `handmap.ts`, which does it without also lying about the aspect ratio.
 */
export const DEFAULT_VIEW_W = 1280;
export const DEFAULT_VIEW_H = 720;

/** Fallback frame shape for a camera that has not reported its dimensions yet. */
const DEFAULT_FRAME_ASPECT = 4 / 3;

export type HandPose = "any" | "twoFingers";

export const HAND_TUNING = {
  /** Refractory period after firing, so one circle is not read as three. */
  cooldownMs: 1200,
  /**
   * Consecutive good frames before the pose counts as held, and consecutive bad
   * frames before it counts as dropped.
   *
   * The asymmetry is the whole point. Landmark inference flickers — a fingertip
   * is misjudged as folded for one frame in the middle of a stroke — and
   * clearing the buffer on that single frame destroyed the entire circle the
   * user was drawing. Arming is quick; disarming is deliberately slow.
   */
  armFrames: 3,
  disarmFrames: 9,
  /** Landmark confidence below which a hand is ignored. */
  minConfidence: 0.5,
  /** Fallback tracker only. */
  motionThreshold: 16,
  minCoverage: 0.004,
  maxCoverage: 0.45,
};

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface TrackResult {
  /** "landmarks" when MediaPipe is driving, "blob" on the fallback path. */
  source: "landmarks" | "blob";
  /** Pointer position in normalised [0,1] coordinates, already mirrored. */
  x: number | null;
  y: number | null;
  /** All 21 landmarks, normalised and mirrored. Empty on the fallback path. */
  landmarks: Landmark[];
  /** Which fingers read as extended: thumb, index, middle, ring, pinky. */
  fingers: boolean[];
  /** True when this frame's pose satisfies the gate. Flickers; do not act on it. */
  poseOk: boolean;
  /** Debounced version of poseOk. This is what gates recognition. */
  armed: boolean;
  /** The stroke in progress, normalised [0,1], for live feedback. */
  stroke: StrokePreview | null;
  /** Set on the frame a circle completes. */
  gesture: GestureResult | null;
  /** Fallback tracker only: fraction of sampled pixels that were moving skin. */
  coverage: number;
}

const EMPTY: TrackResult = {
  source: "landmarks",
  x: null,
  y: null,
  landmarks: [],
  fingers: [false, false, false, false, false],
  poseOk: false,
  armed: false,
  stroke: null,
  gesture: null,
  coverage: 0,
};

/** Bone pairs for drawing a skeleton. */
export const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const TIPS = [4, 8, 12, 16, 20];
const PIPS = [2, 6, 10, 14, 18];

/**
 * A finger is extended when its tip is further from the wrist than its middle
 * joint. Comparing distances rather than y-coordinates keeps this correct when
 * the hand is rotated or upside down.
 */
export function fingersExtended(lm: Landmark[]): boolean[] {
  if (lm.length < 21) return [false, false, false, false, false];
  const w = lm[0]!;
  const d = (p: Landmark) => Math.hypot(p.x - w.x, p.y - w.y);
  return TIPS.map((tip, i) => {
    const slack = i === 0 ? 1.05 : 1.12; // the thumb barely folds
    return d(lm[tip]!) > d(lm[PIPS[i]!]!) * slack;
  });
}

export function poseSatisfied(fingers: boolean[], pose: HandPose): boolean {
  if (pose === "any") return true;
  // Index and middle up, ring and pinky folded. The thumb is ignored: it sits
  // wherever it likes and gating on it makes the gesture fussy.
  return fingers[1] === true && fingers[2] === true && !fingers[3] && !fingers[4];
}

// ---------------------------------------------------------------------------

/**
 * MediaPipe's own log lines, kept out of the extension's error list.
 *
 * The bundled runtime is a C++ program compiled to WASM, and it kept its glog
 * chatter: a few lines every time a landmarker is built, and a few more every
 * time the graph re-initialises behind a lost hand.
 *
 *     W0825 08:07:19.622 … gl_context.cc:1119] OpenGL error checking is
 *     disabled
 *     W0825 08:07:19.792 … landmark_projection_calculator.cc:81] Using
 *     NORM_RECT without IMAGE_DIMENSIONS is only supported for the square ROI.
 *
 * Both are warnings about the graph MediaPipe itself ships — the projection one
 * is emitted from inside `hand_landmarker.task`, which we do not build and
 * cannot configure — and the tracker works. But Emscripten binds the program's
 * stderr to `console.error`, and `chrome://extensions` collects every
 * `console.error` from an extension context into the card's Errors list. So a
 * healthy load looks like five errors, and a real one is buried among them.
 *
 * Emscripten reads `Module.printErr` once, at startup, and keeps it for the
 * life of the instance; `@mediapipe/tasks-vision` passes `self.Module` straight
 * through to its module factory. So the global is borrowed for exactly one
 * construction, while the routing it installs lasts as long as the tracker —
 * which it must, because the projection warning is emitted per detection and
 * not once at build.
 */
const GLOG_LINE = /^([IWEF])\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+[\w./-]+:\d+\]/;

/**
 * TFLite's logger, which is not glog and does not look like it.
 *
 *     INFO: Created TensorFlow Lite XNNPACK delegate for CPU.
 *
 * The graph runner uses glog; the interpreter underneath it uses this. That
 * line is emitted every time the CPU delegate is built — so on any machine
 * taking the CPU path it is the most frequent line of the whole load, and
 * having no glog prefix it fell through to `console.error` and was collected.
 *
 * Only the two informational levels are listed. `ERROR:` stays an error, and
 * the prefix has to be exact: prose that merely opens with a capital W is not
 * a warning, and an Emscripten abort is not to be demoted by accident.
 */
const TFLITE_LINE = /^(INFO|WARNING): /;

/**
 * Demoted, not deleted: an INFO or WARNING from the runtime still reaches the
 * console, at the level DevTools hides behind Verbose and the extensions page
 * does not collect. Anything MediaPipe considers an actual error — a delegate
 * that will not start, a model it cannot parse — is still an error here, which
 * is the whole reason for not simply muting the stream.
 */
export function routeWasmLog(line: string): void {
  const level = GLOG_LINE.exec(line)?.[1];
  if (level === "I" || level === "W" || TFLITE_LINE.test(line)) console.debug(line);
  else console.error(line);
}

/**
 * The stderr sink for one construction, and the handle that ends its grace period.
 *
 * `speculative` marks a build whose failure is already handled — the GPU probe
 * in `load()`, which is retried on CPU. On a machine whose driver refuses the
 * delegate in an unrendered offscreen document, that refusal happens on EVERY
 * start and MediaPipe reports it at ERROR level:
 *
 *     E0825 10:14:04.401999 … gl_graph_runner_internal.cc:255] StartGraph
 *     failed: NOT_FOUND: Unable to open file at /model.dat
 *
 * Routing that by level alone puts a fresh error in the extension's card every
 * time the tracker starts, and they accumulate across worker restarts until the
 * list is nothing but this one expected line. So while the probe is in flight
 * its output is demoted wholesale — level rule included, because the failure
 * arrives as an `E` and an Emscripten abort would arrive with no prefix at all.
 *
 * `settle()` is not optional. Emscripten reads `printErr` once and keeps it for
 * the life of the instance, so a probe that SUCCEEDS would otherwise leave a
 * permanently muted runtime behind — every later error from the landmarker that
 * is actually doing the work, swallowed. The grace period covers the attempt,
 * not the instance.
 */
export function makeWasmLogSink(speculative: boolean): {
  printErr: (line: string) => void;
  settle: () => void;
} {
  let building = speculative;
  return {
    printErr: (line: string) => {
      if (building) console.debug(line);
      else routeWasmLog(line);
    },
    settle: () => {
      building = false;
    },
  };
}

/**
 * Run one MediaPipe construction with its stderr routed through `routeWasmLog`.
 *
 * `tasks-vision` hands `self.Module` to the Emscripten factory and then clears
 * it, so the global is only borrowed for this call; the routing it hands over
 * lives on inside the instance. The `finally` covers the throw before it gets
 * that far — a GPU attempt a driver refuses is a normal path here, not an
 * exceptional one — and settles the sink either way, so the demotion never
 * outlives the attempt that earned it.
 */
async function withQuietRuntime<T>(
  build: () => Promise<T>,
  speculative = false,
): Promise<T> {
  const scope = globalThis as { Module?: unknown };
  const had = "Module" in scope;
  const previous = scope.Module;
  const sink = makeWasmLogSink(speculative);
  scope.Module = { printErr: sink.printErr };
  try {
    return await build();
  } finally {
    sink.settle();
    if (had) scope.Module = previous;
    else delete scope.Module;
  }
}

// ---------------------------------------------------------------------------

export class HandTracker {
  /**
   * The hand budget, not the mouse one. At 25 Hz the default 1200 ms leaves
   * thirty frames to cover 1.75 turns, which is why the gesture used to demand
   * a fast sharp sweep and why the traced arc shortened from its own start
   * while the circle was still being drawn.
   */
  private buffer = new GestureBuffer(HAND_WINDOW);
  private lastFire = -Infinity;

  private landmarker: HandLandmarker | null = null;
  private lastVideoTime = -1;

  /** Fallback state. */
  private prev: Uint8ClampedArray | null = null;

  private poseGood = 0;
  private poseBad = 0;
  private isArmed = false;

  /**
   * The viewport the recogniser measures against, and the camera frame shape the
   * active box is cut from. Both are needed to build the box, so both are kept
   * and the box is rebuilt whenever either changes.
   */
  private vw = DEFAULT_VIEW_W;
  private vh = DEFAULT_VIEW_H;
  private frameAspect = DEFAULT_FRAME_ASPECT;
  private activeBoxCache: ActiveBox = activeBox(
    DEFAULT_VIEW_W / DEFAULT_VIEW_H,
    DEFAULT_FRAME_ASPECT,
  );

  /** Smooths the amplified fingertip. See onefilter.ts for why it is adaptive. */
  private smooth = new OneEuroFilter2D();

  pose: HandPose = "twoFingers";
  /** Null until load() has been attempted. */
  ready = false;
  usingFallback = false;
  loadError: string | null = null;

  /** Set to a canvas 2D context to receive the fallback's debug mask. */
  debugCtx: CanvasRenderingContext2D | null = null;

  /**
   * One construction attempt, with the runtime's stderr routed to debug.
   *
   * The fileset is resolved per attempt rather than hoisted: the CPU retry
   * only runs once the GPU attempt has thrown, and resolving it again is a
   * path lookup, not a second download.
   */
  private buildLandmarker(
    baseUrl: string,
    delegate: "GPU" | "CPU",
  ): Promise<HandLandmarker> {
    // The GPU pass is a probe: `load()` retries on CPU, so its stderr is noise
    // on any machine that refuses the delegate. The CPU pass is the real load
    // and keeps every error it reports.
    return withQuietRuntime(async () => {
      const fileset = await FilesetResolver.forVisionTasks(`${baseUrl}mediapipe`);
      return HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${baseUrl}models/hand_landmarker.task`,
          delegate,
        },
        numHands: 1,
        runningMode: "VIDEO",
        minHandDetectionConfidence: HAND_TUNING.minConfidence,
        minHandPresenceConfidence: HAND_TUNING.minConfidence,
        minTrackingConfidence: HAND_TUNING.minConfidence,
      });
    }, delegate === "GPU");
  }

  async load(baseUrl: string): Promise<boolean> {
    if (this.landmarker) return true;
    try {
      // GPU is markedly faster, but an offscreen document is not rendered and
      // some drivers refuse it there. Fall back rather than fail.
      this.landmarker = await this.buildLandmarker(baseUrl, "GPU");
      this.ready = true;
      this.usingFallback = false;
      return true;
    } catch (gpuErr) {
      try {
        this.landmarker = await this.buildLandmarker(baseUrl, "CPU");
        this.ready = true;
        this.usingFallback = false;
        return true;
      } catch (cpuErr) {
        this.loadError = `${String(gpuErr)} / ${String(cpuErr)}`;
        this.usingFallback = true;
        this.ready = true;
        return false;
      }
    }
  }

  reset(): void {
    this.buffer.clear();
    this.prev = null;
    this.lastVideoTime = -1;
    this.poseGood = 0;
    this.poseBad = 0;
    this.isArmed = false;
    this.smooth.reset();
  }

  /**
   * Tell the tracker how big the screen it is driving actually is.
   *
   * Two things depend on it: the recogniser's pixel thresholds, and the shape of
   * the active box — which is what keeps a circle drawn in the air from arriving
   * on a 16:9 display as an ellipse. The offscreen tracker learns this from the
   * active tab; the diagnostic view uses the physical screen.
   */
  setViewport(width: number, height: number): void {
    if (!(width > 0) || !(height > 0)) return;
    if (width === this.vw && height === this.vh) return;
    this.vw = width;
    this.vh = height;
    this.rebuildBox();
    // Mid-stroke the buffer holds samples measured against the old geometry.
    this.buffer.clear();
    this.smooth.reset();
  }

  private setFrameAspect(aspect: number): void {
    if (!(aspect > 0) || Math.abs(aspect - this.frameAspect) < 1e-6) return;
    this.frameAspect = aspect;
    this.rebuildBox();
  }

  private rebuildBox(): void {
    this.activeBoxCache = activeBox(this.vw / this.vh, this.frameAspect);
  }

  /** The region of the camera frame that maps onto the whole viewport. */
  get box(): ActiveBox {
    return this.activeBoxCache;
  }

  get viewW(): number {
    return this.vw;
  }

  get viewH(): number {
    return this.vh;
  }

  /**
   * Camera-frame fraction -> viewport fraction, smoothed.
   *
   * `t` is seconds. Order matters: map first, then filter. Filtering in camera
   * space and amplifying afterwards would amplify whatever jitter the filter
   * left behind, which is the problem this is here to solve.
   */
  private toViewport(x: number, y: number, t: number): { x: number; y: number } {
    const m = mapToViewport(x, y, this.activeBoxCache);
    return this.smooth.filter(m.x, m.y, t);
  }

  /** Debounce the per-frame pose into a stable armed/disarmed state. */
  private updateArmed(poseOk: boolean): boolean {
    if (poseOk) {
      this.poseGood++;
      this.poseBad = 0;
      if (this.poseGood >= HAND_TUNING.armFrames) this.isArmed = true;
    } else {
      this.poseBad++;
      this.poseGood = 0;
      if (this.poseBad >= HAND_TUNING.disarmFrames && this.isArmed) {
        this.isArmed = false;
        this.buffer.clear();
      }
    }
    return this.isArmed;
  }

  /** Normalise a stroke from viewport pixels back to [0,1]. */
  private normStroke(s: StrokePreview | null): StrokePreview | null {
    if (!s) return null;
    return {
      centerX: s.centerX / this.vw,
      centerY: s.centerY / this.vh,
      radius: s.radius / this.vw,
      startAngle: s.startAngle,
      direction: s.direction,
      progress: s.progress,
    };
  }

  /** MediaPipe path. `now` is milliseconds. */
  stepVideo(video: HTMLVideoElement, now: number): TrackResult {
    const lm = this.landmarker;
    if (!lm) return { ...EMPTY };

    // detectForVideo rejects a timestamp it has already seen.
    if (video.currentTime === this.lastVideoTime) return { ...EMPTY, source: "landmarks" };
    this.lastVideoTime = video.currentTime;

    // The requested 320x240 is a hint; the camera hands back whatever it likes,
    // and the box has to be cut from the shape actually delivered.
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      this.setFrameAspect(video.videoWidth / video.videoHeight);
    }

    let res;
    try {
      res = lm.detectForVideo(video, now);
    } catch {
      return { ...EMPTY };
    }

    const hand = res.landmarks?.[0];
    if (!hand || hand.length < 21) {
      return { ...EMPTY };
    }

    // The webcam image is mirrored relative to how the user perceives their hand.
    const landmarks: Landmark[] = hand.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
    const fingers = fingersExtended(landmarks);
    const poseOk = poseSatisfied(fingers, this.pose);

    // With two fingers raised the natural centre to follow is between their
    // tips; otherwise track the index fingertip.
    const idx = landmarks[8]!;
    const mid = landmarks[12]!;
    const useMid = fingers[1] === true && fingers[2] === true;
    const fx = useMid ? (idx.x + mid.x) / 2 : idx.x;
    const fy = useMid ? (idx.y + mid.y) / 2 : idx.y;

    // Everything downstream — the recogniser, the spark trail, the disc centre —
    // works in viewport fractions, so the conversion happens exactly here and
    // exactly once. `landmarks` stay in camera space: the diagnostic view draws
    // them over the camera picture.
    const { x: px, y: py } = this.toViewport(fx, fy, now / 1000);

    const armed = this.updateArmed(poseOk);
    if (!armed) {
      // Hand visible but the pose is not held. Show it; accumulate nothing.
      return {
        source: "landmarks",
        x: px,
        y: py,
        landmarks,
        fingers,
        poseOk,
        armed: false,
        stroke: null,
        gesture: null,
        coverage: 0,
      };
    }

    // Only samples taken while the pose is held reach the recogniser. A dropped
    // frame or two in the middle no longer costs the stroke.
    const hit = poseOk
      ? this.buffer.feed(
          { x: px * this.vw, y: py * this.vh, t: now },
          { width: this.vw, height: this.vh },
        )
      : null;

    const stroke = this.normStroke(this.buffer.preview());

    let gesture: GestureResult | null = null;
    if (hit && now - this.lastFire >= HAND_TUNING.cooldownMs) {
      this.lastFire = now;
      this.buffer.clear();
      gesture = hit;
    }

    return {
      source: "landmarks",
      x: px,
      y: py,
      landmarks,
      fingers,
      poseOk,
      armed: true,
      stroke,
      gesture,
      coverage: 0,
    };
  }

  /**
   * Fallback path: skin colour intersected with motion, tracked as a centroid.
   * Kept only for when the model will not load.
   */
  stepFrame(frame: Uint8ClampedArray, now: number): TrackResult {
    let sx = 0;
    let sy = 0;
    let count = 0;
    let sampled = 0;

    const dbg = this.debugCtx;
    const mask = dbg ? dbg.createImageData(TRACK_W, TRACK_H) : null;

    for (let y = 0; y < TRACK_H; y += 2) {
      for (let x = 0; x < TRACK_W; x += 2) {
        sampled++;
        const i = (y * TRACK_W + x) * 4;
        const r = frame[i]!;
        const g = frame[i + 1]!;
        const b = frame[i + 2]!;
        if (!isSkin(r, g, b)) continue;
        if (this.prev) {
          const d =
            Math.abs(r - this.prev[i]!) +
            Math.abs(g - this.prev[i + 1]!) +
            Math.abs(b - this.prev[i + 2]!);
          if (d < HAND_TUNING.motionThreshold) continue;
        }
        sx += x;
        sy += y;
        count++;
        if (mask) {
          for (let oy = 0; oy < 2; oy++) {
            for (let ox = 0; ox < 2; ox++) {
              const o = ((y + oy) * TRACK_W + (x + ox)) * 4;
              mask.data[o] = 255;
              mask.data[o + 1] = 138;
              mask.data[o + 2] = 31;
              mask.data[o + 3] = 190;
            }
          }
        }
      }
    }

    this.prev = frame.slice();
    if (mask && dbg) dbg.putImageData(mask, 0, 0);

    const coverage = count / Math.max(1, sampled);
    if (coverage < HAND_TUNING.minCoverage || coverage > HAND_TUNING.maxCoverage) {
      return { ...EMPTY, source: "blob", coverage };
    }

    // The fallback analyses a fixed TRACK_W x TRACK_H buffer, so its frame shape
    // is that, not the camera's.
    this.setFrameAspect(TRACK_W / TRACK_H);
    const fx = (TRACK_W - sx / count) / TRACK_W;
    const fy = sy / count / TRACK_H;
    const { x: cx, y: cy } = this.toViewport(fx, fy, now / 1000);

    const hit = this.buffer.feed(
      { x: cx * this.vw, y: cy * this.vh, t: now },
      { width: this.vw, height: this.vh },
    );

    let gesture: GestureResult | null = null;
    if (hit && now - this.lastFire >= HAND_TUNING.cooldownMs) {
      this.lastFire = now;
      this.buffer.clear();
      gesture = hit;
    }

    return {
      source: "blob",
      x: cx,
      y: cy,
      landmarks: [],
      fingers: EMPTY.fingers,
      poseOk: true,
      armed: true,
      stroke: this.normStroke(this.buffer.preview()),
      gesture,
      coverage,
    };
  }

  /**
   * Recent pointer trail, in VIEWPORT fractions. The diagnostic view has to run
   * these back through `unmapFromViewport` before drawing them over the camera
   * picture, or the stroke appears 1.6x bigger than the hand that made it.
   */
  trail(): Array<{ x: number; y: number }> {
    return this.buffer.samples.map((s) => ({
      x: s.x / this.vw,
      y: s.y / this.vh,
    }));
  }
}

/** Fallback-only skin test, in YCbCr so lighting moves it less than RGB would. */
export function isSkin(r: number, g: number, b: number): boolean {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cb >= 77 && cb <= 130 && cr >= 133 && cr <= 178;
}

/**
 * Drives a tracker from a <video>.
 *
 * setInterval, NOT requestAnimationFrame: an offscreen document is never
 * rendered, so its rAF callbacks never fire and the whole loop silently does
 * nothing. That was the original bug — the camera opened and the tracker never
 * ran a single frame.
 */
export class VideoTracker {
  readonly tracker = new HandTracker();
  private timer: ReturnType<typeof setInterval> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private busy = false;

  constructor(
    private video: HTMLVideoElement,
    private onResult: (r: TrackResult) => void,
    private intervalMs = 40,
  ) {}

  async load(baseUrl: string): Promise<boolean> {
    return this.tracker.load(baseUrl);
  }

  start(): void {
    if (this.timer) return;
    if (this.tracker.usingFallback) {
      this.canvas = document.createElement("canvas");
      this.canvas.width = TRACK_W;
      this.canvas.height = TRACK_H;
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    this.tracker.reset();
    this.timer = setInterval(() => this.step(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.canvas = null;
    this.ctx = null;
    this.tracker.reset();
  }

  private step(): void {
    const video = this.video;
    if (this.busy || video.readyState < 2 || video.videoWidth === 0) return;
    this.busy = true;
    try {
      if (this.tracker.usingFallback) {
        const ctx = this.ctx;
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, TRACK_W, TRACK_H);
        const frame = ctx.getImageData(0, 0, TRACK_W, TRACK_H).data;
        this.onResult(this.tracker.stepFrame(frame, performance.now()));
      } else {
        this.onResult(this.tracker.stepVideo(video, performance.now()));
      }
    } finally {
      this.busy = false;
    }
  }
}
