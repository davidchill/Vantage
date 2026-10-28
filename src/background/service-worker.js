// service-worker.js — the always-on background monitor.
// Periodically (and on tab changes) it rebuilds the summary and reflects the current
// state on the toolbar badge. It also collects the in-page probes' reports and runs
// the on-demand DevTools measurements (deep profile, Tab CPU sweep).

import { collectSnapshot } from "../core/collector.js";
import { analyze } from "../core/analyzer.js";
import { recordPerfReports, dropLiveTab } from "../core/perf-store.js";
import { recordStrain } from "../core/strain-history.js";
import { runAutomation } from "../core/automation.js";
import { summarizeProfile } from "../core/profile.js";
import {
  ALARM_NAME,
  SCAN_INTERVAL_MINUTES,
  PERF_FLUSH_MS,
  PERF_FLUSH_MAX_BATCH,
  LEGACY_STRAIN_HISTORY_KEY,
  DEEP_PROFILE_SAMPLE_MS,
  CPU_SWEEP_KEY,
  CPU_SWEEP_MAX_TABS,
} from "../core/constants.js";

// Every storage update the worker makes is a read-modify-write of a whole object
// (perf stores, strain ledger, automation tracker). Two in flight at once can read
// the same snapshot and overwrite each other's changes, so they run one at a time
// through this queue: each task starts only after the previous one settles.
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

/** Queue a scan behind any storage work already in flight. */
function scan(opts) {
  return enqueue(() => runScan(opts));
}

// Rebuild the summary and reflect it on the toolbar badge. The panel renders from
// its own scan, so there's nothing to cache here — the badge is the only consumer.
//
// `automate` runs the once-per-authoritative-scan side effects (strain ledger +
// rule-based auto-management). It's turned off for the follow-up re-scan after
// automation acts and for the badge refreshes driven by tab events, so those side
// effects fire exactly once per real (alarm-cadence) scan — never on a corrective
// re-scan or a burst of tab activity, which would inflate the strain counts.
async function runScan({ automate = true } = {}) {
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
  // re-scan once without re-running automation to reflect the new tab state. (Run
  // directly — this scan already holds the queue, so queueing it would deadlock.)
  try {
    const acted = await runAutomation(summary, summary.takenAt);
    if (acted.length) await runScan({ automate: false });
  } catch (err) {
    console.warn("automation run failed:", err);
  }

  return summary;
}

// Badge colors follow the health verdict, using the panel's palette: calm blue when
// Good, amber when Strained, red when Heavy. Amber needs dark text to stay legible.
const BADGE_STYLE = {
  Good: { bg: "#4a6da7", fg: "#ffffff" },
  Strained: { bg: "#e3a33b", fg: "#10151e" },
  Heavy: { bg: "#d9534f", fg: "#ffffff" },
};

function updateBadge(summary) {
  const { level, factors } = summary.health;
  const style = BADGE_STYLE[level] || BADGE_STYLE.Good;
  chrome.action.setBadgeText({ text: String(summary.totals.tabs) });
  chrome.action.setBadgeBackgroundColor({ color: style.bg });
  chrome.action.setBadgeTextColor({ color: style.fg });
  // Hovering the toolbar icon shows the verdict and what's driving it.
  const why = factors.map((f) => f.label).join(" · ");
  chrome.action.setTitle({
    title: `Vantage — ${level}${why ? `: ${why}` : ""} (click to toggle panel)`,
  });
}

// Debounce: tab events can fire in bursts; one scan shortly after is enough.
// These scans only refresh the badge. Strain recording and auto-management stay on
// the alarm's fixed cadence, so episode counts track elapsed time rather than how
// often you switch tabs or a page retitles itself.
let scanTimer = null;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scan({ automate: false }), 500);
}

// The alarm is the only driver of the strain ledger and auto-management, so it must
// exist. Alarms usually persist, but Chrome may clear them on browser restart — so
// re-check every time the worker starts, not only on install.
async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM_NAME))) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: SCAN_INTERVAL_MINUTES });
  }
}
ensureAlarm().catch((err) => console.warn("Could not ensure scan alarm:", err));

