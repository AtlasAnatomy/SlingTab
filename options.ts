import {
  DEFAULT_SETTINGS,
  MAX_QUICK_LINKS,
  loadSettings,
  patchSettings,
  onSettingsChanged,
  type QuickLink,
  type Settings,
  type TriggerMode,
} from "./src/shared/settings";
import {
  hostLabel,
  parseLinkList,
  type ImportResult,
} from "./src/shared/linkimport";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const enabled = $<HTMLInputElement>("enabled");
const powerLabel = $<HTMLSpanElement>("powerLabel");
const triggerRight = $<HTMLInputElement>("trigger-right");
const triggerAlt = $<HTMLInputElement>("trigger-alt");
const triggerHand = $<HTMLInputElement>("trigger-hand");
const iframeMode = $<HTMLInputElement>("iframeMode");
const livePreview = $<HTMLInputElement>("livePreview");
const debugEl = $<HTMLInputElement>("debug");
const linksEl = $<HTMLDivElement>("links");
const addBtn = $<HTMLButtonElement>("add");
const saveBtn = $<HTMLButtonElement>("save");
const savedEl = $<HTMLSpanElement>("saved");
const importText = $<HTMLTextAreaElement>("importText");
const importAdd = $<HTMLButtonElement>("importAdd");
const importTally = $<HTMLSpanElement>("importTally");
const camNote = $<HTMLDivElement>("camNote");
const poseRow = $<HTMLLabelElement>("poseRow");
const handPoseAny = $<HTMLInputElement>("handPoseAny");

let draft: QuickLink[] = [];
/** Guards every write until the form has been populated from storage. */
let ready = false;

