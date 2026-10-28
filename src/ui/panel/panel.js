// panel.js — the side-panel surface (primary UI as of v0.2.0).
// Because the panel stays open while you browse, it live-updates on an
// interval instead of only when opened.

import { runAndRender, renderSummary, advanceSort, esc } from "../shared/summary-view.js";
import { VERSION, DEEP_PROFILE_SAMPLE_MS } from "../../core/constants.js";
import { loadWord, fmtPct, busyMix, mostlyUnlabelled } from "../../core/profile.js";
import {
  sleepTab,
  closeTabs,
  closeExtras,
  sleepAllIdle,
  closeAllDuplicateExtras,
} from "../../core/actions.js";
import { initAutomationUI } from "./automation-ui.js";
import { initCurrentTabUI } from "./current-tab-ui.js";
import { initAIUI } from "./ai-ui.js";
import { initInfoLayer } from "../shared/info-layer.js";

const content = document.getElementById("content");
const refreshBtn = document.getElementById("refresh");
const deepResult = document.getElementById("deep-result");

document.getElementById("version").textContent = `v${VERSION}`;

// --- Deep profiler (chrome.debugger) ---------------------------------------
// Output renders into #deep-result, which sits outside #content so the periodic
// live re-render doesn't erase it while you're reading.

function showDeep(html) {
  deepResult.hidden = false;
  deepResult.innerHTML =
    `<button class="deep-close" data-act="deep-close" title="Dismiss">✕</button>` + html;
}

function formatDeep(m) {
  const title = `<div class="deep-title">Deep profile — ${esc(m.title)}</div>`;
  let busy = "";
  if (m.mainThreadPct != null) {
    const mix = busyMix(m);
    busy =
      `<div><b class="${m.mainThreadPct >= 50 ? "hot" : ""}">${fmtPct(m.mainThreadPct)}</b> ` +
      `main-thread busy (${loadWord(m.mainThreadPct)}) over ${m.sampleSeconds}s${mix ? ` — ${mix}` : ""}</div>`;
  }
  const facts = [];
  if (m.jsHeapMB != null)
    facts.push(`<b>${m.jsHeapMB} MB</b> JS heap${m.jsHeapTotalMB ? ` / ${m.jsHeapTotalMB} MB` : ""}`);
  if (m.nodes != null) facts.push(`${m.nodes.toLocaleString()} DOM nodes`);
  if (m.listeners != null) facts.push(`${m.listeners.toLocaleString()} listeners`);
  if (m.frames != null) facts.push(`${m.frames} frames${m.adFrames ? ` (${m.adFrames} ads)` : ""}`);
  if (m.layouts) facts.push(`${m.layouts} layouts`);
  const factsHtml = facts.length ? `<div class="deep-facts">${facts.join(" · ")}</div>` : "";
  const asyncNote = mostlyUnlabelled(m)
    ? " 'other' includes JavaScript run after await / in promise callbacks, which Chrome doesn't count as script."
    : "";
  const note = busy
    ? `<div class="deep-note">Measured on the tab's renderer main thread; same-site tabs sharing a process can add to it.${asyncNote}</div>`
    : "";
  return `${title}<div class="deep-body">${busy + factsHtml || "no metrics returned"}${note}</div>`;
}

// One DevTools measurement at a time (a profile or a Tab CPU sweep) — the worker
// refuses a second while one holds the debugger anyway.
let profiling = false;
// Transient render state for the Tab CPU section, passed through each re-render.
const ui = { measuring: false };

async function runDeepProfile(tabId) {
  if (profiling || ui.measuring) return;
  profiling = true;
  const secs = DEEP_PROFILE_SAMPLE_MS / 1000;
  showDeep(
    `<div class="deep-title">Deep profile</div><div class="deep-body">measuring for ${secs}s… Chrome shows a "debugging this tab" banner on that tab meanwhile</div>`
  );
  try {
    const resp = await chrome.runtime.sendMessage({ type: "deep-profile", tabId });
    if (resp?.ok) showDeep(formatDeep(resp.metrics));
    else showDeep(`Profile failed: ${esc(resp?.error || "unknown error")}`);
  } catch (err) {
    showDeep(`Profile failed: ${esc(String(err.message || err))}`);
  } finally {
    profiling = false;
  }
}

// Tab CPU sweep: the worker measures every loaded tab at once and saves the result,
// which the next scan picks up — so this only has to flag "measuring" meanwhile.
async function runMeasureAll() {
  if (profiling || ui.measuring) return;
  ui.measuring = true;
  rerender();
  try {
    const resp = await chrome.runtime.sendMessage({ type: "measure-all" });
    if (!resp?.ok) showDeep(`Measure failed: ${esc(resp?.error || "unknown error")}`);
  } catch (err) {
    showDeep(`Measure failed: ${esc(String(err.message || err))}`);
  } finally {
    ui.measuring = false;
  }
}

deepResult.addEventListener("click", (e) => {
  if (e.target.closest("[data-act='deep-close']")) deepResult.hidden = true;
});

