// panel.js — the side-panel surface (primary UI as of v0.2.0).
// Because the panel stays open while you browse, it live-updates on an
// interval instead of only when opened.

import { runAndRender, renderSummary, advanceSort, esc } from "../shared/summary-view.js";
import { VERSION } from "../../core/constants.js";
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
  const parts = [];
  if (m.jsHeapMB != null)
    parts.push(
      `<b>${m.jsHeapMB} MB</b> JS heap${m.jsHeapTotalMB ? ` / ${m.jsHeapTotalMB} MB` : ""}`
    );
  if (m.nodes != null) parts.push(`${m.nodes.toLocaleString()} DOM nodes`);
  if (m.listeners != null) parts.push(`${m.listeners.toLocaleString()} listeners`);
  if (m.frames != null) parts.push(`${m.frames} frames`);
  if (m.scriptSeconds != null) parts.push(`${m.scriptSeconds}s total script`);
  if (m.layoutCount != null) parts.push(`${m.layoutCount} layouts`);
  return `<div class="deep-title">Deep profile (real metrics)</div><div class="deep-body">${
    parts.join(" · ") || "no metrics returned"
  }</div>`;
}

async function runDeepProfile(tabId) {
  showDeep(`<div class="deep-title">Deep profile</div><div class="deep-body">profiling… a debug banner flashes on that tab</div>`);
  try {
    const resp = await chrome.runtime.sendMessage({ type: "deep-profile", tabId });
    if (resp?.ok) showDeep(formatDeep(resp.metrics));
    else showDeep(`Profile failed: ${esc(resp?.error || "unknown error")}`);
  } catch (err) {
    showDeep(`Profile failed: ${esc(String(err.message || err))}`);
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
    last = await runAndRender(content, expandedKeys, sortState, collapsedSections);
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
    renderSummary(content, last.summary, last.cpuPercent, expandedKeys, sortState, collapsedSections);
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
      case "sleep":
        await sleepTab(id);
        break;
      case "close":
        if (confirm("Close this tab?")) await closeTabs(id);
        break;
      case "close-set": {
        const extras = ids.length - 1;
        if (extras > 0 && confirm(`Close ${extras} duplicate copy(ies)?`))
          await closeExtras(ids);
        break;
      }
      case "sleep-idle":
        await sleepAllIdle();
        break;
      case "close-dupes":
        if (confirm("Close every redundant duplicate tab?"))
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
