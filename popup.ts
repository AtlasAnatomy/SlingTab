import {
  loadSettings,
  patchSettings,
  onSettingsChanged,
  type Settings,
  type TriggerMode,
} from "./src/shared/settings";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const enabled = $<HTMLInputElement>("enabled");
const powerLabel = $<HTMLSpanElement>("powerLabel");
const camBox = $<HTMLDivElement>("cam");
const grantBtn = $<HTMLButtonElement>("grant");
const optionsBtn = $<HTMLAnchorElement>("options");

const radios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="trigger"]'),
);

let settings: Settings | null = null;
/** Nothing may be written until the form has been populated from storage. */
let ready = false;

function paint(s: Settings): void {
  settings = s;
  enabled.checked = s.enabled;
  // `live` drives the mark: the arc closes when SlingTab is on. One class, so
  // the state can never disagree with the picture of it.
  document.body.classList.toggle("live", s.enabled);
  powerLabel.textContent = s.enabled ? "on" : "off";
  for (const r of radios) {
    r.checked = r.value === s.trigger;
    r.closest(".mode")?.classList.toggle("on", r.checked);
  }
  ready = true;
  void refreshCamera();
}

async function cameraState(): Promise<"granted" | "denied" | "prompt"> {
  try {
    const s = await navigator.permissions.query({ name: "camera" as PermissionName });
    return s.state as "granted" | "denied" | "prompt";
  } catch {
    return "prompt";
  }
}

async function refreshCamera(): Promise<void> {
  const wantsHand = settings?.trigger === "hand";
  camBox.classList.toggle("hidden", !wantsHand);
  grantBtn.classList.toggle("hidden", !wantsHand);
  if (!wantsHand) return;

  const state = await cameraState();
  if (state === "granted") {
    camBox.className = "note ok";
    camBox.textContent =
      "Camera on. The mouse gesture stays off while this trigger is selected.";
    grantBtn.textContent = "Open the camera check";
    return;
  }
  camBox.className = "note warn";
  camBox.textContent =
    state === "denied"
      ? "Camera blocked. The permission lives on SlingTab's own entry, not on the page you are viewing. Open the camera page to fix it."
      : "SlingTab watches the camera for the gesture. Video is processed on your machine and never leaves it.";
  grantBtn.textContent = "Allow camera access";
}

/**
 * Opens a tab rather than calling getUserMedia here.
 *
 * An extension popup is closed by Chrome the moment it loses focus, and the
 * permission bubble takes focus — so asking from the popup kills the popup and
 * cancels the request, which is why the consent button appeared to do nothing.
 */
grantBtn.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("camera.html") });
  window.close();
});

async function patch(p: Partial<Settings>): Promise<void> {
  if (!ready) return;
  try {
    paint(await patchSettings(p));
  } catch {
    // This popup outlived an extension reload. Repainting from storage would
    // fail too, so say so rather than leaving a control that looks applied.
    camBox.className = "note warn";
    camBox.classList.remove("hidden");
    camBox.textContent = "SlingTab was reloaded. Close this popup and open it again.";
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: "TRIGGER_CHANGED" });
  } catch {
    /* worker asleep; it re-reads settings on wake */
  }
}

enabled.addEventListener("change", () => void patch({ enabled: enabled.checked }));

for (const r of radios) {
  r.addEventListener("change", () => {
    if (r.checked) void patch({ trigger: r.value as TriggerMode });
  });
}

optionsBtn.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});

// The options page edits the same settings.
onSettingsChanged(paint);

void loadSettings().then(paint);