// Manifest content scripts only reach pages loaded after install, and an update or
// reload cuts off the probes already running in open tabs. Inject the probe into
// every open web page so monitoring starts now rather than after each tab's next
// reload. (The probe stops any earlier copy on the same page, so this is safe even
// where one is already running.) Asleep tabs are skipped — they get the manifest
// probe when they wake and reload.
async function injectProbeIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(
    tabs
      .filter((t) => !t.discarded)
      .map((t) =>
        chrome.scripting
          .executeScript({ target: { tabId: t.id }, files: ["src/content/perf-probe.js"] })
          .catch(() => {}) // pages extensions can't script (Web Store, error pages)
      )
  );
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: SCAN_INTERVAL_MINUTES });
  if (reason === "install" || reason === "update") {
    injectProbeIntoOpenTabs().catch((err) => console.warn("Probe injection failed:", err));
  }
  // Drop the pre-0.2.6 strain ledger (inflated counts); the new key starts clean.
  // A no-op once it's gone, so it's safe to run on every install/update.
  chrome.storage.local.remove(LEGACY_STRAIN_HISTORY_KEY).catch(() => {});
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

// Keep the badge responsive between scheduled scans — but only to tab changes that
// can move it: the tab count (created/removed) or the health verdict (a tab moving
// to another site, finishing a load, or being slept/woken). Title, favicon and audio
// updates are ignored, or a page that retitles itself every second would trigger a
// scan every second; switching tabs changes neither, so it isn't watched at all.
chrome.tabs.onCreated.addListener(scheduleScan);
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.url || info.status === "complete" || info.discarded !== undefined) scheduleScan();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(() => dropLiveTab(tabId)).catch(() => {});
  scheduleScan();
});

// Perf reports arrive every 5s from each open tab, staggered so many land within a
// second of each other. Buffer them and fold the whole batch into storage in one
// read-modify-write per flush, instead of one write per message. A short debounce
// keeps the live data fresh for the panel; a burst that fills the buffer flushes
// early so it never grows unbounded.
const perfBuffer = [];
let perfFlushTimer = null;

function flushPerfReports() {
  clearTimeout(perfFlushTimer);
  perfFlushTimer = null;
  const batch = perfBuffer.splice(0);
  if (batch.length) {
    enqueue(() => recordPerfReports(batch)).catch((err) =>
      console.warn("perf record failed:", err)
    );
  }
}

function queuePerfReport(tabId, docId, data) {
  perfBuffer.push({ tabId, docId, data, ts: Date.now() });
  if (perfBuffer.length >= PERF_FLUSH_MAX_BATCH) flushPerfReports();
  else if (perfFlushTimer == null) perfFlushTimer = setTimeout(flushPerfReports, PERF_FLUSH_MS);
}

// --- Measuring tabs over the DevTools protocol (chrome.debugger) -------------
// A reading is two Performance.getMetrics calls DEEP_PROFILE_SAMPLE_MS apart: the
// counters are cumulative since page load, so their difference says how busy a tab
// is right now (see profile.js). Attaching shows Chrome's "started debugging"
// banner for the sample window — by design, and why this only runs on a click.

// A hung page's main thread never answers a protocol command, so every call gets a
// deadline — otherwise one frozen tab would stall the whole measurement.
const CDP_REPLY_MS = 5000;