function renderLinks(): void {
  linksEl.textContent = "";
  draft.forEach((link, i) => {
    const row = document.createElement("div");
    row.className = "link";

    const url = document.createElement("input");
    url.type = "url";
    url.placeholder = "https://example.com/page";
    url.value = link.url;
    url.setAttribute("aria-label", `Address for link ${i + 1}`);
    url.addEventListener("input", () => {
      draft[i]!.url = url.value.trim();
      // A blank name falls back to the hostname on save, so show that as it
      // becomes known rather than making the user guess what will be stored.
      if (!draft[i]!.label) label.placeholder = hostLabel(url.value) || "From the address";
    });

    const label = document.createElement("input");
    label.type = "text";
    label.placeholder = hostLabel(link.url) || "From the address";
    label.setAttribute("aria-label", `Name for link ${i + 1}`);
    label.value = link.label;
    label.addEventListener("input", () => {
      draft[i]!.label = label.value.slice(0, 32);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${link.label || link.url || "this link"}`);
    remove.addEventListener("click", () => {
      draft.splice(i, 1);
      renderLinks();
    });

    row.append(url, label, remove);
    linksEl.append(row);
  });

  addBtn.disabled = draft.length >= MAX_QUICK_LINKS;
  addBtn.textContent =
    draft.length >= MAX_QUICK_LINKS
      ? `${MAX_QUICK_LINKS} is the maximum`
      : "Add a link";

  // How many slots are left is part of what the paste panel reports, so it has
  // to be recomputed whenever a row appears or goes.
  refreshImport();
}

function apply(s: Settings, includeLinks = true): void {
  enabled.checked = s.enabled;
  powerLabel.textContent = s.enabled ? "on" : "off";
  // Lights the mark in the masthead, exactly as it does in the popup.
  document.body.classList.toggle("live", s.enabled);
  triggerRight.checked = s.trigger === "right";
  triggerAlt.checked = s.trigger === "alt";
  triggerHand.checked = s.trigger === "hand";
  iframeMode.checked = s.iframeMode;
  livePreview.checked = s.livePreview;
  debugEl.checked = s.debug;
  handPoseAny.checked = s.handPose === "any";
  camNote.classList.toggle("hidden", s.trigger !== "hand");
  poseRow.classList.toggle("hidden", s.trigger !== "hand");
  if (includeLinks) {
    draft = s.quickLinks.map((l) => ({ ...l }));
    renderLinks();
  }
  ready = true;
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;
function flash(text: string, ms: number): void {
  savedEl.textContent = text;
  savedEl.classList.add("on");
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => savedEl.classList.remove("on"), ms);
}
function flashSaved(): void {
  savedEl.classList.remove("failed");
  flash("Saved", 1400);
}
function flashFailed(): void {
  savedEl.classList.add("failed");
  flash("Not saved. Reload this page.", 6000);
}

/**
 * Patch one field. Never rebuild the whole Settings object from this form: it
 * does not render every field (the popup owns some), so a whole-object save
 * would reset whatever is not on screen.
 */
async function patch(p: Partial<Settings>): Promise<void> {
  if (!ready) return;
  try {
    const next = await patchSettings(p);
    apply(next, false);
    flashSaved();
  } catch {
    // `loadSettings` degrades to defaults on a dead context, but a WRITE cannot
    // degrade — silently swallowing it is how "my settings don't stick" starts.
    // The realistic cause is this page outliving an extension reload.
    flashFailed();
  }
}

function currentTrigger(): TriggerMode {
  if (triggerHand.checked) return "hand";
  if (triggerAlt.checked) return "alt";
  return "right";
}

enabled.addEventListener("change", () => void patch({ enabled: enabled.checked }));
iframeMode.addEventListener("change", () =>
  void patch({ iframeMode: iframeMode.checked }),
);
livePreview.addEventListener("change", () =>
  void patch({ livePreview: livePreview.checked }),
);
debugEl.addEventListener("change", () => void patch({ debug: debugEl.checked }));
handPoseAny.addEventListener("change", () =>
  void patch({ handPose: handPoseAny.checked ? "any" : "twoFingers" }),
);
for (const r of [triggerRight, triggerAlt, triggerHand]) {
  r.addEventListener("change", () => {
    if (r.checked) void patch({ trigger: currentTrigger() });
  });
}

addBtn.addEventListener("click", () => {
  if (draft.length >= MAX_QUICK_LINKS) return;
  draft.push({ url: "", label: "" });
  renderLinks();
  (linksEl.lastElementChild?.firstElementChild as HTMLInputElement | null)?.focus();
});

// Link rows wait for Save, so half-typed URLs are never persisted.
saveBtn.addEventListener("click", () => {
  void patch({
    quickLinks: draft
      .map((l) => ({ url: l.url.trim(), label: l.label.trim() }))
      .filter((l) => /^https?:\/\//i.test(l.url))
      .map((l) => ({ url: l.url, label: l.label || hostLabel(l.url) }))
      .slice(0, MAX_QUICK_LINKS),
    onboarded: true,
  });
});

// The popup edits the same settings; stay in step if it is open alongside.
onSettingsChanged((s) => apply(s, false));

void loadSettings()
  .then((s) => {
    apply(s);
    // First run: nudge toward at least one quick link, since the default is none.
    if (!s.onboarded && s.quickLinks.length === 0) {
      draft = [{ url: "", label: "" }];
      renderLinks();
    }
  })
  .catch(() => apply({ ...DEFAULT_SETTINGS }));

/* -------------------------------------------------------------------------- *
 *  Paste a list
 *
 *  Typing eight addresses by hand is the worst part of setting this up, and the
 *  list nearly always exists somewhere already. Parsing lives in
 *  shared/linkimport.ts, which is pure and tested; everything here is wiring.
 *
 *  The tally updates as you type rather than on submit, so a paste whose lines
 *  were misread says so before you commit to it instead of after.
 * -------------------------------------------------------------------------- */

let pending: ImportResult = { links: [], skipped: 0, overflow: 0 };

/** Rows the user has actually filled in. Blank rows are placeholders, not links. */
function filledDraft(): QuickLink[] {
  return draft.filter((l) => l.url.trim());
}

function describe(r: ImportResult, roomFor: number): string {
  if (!r.links.length) {
    return importText.value.trim()
      ? "No web addresses in that. Each line needs one."
      : "Nothing to add yet.";
  }
  const parts = [`${r.links.length} ${r.links.length === 1 ? "link" : "links"}`];
  if (r.skipped) parts.push(`${r.skipped} ${r.skipped === 1 ? "line" : "lines"} skipped`);
  if (roomFor < r.links.length) parts.push(`room for ${roomFor}`);
  else if (r.overflow) parts.push(`${r.overflow} over the limit of ${MAX_QUICK_LINKS}`);
  return parts.join("  ·  ");
}

function refreshImport(): void {
  const existing = new Set(filledDraft().map((l) => l.url));
  const parsed = parseLinkList(importText.value, MAX_QUICK_LINKS);
  // Anything already on the list is not an import; counting it would promise a
  // number the button cannot deliver.
  pending = { ...parsed, links: parsed.links.filter((l) => !existing.has(l.url)) };

  const roomFor = Math.max(0, MAX_QUICK_LINKS - filledDraft().length);
  const usable = Math.min(pending.links.length, roomFor);

  importTally.textContent = describe(pending, roomFor);
  importTally.className = `tally ${pending.links.length ? (usable ? "ready" : "bad") : ""}`;
  importAdd.disabled = usable === 0;
  importAdd.textContent = usable ? `Add ${usable} to the list` : "Add to the list";
}

importText.addEventListener("input", refreshImport);

importAdd.addEventListener("click", () => {
  const roomFor = Math.max(0, MAX_QUICK_LINKS - filledDraft().length);
  const taking = pending.links.slice(0, roomFor);
  if (!taking.length) return;

  draft = [...filledDraft(), ...taking];
  renderLinks();
  importText.value = "";
  refreshImport();

  void patch({ quickLinks: draft, onboarded: true });
});