const LIVE_INTERVAL_MS = 5000;
let busy = false; // prevents overlapping scans

// Which rows are expanded — keyed by stable data-key so the state survives the
// periodic re-render. `last` caches the most recent scan so toggling a row can
// re-render instantly without waiting on a fresh scan.
const expandedKeys = new Set();
// Per-section sort choice (section id -> option key). In-memory like expandedKeys
// so it survives the 5s re-render; resets when the panel is closed.
const sortState = new Map();
// Which sections are collapsed (section id). Same lifetime as the above — kept so
// the live re-render and sort/expand actions don't reopen a section you closed.
const collapsedSections = new Set();
let last = null;

async function refresh() {
  if (busy) return;
  busy = true;
  refreshBtn.classList.add("spin");
  try {
    last = await runAndRender(content, expandedKeys, sortState, collapsedSections, ui);
  } catch (err) {
    content.innerHTML = `<p class="loading">// scan error: ${esc(err.message)}</p>`;
  } finally {
    busy = false;
    refreshBtn.classList.remove("spin");
  }
}

function toggleExpand(key) {
  if (expandedKeys.has(key)) expandedKeys.delete(key);
  else expandedKeys.add(key);
  rerender();
}

// Collapse/expand a whole section, then re-render instantly from the cached scan.
function toggleCollapse(id) {
  if (collapsedSections.has(id)) collapsedSections.delete(id);
  else collapsedSections.add(id);
  rerender();
}

// Re-render instantly from the cached scan after a sort/expand/collapse change.
function rerender() {
  if (last)
    renderSummary(content, last.summary, last.cpuPercent, expandedKeys, sortState, collapsedSections, ui);
}

refreshBtn.addEventListener("click", refresh);

// Hide any extension icon that fails to load (CSP-safe: no inline onerror).
// 'error' doesn't bubble, so listen in the capture phase.
content.addEventListener(
  "error",
  (e) => {
    if (e.target.tagName === "IMG") e.target.style.visibility = "hidden";
  },
  true
);

// Tab actions, via event delegation on the container so the handler survives
// the periodic innerHTML re-renders. Each button carries data-act (+ ids).
content.addEventListener("click", async (e) => {
  // Section "ⓘ" button — handled by the floating info layer (info-layer.js),
  // not here. Bail out so it doesn't fall through to the collapse toggle below.
  if (e.target.closest("button[data-info]")) return;

  // Section sort control — cycle to the next option and re-render in place.
  const sortBtn = e.target.closest("button[data-sort]");
  if (sortBtn) {
    advanceSort(sortState, sortBtn.dataset.sort);
    rerender();
    return;
  }

  const btn = e.target.closest("button[data-act]");
  if (!btn) {
    // A click on a section header (but not its sort/action buttons, handled above)
    // collapses or expands that whole section.
    const secHead = e.target.closest(".sec-head[data-sec]");
    if (secHead) {
      toggleCollapse(secHead.dataset.sec);
      return;
    }
    // Not an action button — toggle the row's collapsible detail.
    const line = e.target.closest(".line[data-key]");
    if (line) toggleExpand(line.dataset.key);
    return;
  }

  const act = btn.dataset.act;
  const id = Number(btn.dataset.id);
  const ids = (btn.dataset.ids || "")
    .split(",")
    .filter(Boolean)
    .map(Number);

  try {
    switch (act) {
      case "profile":
        await runDeepProfile(id);
        break;
      case "measure-all":
        await runMeasureAll();
        break;
      case "sleep":
        await sleepTab(id);
        break;
      case "close":
        if (confirm("Close this tab?")) await closeTabs(id);
        break;
      case "close-set": {
        const extras = ids.length - 1;
        if (
          extras > 0 &&
          confirm(`Close up to ${extras} duplicate copy(ies)? Pinned and audible copies are kept.`)
        )
          await closeExtras(ids);
        break;
      }
      case "sleep-idle":
        await sleepAllIdle();
        break;
      case "close-dupes":
        if (confirm("Close every redundant duplicate tab? Pinned and audible copies are kept."))
          await closeAllDuplicateExtras();
        break;
    }
  } catch (err) {
    console.warn("Action failed:", err);
  }

  refresh(); // reflect the new state immediately
});

refresh();

// Auto-manage status strip + settings modal (independent of the live scan loop).
initAutomationUI();

// Current-tab inspector: ads / trackers / cookies for the active tab.
initCurrentTabUI();

// AI analysis card: on-demand Claude read of the latest scan. Hand it an accessor
// for `last` so the button always analyzes the freshest data.
initAIUI(() => last);

// Floating help layer: hover tooltips on telemetry items + the per-section "ⓘ"
// explainer pop-ups. Self-managing via document-level delegation, so it keeps
// working across the live re-render.
initInfoLayer();

// Live monitoring: re-scan periodically while the panel is open. The interval
// is paused when the panel is hidden so we're not sampling CPU needlessly.
let timer = setInterval(refresh, LIVE_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(timer);
  } else {
    refresh();
    timer = setInterval(refresh, LIVE_INTERVAL_MS);
  }
});
