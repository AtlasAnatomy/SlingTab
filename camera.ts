import { loadSettings, patchSettings } from "./src/shared/settings";
import { HAND_CONNECTIONS, VideoTracker } from "./src/shared/handtrack";
import { boxRect, unmapFromViewport } from "./src/shared/handmap";

/**
 * Camera consent, in a real tab, plus a live diagnostic view.
 *
 * Consent cannot be collected from the popup: Chrome closes an extension popup
 * as soon as it loses focus, and the permission bubble takes focus — so
 * `getUserMedia` is called, the popup dies, the promise never settles and the
 * button appears inert. A tab-based extension page survives the prompt.
 *
 * The diagnostic view drives the SAME tracker the offscreen document runs, so
 * what is drawn here is exactly what fires the portal — not a lookalike.
 */

const ask = document.getElementById("ask") as HTMLButtonElement;
const done = document.getElementById("done") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;
const stage = document.getElementById("stage") as HTMLDivElement;
const preview = document.getElementById("preview") as HTMLVideoElement;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;
const live = document.getElementById("live") as HTMLDivElement;
const liveText = document.getElementById("liveText") as HTMLSpanElement;
const dot = document.getElementById("dot") as HTMLElement;
const fired = document.getElementById("fired") as HTMLSpanElement;
const hint = document.getElementById("hint") as HTMLParagraphElement;
const boxHint = document.getElementById("boxHint") as HTMLParagraphElement;

let stream: MediaStream | null = null;
let tracker: VideoTracker | null = null;
let firedTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(kind: "ok" | "warn", text: string): void {
  status.className = `status ${kind}`;
  status.textContent = text;
}

function stop(): void {
  tracker?.stop();
  tracker = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  preview.srcObject = null;
}

const FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"];

/**
 * The active box: the part of the camera picture that maps onto the whole
 * screen. Drawn because it is otherwise invisible and completely determines
 * where a gesture can land — a hand outside it is pinned to the screen edge.
 *
 * The canvas is mirrored by CSS and the box is centred, so it needs no flip.
 */
function drawActiveBox(
  ctx: CanvasRenderingContext2D,
  box: { w: number; h: number },
  W: number,
  H: number,
): void {
  const r = boxRect(box);
  const x = r.x * W;
  const y = r.y * H;
  const w = r.w * W;
  const h = r.h * H;

  // Dim what falls outside it, which reads faster than an outline alone.
  ctx.save();
  ctx.fillStyle = "rgba(6, 4, 2, 0.42)";
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(x, y, w, h);
  ctx.fill("evenodd");

  ctx.strokeStyle = "rgba(255, 210, 122, 0.75)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);

  // Corner ticks, so the shape reads as a frame rather than as a selection.
  const tick = Math.min(w, h) * 0.14;
  ctx.strokeStyle = "rgba(255, 226, 190, 0.95)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (const [cx, sx] of [[x, 1], [x + w, -1]] as const) {
    for (const [cy, sy] of [[y, 1], [y + h, -1]] as const) {
      ctx.moveTo(cx + sx * tick, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * tick);
    }
  }
  ctx.stroke();
  ctx.restore();
}

