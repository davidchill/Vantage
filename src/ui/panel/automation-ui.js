// automation-ui.js — the auto-manage surface: a status strip + a settings modal.
//
// Both render from the shared settings store (src/core/settings.js); edits are
// saved straight back to storage.local, where the service worker reads them on
// its next scan. The strip toggles the master switch; the modal exposes the full
// configuration and the audit log of what's been auto-slept / auto-closed.

import { esc } from "../shared/summary-view.js";
import { getSettings, saveSettings, TRIGGER_LABELS } from "../../core/settings.js";
import { getActionLog, clearActionLog } from "../../core/automation.js";
import { AI_MODELS } from "../../core/constants.js";
import { refreshAICard } from "./ai-ui.js";

const SHORT = { backgroundDrain: "bg-drain", leak: "leaks" };
const ACTION_VERB = { sleep: "Sleeping", close: "Closing" };

const strip = document.getElementById("auto-strip");
const modal = document.getElementById("settings-modal");
const modalBody = document.getElementById("modal-body");
const settingsBtn = document.getElementById("settings-btn");
const modalClose = document.getElementById("modal-close");

// In-memory copy of the current settings so edits mutate-then-save without an
// extra read round-trip on every keystroke.
let current = null;

// ── Status strip ───────────────────────────────────────────────────────────

function stripSummary(s) {
  const on = Object.entries(s.triggers).filter(([, t]) => t.enabled);
  if (!on.length) return "no triggers enabled";
  const actions = new Set(on.map(([, t]) => t.action));
  const verb = actions.size === 1 ? ACTION_VERB[[...actions][0]] : "Managing";
  const list = on.map(([k]) => SHORT[k] || k).join(" & ");
  return `${verb} ${list} after ${s.sustainMinutes}m`;
}

function renderStrip() {
  if (!current) return;
  const on = current.enabled;
  strip.hidden = false;
  strip.classList.toggle("on", on);
  strip.innerHTML = `
    <span class="sw" data-act="toggle" role="switch" aria-checked="${on}"><span class="sw-dot"></span></span>
    <span class="auto-label">AUTO-MANAGE</span>
    <span class="auto-sum">${on ? esc(stripSummary(current)) : "off"}</span>`;
}

// ── Settings modal ─────────────────────────────────────────────────────────

function triggerRow(key) {
  const t = current.triggers[key];
  const opt = (val) =>
    `<option value="${val}"${t.action === val ? " selected" : ""}>${val}</option>`;
  return `
    <div class="set-row trig${t.enabled ? "" : " off"}">
      <label class="set-check">
        <input type="checkbox" data-trigger="${key}" data-attr="enabled"${t.enabled ? " checked" : ""} />
        <span>${esc(TRIGGER_LABELS[key])}</span>
      </label>
      <select class="set-select" data-trigger="${key}" data-attr="action"${t.enabled ? "" : " disabled"}>
        ${opt("sleep")}${opt("close")}
      </select>
    </div>`;
}

function logRows(log) {
  if (!log.length) return `<div class="empty">// nothing auto-managed yet</div>`;
  return log
    .map((e) => {
      const when = new Date(e.t).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const cls = e.action === "close" ? "danger" : "";
      return `
        <div class="log-row">
          <div class="log-top">
            <span class="log-act ${cls}">${e.action}</span>
            <span class="log-title">${esc(e.title)}</span>
            <span class="log-when">${esc(when)}</span>
          </div>
          <div class="log-reason">${esc(e.reason)}</div>
        </div>`;
    })
    .join("");
}

async function renderModalBody() {
  const log = await getActionLog();
  const s = current;
  modalBody.innerHTML = `
    <div class="set-row master">
      <label class="set-check">
        <input type="checkbox" data-field="enabled"${s.enabled ? " checked" : ""} />
        <span><b>Enable auto-management</b></span>
      </label>
    </div>
    <p class="set-note">
      Strained tabs are acted on only after staying strained continuously for the
      window below. Active, pinned, and audible tabs are never touched.
    </p>

    <div class="set-row">
      <span class="set-lbl">Sustain window</span>
      <span class="set-num">
        <input type="number" min="1" max="120" data-field="sustainMinutes" value="${s.sustainMinutes}" />
        <span>min</span>
      </span>
    </div>

    <div class="set-sec">Triggers</div>
    ${triggerRow("backgroundDrain")}
    ${triggerRow("leak")}

    <div class="set-sec">AI Analysis</div>
    <p class="set-note">
      Optional. Paste an Anthropic API key to enable the AI Analysis card. The key
      is stored only on this device; each analysis sends the current snapshot
      (tab titles, sites, metrics) to Anthropic when you click “Run analysis”.
    </p>
    <div class="set-row">
      <span class="set-lbl">API key</span>
      <input type="password" class="set-text" data-field="aiApiKey"
        placeholder="sk-ant-…" value="${esc(s.ai.apiKey)}" autocomplete="off" spellcheck="false" />
    </div>
    <div class="set-row">
      <span class="set-lbl">Model</span>
      <select class="set-select" data-field="aiModel">
        ${AI_MODELS.map(
          (m) =>
            `<option value="${esc(m.id)}"${s.ai.model === m.id ? " selected" : ""}>${esc(m.label)}</option>`
        ).join("")}
      </select>
    </div>

    <div class="set-sec log-head">
      <span>History</span>
      ${log.length ? `<button class="act" data-act="clear-log">clear</button>` : ""}
    </div>
    <div class="log-list">${logRows(log)}</div>`;
}

function openModal() {
  modal.hidden = false;
  renderModalBody();
}
function closeModal() {
  modal.hidden = true;
}

// ── Wiring ─────────────────────────────────────────────────────────────────

async function persist() {
  current = await saveSettings(current);
  renderStrip();
}

// Strip: clicking the switch (or anywhere on the strip) toggles the master switch.
strip.addEventListener("click", async () => {
  current.enabled = !current.enabled;
  await persist();
  if (!modal.hidden) renderModalBody(); // keep the modal checkbox in sync
});

settingsBtn.addEventListener("click", openModal);
modalClose.addEventListener("click", closeModal);
// Click the dim backdrop (but not the card) to dismiss.
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

// All modal edits flow through here via delegation, since the body is re-rendered.
modalBody.addEventListener("change", async (e) => {
  const el = e.target;
  let aiChanged = false;
  if (el.dataset.field === "enabled") current.enabled = el.checked;
  else if (el.dataset.field === "sustainMinutes") current.sustainMinutes = el.value;
  else if (el.dataset.field === "aiApiKey") {
    current.ai.apiKey = el.value;
    aiChanged = true;
  } else if (el.dataset.field === "aiModel") {
    current.ai.model = el.value;
    aiChanged = true;
  } else if (el.dataset.trigger) {
    const t = current.triggers[el.dataset.trigger];
    if (el.dataset.attr === "enabled") t.enabled = el.checked;
    else if (el.dataset.attr === "action") t.action = el.value;
  } else return;

  await persist();
  if (aiChanged) refreshAICard(); // reflect key added/removed in the AI card
  renderModalBody(); // reflect derived state (disabled selects, summary, etc.)
});

modalBody.addEventListener("click", async (e) => {
  if (e.target.closest("[data-act='clear-log']")) {
    await clearActionLog();
    renderModalBody();
  }
});

/** Load settings and paint the strip. Call once on panel startup. */
export async function initAutomationUI() {
  current = await getSettings();
  renderStrip();
}
