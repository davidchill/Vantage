// automation.js — rule-based auto-management of strained tabs.
//
// Detection is already done by the analyzer: performance.background lists hidden
// tabs burning CPU, performance.leaks lists tabs whose heap keeps climbing. This
// module adds the missing dimension — TIME. A tab is only acted on once it has
// been continuously strained for `sustainMinutes`, so a momentary spike never
// costs you a tab.
//
// State:
//   • strain tracker (storage.session) — when each tab:kind first went bad. Reset
//     every run against what's actually strained right now, so recovery (or the
//     tab closing) drops the entry and the clock restarts next time.
//   • action log   (storage.local)     — an audit trail of everything we did and
//     why, so an auto-close is never a silent disappearance.
//
// Every action re-reads live tab state at the moment it acts (never trusting the
// up-to-60s-old scan) and refuses to touch tabs you're plainly using.

import {
  STRAIN_TRACKER_KEY,
  ACTION_LOG_KEY,
  ACTION_LOG_MAX,
} from "./constants.js";
import { getSettings, TRIGGER_LABELS } from "./settings.js";
import { sleepTab, closeTabs } from "./actions.js";

/**
 * Pull the currently-strained candidates out of an analyzed summary, one entry
 * per (tab, trigger-kind). Each carries a short human detail for the log.
 */
function candidatesFrom(summary, triggers) {
  const out = [];
  const perf = summary.performance || {};

  if (triggers.backgroundDrain?.enabled) {
    for (const b of perf.background || []) {
      if (b.discarded) continue; // already asleep — nothing draining
      out.push({
        id: b.id,
        kind: "backgroundDrain",
        title: b.title,
        url: b.url,
        detail: `${b.blockingHiddenMs}ms background CPU per window`,
      });
    }
  }

  if (triggers.leak?.enabled) {
    for (const lk of perf.leaks || []) {
      if (lk.discarded) continue;
      out.push({
        id: lk.id,
        kind: "leak",
        title: lk.title,
        url: lk.url,
        detail: `heap +${lk.growthMB}MB over ${lk.spanMin}m → ${lk.currentMB}MB`,
      });
    }
  }

  return out;
}

/**
 * Safety gate, re-checked against LIVE tab state right before acting. Returns the
 * fresh tab if it's still a valid target, or null to skip. We never auto-touch a
 * tab you're looking at, have pinned, or that's playing audio.
 */
async function liveTargetOrNull(id) {
  let tab;
  try {
    tab = await chrome.tabs.get(id);
  } catch {
    return null; // tab is gone
  }
  if (tab.active || tab.pinned || tab.audible || tab.discarded) return null;
  return tab;
}

/** Append entries to the audit log, newest-first, capped at ACTION_LOG_MAX. */
async function appendToLog(entries) {
  if (!entries.length) return;
  const wrap = await chrome.storage.local.get(ACTION_LOG_KEY);
  const log = wrap[ACTION_LOG_KEY] || [];
  const next = [...entries, ...log].slice(0, ACTION_LOG_MAX);
  await chrome.storage.local.set({ [ACTION_LOG_KEY]: next });
}

/**
 * The main entry point — call once per scan with the freshly-analyzed summary.
 * Returns a short list of the actions taken this run (empty when idle/disabled).
 */
export async function runAutomation(summary, now = Date.now()) {
  const settings = await getSettings();

  // Even when disabled, clear any stale tracker so we don't resume mid-strain
  // with a head start the moment the user flips it on.
  if (!settings.enabled) {
    await chrome.storage.session.remove(STRAIN_TRACKER_KEY);
    return [];
  }

  const sustainMs = settings.sustainMinutes * 60 * 1000;
  const candidates = candidatesFrom(summary, settings.triggers);

  // Reconcile the tracker: keep the clock running for tabs still strained, start
  // it for newly-strained ones, and forget everyone else (recovered or closed).
  const wrap = await chrome.storage.session.get(STRAIN_TRACKER_KEY);
  const prev = wrap[STRAIN_TRACKER_KEY] || {};
  const tracker = {};
  const dueByTab = new Map(); // tabId -> { actions:Set, meta }

  for (const c of candidates) {
    const trackKey = `${c.id}:${c.kind}`;
    const since = prev[trackKey]?.since ?? now;
    tracker[trackKey] = { since, kind: c.kind };

    if (now - since < sustainMs) continue; // not strained long enough yet

    // Due to act. Resolve this trigger's configured action; if a tab is due for
    // multiple kinds, "close" wins over "sleep" (the more decisive intent).
    const action = settings.triggers[c.kind]?.action || "sleep";
    const entry = dueByTab.get(c.id) || { actions: new Set(), reasons: [], meta: c };
    entry.actions.add(action);
    entry.reasons.push({ kind: c.kind, detail: c.detail });
    dueByTab.set(c.id, entry);
  }

  // Act. Re-validate each target live, then sleep or close it.
  const performed = [];
  const logEntries = [];
  for (const [id, entry] of dueByTab) {
    const tab = await liveTargetOrNull(id);
    if (!tab) continue;

    const action = entry.actions.has("close") ? "close" : "sleep";
    try {
      if (action === "close") await closeTabs(id);
      else await sleepTab(id);
    } catch (err) {
      console.warn("automation action failed:", err);
      continue;
    }

    const reason = entry.reasons
      .map((r) => `${TRIGGER_LABELS[r.kind]} (${r.detail})`)
      .join("; ");
    performed.push({ id, action, title: entry.meta.title });
    logEntries.push({
      t: now,
      action,
      kinds: entry.reasons.map((r) => r.kind),
      reason,
      title: entry.meta.title || entry.meta.url || "(untitled)",
      url: entry.meta.url || "",
    });

    // Drop this tab's tracker entries so a slept tab that re-strains later starts
    // a fresh clock rather than re-firing immediately.
    for (const r of entry.reasons) delete tracker[`${id}:${r.kind}`];
  }

  await chrome.storage.session.set({ [STRAIN_TRACKER_KEY]: tracker });
  await appendToLog(logEntries);

  return performed;
}

/** Read the audit log (newest-first). */
export async function getActionLog() {
  const wrap = await chrome.storage.local.get(ACTION_LOG_KEY);
  return wrap[ACTION_LOG_KEY] || [];
}

/** Wipe the audit log. */
export async function clearActionLog() {
  await chrome.storage.local.remove(ACTION_LOG_KEY);
}