/** Reject with `what` if `promise` hasn't settled within `ms`. */
function withTimeout(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const cdp = (target, method) =>
  withTimeout(chrome.debugger.sendCommand(target, method), CDP_REPLY_MS, "page unresponsive");

async function readMetrics(target) {
  const { metrics } = await cdp(target, "Performance.getMetrics");
  return Object.fromEntries(metrics.map((x) => [x.name, x.value]));
}

// Chrome allows one debugger attach per tab, so a deep profile and a sweep must not
// overlap — the second would fail to attach to the tabs the first holds.
let sampling = false;

/**
 * Take a reading of every tab in `tabIds` at once: each is attached, read, given one
 * sample window, read again — all side by side, so the whole thing takes one window
 * however many tabs there are, and a slow tab never stretches the others' windows.
 * Everything attached is detached at the end.
 * @returns {Promise<Map<number, {before, after} | {error: string}>>}
 */
async function sampleTabs(tabIds) {
  if (sampling) throw new Error("another measurement is still running");
  sampling = true;
  const attached = [];
  const results = new Map();
  try {
    await Promise.all(
      tabIds.map(async (tabId) => {
        const target = { tabId };
        const attaching = chrome.debugger.attach(target, "1.3");
        try {
          await withTimeout(attaching, CDP_REPLY_MS, "page unresponsive");
          attached.push(target);
          await cdp(target, "Performance.enable");
          const before = await readMetrics(target);
          await new Promise((resolve) => setTimeout(resolve, DEEP_PROFILE_SAMPLE_MS));
          results.set(tabId, { before, after: await readMetrics(target) });
        } catch (err) {
          // An attach that lands after its deadline still has to be undone.
          if (!attached.includes(target)) {
            attaching.then(() => chrome.debugger.detach(target)).catch(() => {});
          }
          results.set(tabId, { error: String(err?.message || err) });
        }
      })
    );
    return results;
  } finally {
    await Promise.all(
      attached.map((t) =>
        withTimeout(chrome.debugger.detach(t), CDP_REPLY_MS, "detach").catch(() => {})
      )
    );
    sampling = false;
  }
}

/** Deep profile: one tab's reading, plus its title for the panel. */
async function deepProfile(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const r = (await sampleTabs([tabId])).get(tabId);
  if (r.error) throw new Error(r.error);
  return { title: tab.title || tab.url || "", ...summarizeProfile(r.before, r.after) };
}

/**
 * Tab CPU sweep: a reading of every loaded web tab at once, saved for the panel, the
 * badge's health verdict and AI analysis. Asleep tabs aren't running, and Chrome's
 * own pages can't be debugged by extensions, so both are left out.
 */
async function measureAllTabs() {
  const [tabs, windows] = await Promise.all([
    chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }),
    chrome.windows.getAll(),
  ]);
  const minimized = new Set(windows.filter((w) => w.state === "minimized").map((w) => w.id));
  const loaded = tabs.filter((t) => !t.discarded);
  // Past the cap, keep the tabs most likely to matter: what's on screen or playing,
  // then the most recently used.
  const rank = (t) => (t.active ? 2 : 0) + (t.audible ? 1 : 0);
  const chosen = [...loaded]
    .sort((a, b) => rank(b) - rank(a) || (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .slice(0, CPU_SWEEP_MAX_TABS);

  const results = await sampleTabs(chosen.map((t) => t.id));
  const measured = [];
  const skipped = [];
  for (const t of chosen) {
    const r = results.get(t.id);
    const base = { tabId: t.id, title: t.title || t.url || "", url: t.url };
    if (r.error) {
      skipped.push({ ...base, reason: r.error });
      continue;
    }
    measured.push({
      ...base,
      // Hidden from the page's point of view — not its window's showing tab, or the
      // window is minimized — which is when Chrome throttles it.
      background: !t.active || minimized.has(t.windowId),
      audible: !!t.audible,
      ...summarizeProfile(r.before, r.after),
    });
  }
  const sweep = { takenAt: Date.now(), loaded: loaded.length, tabs: measured, skipped };
  await chrome.storage.session.set({ [CPU_SWEEP_KEY]: sweep });
  scheduleScan(); // busy background tabs count toward the badge's health verdict
  return sweep;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "rescan") {
    scan().then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === "perf-report" && sender.tab?.id != null) {
    // Only the document actually showing in the tab counts. Chrome also runs the
    // probe in prerendered pages (and briefly in pages being torn down), which
    // report under the same tab id and would mix a second page's numbers in.
    if (!sender.documentLifecycle || sender.documentLifecycle === "active") {
      queuePerfReport(sender.tab.id, sender.documentId, msg.data);
    }
    return false; // fire-and-forget
  }
  if (msg?.type === "deep-profile") {
    deepProfile(msg.tabId).then(
      (metrics) => sendResponse({ ok: true, metrics }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) })
    );
    return true;
  }
  if (msg?.type === "measure-all") {
    measureAllTabs().then(
      (sweep) => sendResponse({ ok: true, sweep }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) })
    );
    return true;
  }
});