async function startDiagnostics(): Promise<void> {
  const ctx = overlay.getContext("2d");
  if (!ctx) return;
  const W = overlay.width;
  const H = overlay.height;

  tracker = new VideoTracker(preview, (r) => {
    ctx.clearRect(0, 0, W, H);
    drawActiveBox(ctx, tracker!.tracker.box, W, H);
    // Only the fallback detector paints a pixel mask; the landmark path draws
    // a skeleton instead.
    tracker!.tracker.debugCtx = r.source === "blob" ? ctx : null;

    const tracked = r.x !== null;
    dot.classList.toggle("on", tracked && r.armed);

    if (!tracked) {
      liveText.textContent =
        r.source === "blob" ? "waiting for a moving hand…" : "no hand in frame";
    } else if (!r.armed) {
      const up = r.fingers
        .map((on, i) => (on ? FINGER_NAMES[i] : null))
        .filter(Boolean)
        .join(", ");
      liveText.textContent = `hand seen — raise index + middle only (now: ${up || "fist"})`;
    } else {
      const pct = Math.round((r.stroke?.progress ?? 0) * 100);
      liveText.textContent = `pose held — circle ${pct}%`;
    }

    // The skeleton, in normalised coordinates scaled to the overlay.
    if (r.landmarks.length === 21) {
      ctx.strokeStyle = "rgba(255, 138, 31, 0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        const p = r.landmarks[a]!;
        const q = r.landmarks[b]!;
        // Undo the mirroring, because the canvas itself is mirrored by CSS.
        ctx.moveTo((1 - p.x) * W, p.y * H);
        ctx.lineTo((1 - q.x) * W, q.y * H);
      }
      ctx.stroke();

      r.landmarks.forEach((p, i) => {
        const tip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
        ctx.fillStyle = tip ? "#ffd27a" : "rgba(255, 226, 190, 0.7)";
        ctx.beginPath();
        ctx.arc((1 - p.x) * W, p.y * H, tip ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // The path the recogniser is actually accumulating. It holds VIEWPORT
    // fractions, so it has to come back through the box before it can be drawn
    // over the camera picture — otherwise the stroke appears amplified by
    // exactly the factor the box applies, and no longer follows the fingertip.
    const box = tracker!.tracker.box;
    const trail = tracker!.tracker.trail();
    if (trail.length > 1) {
      ctx.strokeStyle = "rgba(255, 244, 220, 0.95)";
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      trail.forEach((p, i) => {
        const f = unmapFromViewport(p.x, p.y, box);
        const x = (1 - f.x) * W;
        const y = f.y * H;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    if (r.gesture) {
      fired.classList.add("on");
      if (firedTimer) clearTimeout(firedTimer);
      firedTimer = setTimeout(() => fired.classList.remove("on"), 700);
    }
  });

  const s = await loadSettings();
  tracker.tracker.pose = s.handPose;
  // Shape the box for this monitor. On a real page the content script reports
  // the tab's viewport instead; the screen is the closest stand-in here, and it
  // is what makes the drawn rectangle mean something.
  tracker.tracker.setViewport(window.screen.width, window.screen.height);

  liveText.textContent = "loading the hand model…";
  const ok = await tracker.load(chrome.runtime.getURL(""));
  if (!ok) {
    setStatus(
      "warn",
      "The hand landmark model could not load, so SlingTab fell back to the much cruder skin-and-motion detector. Check the console on this page for the reason.",
    );
    console.warn("SlingTab: hand model failed to load", tracker.tracker.loadError);
  }
  tracker.start();
}

ask.addEventListener("click", async () => {
  ask.disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: "user" },
      audio: false,
    });
  } catch (err) {
    ask.disabled = false;
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError") {
      setStatus(
        "warn",
        "Permission was declined. Open the padlock icon in the address bar of this tab, set Camera to Allow, then reload this page.",
      );
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      setStatus("warn", "No camera was found on this device.");
    } else {
      setStatus("warn", `The camera could not be opened: ${String(err)}`);
    }
    return;
  }

  preview.srcObject = stream;
  await preview.play().catch(() => {});
  stage.classList.remove("hidden");
  live.classList.remove("hidden");
  hint.classList.remove("hidden");
  boxHint.classList.remove("hidden");
  setStatus(
    "ok",
    "Camera enabled. Try the gesture below — when the badge lights up, the same thing will open a portal on any page.",
  );
  ask.classList.add("hidden");
  done.classList.remove("hidden");

  void startDiagnostics();

  // Select the trigger for them: they came here to turn it on.
  await patchSettings({ trigger: "hand", enabled: true });
  try {
    await chrome.runtime.sendMessage({ type: "TRIGGER_CHANGED" });
  } catch {
    /* worker asleep; it re-reads settings on wake */
  }
});

done.addEventListener("click", () => {
  stop();
  window.close();
});

// Release the preview as soon as this page goes away; the offscreen document
// opens its own stream and two are not needed.
window.addEventListener("pagehide", stop);
