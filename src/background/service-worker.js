// service-worker.js — the always-on background monitor.
// Periodically (and on tab changes) it rebuilds the summary, caches it for the
// popup to read instantly, and reflects the current state on the toolbar badge.

import { collectSnapshot } from "../core/collector.js";
import { analyze } from "../core/analyzer.js";
import { recordPerfReport, dropLiveTab } from "../core/perf-store.js";
import { recordStrain } from "../core/strain-history.js";
import { runAutomation } from "../core/automation.js";
import { ALARM_NAME, SCAN_INTERVAL_MINUTES } from "../core/constants.js";

// Rebuild the summary and reflect it on the toolbar badge. The panel renders from
// its own scan, so there's nothing to cache here — the badge is the only consumer.
//
// `automate` runs the once-per-authoritative-scan side effects (strain ledger +
// rule-based auto-management). It's turned off for the follow-up re-scan after
// automation acts, so those side effects fire exactly once per real scan, never on
// the corrective re-scan (which would double-count strain or re-trigger automation).
async function scan({ automate = true } = {}) {
  const summary = analyze(await collectSnapshot());
  updateBadge(summary);
  if (!automate) return summary;

  // Fold this scan's strained origins into the persistent chronic-strain ledger.
  // Done here (once per authoritative scan), never on the panel's 5s re-render,
  // so episode counts track real time rather than render frequency. Isolated so a
  // storage hiccup never breaks the scan.
  try {
    await recordStrain(summary, summary.takenAt);
  } catch (err) {
    console.warn("strain record failed:", err);
  }

  // Rule-based auto-management: act on tabs that have been strained too long.
  // No-op unless the user has enabled it in settings. Isolated so a failure here
  // never breaks the monitoring scan itself. After it acts the badge is stale, so
  // re-scan once without re-running automation to reflect the new tab state.
  try {
    const acted = await runAutomation(summary, summary.takenAt);
    if (acted.length) await scan({ automate: false });
  } catch (err) {
    console.warn("automation run failed:", err);
  }

  return summary;
}

function updateBadge(summary) {
  chrome.action.setBadgeText({ text: String(summary.totals.tabs) });
  chrome.action.setBadgeBackgroundColor({
    color: summary.issues > 0 ? "#d9534f" : "#4a6da7",
  });
}

// Debounce: tab events can fire in bursts; one scan shortly after is enough.
let scanTimer = null;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, 500);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: SCAN_INTERVAL_MINUTES });
  // Clicking the toolbar icon toggles the side panel open/closed on any page.
  // This is persistent, but we set it on install so it's always in effect.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("Could not set side-panel behavior:", err));
  scan();
});

chrome.runtime.onStartup.addListener(scan);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) scan();
});

// Keep the badge responsive to tab activity between scheduled scans.
chrome.tabs.onCreated.addListener(scheduleScan);
chrome.tabs.onUpdated.addListener(scheduleScan);
chrome.tabs.onActivated.addListener(scheduleScan);
chrome.tabs.onRemoved.addListener((tabId) => {
  dropLiveTab(tabId).catch(() => {});
  scheduleScan();
});

// Perf reports arrive from many tabs; serialize the read-modify-write of
// storage through one chain so concurrent reports don't clobber each other.
let perfWriteChain = Promise.resolve();
function queuePerfReport(tabId, data) {
  perfWriteChain = perfWriteChain
    .then(() => recordPerfReport(tabId, data, Date.now()))
    .catch((err) => console.warn("perf record failed:", err));
}

/**
 * Attach the DevTools protocol to one tab, read real Performance metrics, then
 * detach. This briefly shows Chrome's "debugging this tab" banner — by design.
 */
async function deepProfile(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Performance.enable");
    const { metrics } = await chrome.debugger.sendCommand(
      target,
      "Performance.getMetrics"
    );
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const mb = (bytes) => (bytes ? Math.round(bytes / 1048576) : null);
    return {
      jsHeapMB: mb(m.JSHeapUsedSize),
      jsHeapTotalMB: mb(m.JSHeapTotalSize),
      nodes: m.Nodes ?? null,
      listeners: m.JSEventListeners ?? null,
      documents: m.Documents ?? null,
      frames: m.Frames ?? null,
      layoutCount: m.LayoutCount ?? null,
      recalcStyleCount: m.RecalcStyleCount ?? null,
      scriptSeconds: m.ScriptDuration != null ? +m.ScriptDuration.toFixed(2) : null,
      taskSeconds: m.TaskDuration != null ? +m.TaskDuration.toFixed(2) : null,
    };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "rescan") {
    scan().then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === "perf-report" && sender.tab?.id != null) {
    queuePerfReport(sender.tab.id, msg.data);
    return false; // fire-and-forget
  }
  if (msg?.type === "deep-profile") {
    deepProfile(msg.tabId).then(
      (metrics) => sendResponse({ ok: true, metrics }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) })
    );
    return true;
  }
});
