// panel.js — the side-panel surface (primary UI as of v0.2.0).
// Because the panel stays open while you browse, it live-updates on an
// interval instead of only when opened.

import { runAndRender, renderSummary, esc } from "../shared/summary-view.js";
import { VERSION } from "../../core/constants.js";
import {
  sleepTab,
  closeTabs,
  closeExtras,
  sleepAllIdle,
  closeAllDuplicateExtras,
} from "../../core/actions.js";

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
let last = null;

async function refresh() {
  if (busy) return;
  busy = true;
  refreshBtn.classList.add("spin");
  try {
    last = await runAndRender(content, expandedKeys);
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
  if (last) renderSummary(content, last.summary, last.cpuPercent, expandedKeys);
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
  const btn = e.target.closest("button[data-act]");
  if (!btn) {
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
