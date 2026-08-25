/**
 * Webcam trigger, running in an offscreen document.
 *
 * Why offscreen: `getUserMedia` from a content script asks for the *page's*
 * origin, so the user would be prompted on every site and could revoke it per
 * site. An offscreen document runs on the extension's own origin, so consent is
 * asked once (from the camera page) and holds everywhere. `USER_MEDIA` is the
 * sanctioned reason for one.
 *
 * All the detection lives in shared/handtrack.ts, which the camera page's
 * diagnostic view also drives — so what that page draws is exactly what fires
 * the portal.
 */
import { VideoTracker, type TrackResult } from "../shared/handtrack";
import { loadSettings } from "../shared/settings";

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let tracker: VideoTracker | null = null;

/**
 * Size of the tab we are driving. The tracker needs it to size its active box
 * and to give the recogniser real pixels; it arrives from the content script via
 * the worker, and can arrive before the camera has started, so it is remembered
 * either way.
 */
let viewport: { width: number; height: number } | null = null;

function applyViewport(): void {
  if (viewport) tracker?.tracker.setViewport(viewport.width, viewport.height);
}

function post(msg: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    /* worker asleep */
  }
}

/** Live stroke updates are throttled: they relay through the worker. */
const PREVIEW_HZ = 22;
let lastPreview = 0;
let wasArmed = false;

let lastStatus = "";
function onResult(r: TrackResult): void {
  // Arming is the moment to tell the tab: it can snapshot the page for the lens
  // before any ring is on screen, and start drawing the stroke back to the user.
  if (r.armed !== wasArmed) {
    wasArmed = r.armed;
    post({ type: "HAND_ARMED", armed: r.armed });
  }

  const now = performance.now();
  // Sent as soon as the pose is held, with or without a fitted circle: the
  // sparks have to appear on the fingertip immediately, and a fit needs several
  // samples before it exists at all.
  if (r.armed && r.x !== null && r.y !== null && now - lastPreview >= 1000 / PREVIEW_HZ) {
    lastPreview = now;
    post({
      type: "HAND_PREVIEW",
      pointerXFrac: r.x,
      pointerYFrac: r.y,
      centerXFrac: r.stroke?.centerX ?? null,
      centerYFrac: r.stroke?.centerY ?? null,
      radiusFrac: r.stroke?.radius ?? null,
      startAngle: r.stroke?.startAngle ?? 0,
      direction: r.stroke?.direction ?? 1,
      progress: r.stroke?.progress ?? 0,
    });
  }

  const status = r.x === null ? "idle" : r.armed ? "tracking" : "pose";
  if (status !== lastStatus) {
    lastStatus = status;
    post({
      type: "HAND_STATUS",
      running: true,
      tracking: status === "tracking",
      pose: status,
    });
  }

  if (!r.gesture) return;

  // Fractions, not pixels. The tracker was measuring against the tab's own
  // viewport, so these normalise by the same numbers and land back on it 1:1.
  const vw = tracker?.tracker.viewW ?? 1;
  const vh = tracker?.tracker.viewH ?? 1;
  post({
    type: "HAND_GESTURE",
    centerXFrac: r.gesture.centerX / vw,
    centerYFrac: r.gesture.centerY / vh,
    radiusFrac: r.gesture.radius / vw,
    direction: r.gesture.direction,
    startAngle: r.gesture.startAngle,
  });
}

async function start(): Promise<boolean> {
  if (stream) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: "user" },
      audio: false,
    });
  } catch (err) {
    post({ type: "HAND_STATUS", running: false, error: String(err) });
    return false;
  }

  video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  // Attached, not detached: a detached <video> is not guaranteed to keep
  // decoding frames, and drawImage would then read a blank one forever.
  video.style.position = "fixed";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  document.body.appendChild(video);

  try {
    await video.play();
  } catch (err) {
    post({ type: "HAND_STATUS", running: false, error: String(err) });
    stop();
    return false;
  }

  tracker = new VideoTracker(video, onResult);
  const settings = await loadSettings();
  tracker.tracker.pose = settings.handPose;
  applyViewport();
  const modelOk = await tracker.load(chrome.runtime.getURL(""));
  tracker.start();
  post({
    type: "HAND_STATUS",
    running: true,
    tracking: false,
    engine: modelOk ? "landmarks" : "blob",
    error: tracker.tracker.loadError,
  });
  lastStatus = "";
  return true;
}

function stop(): void {
  tracker?.stop();
  tracker = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video?.remove();
  video = null;
  lastStatus = "";
  post({ type: "HAND_STATUS", running: false });
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw as { type?: string; target?: string; width?: number; height?: number };
  if (msg?.target !== "offscreen") return false;

  if (msg.type === "HAND_VIEWPORT") {
    if (msg.width && msg.height) {
      viewport = { width: msg.width, height: msg.height };
      applyViewport();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "HAND_START") {
    void start().then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg.type === "HAND_STOP") {
    stop();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "HAND_PING") {
    sendResponse({ ok: true, running: Boolean(stream) });
    return false;
  }
  return false;
});
