// strain-history.js — the persistent "repeat offender" ledger.
//
// perf-store's history answers "how heavy is this origin on average?". This
// answers the orthogonal question "how OFTEN, and how persistently, does this
// origin cross into strain?" — the time dimension behind "continuously causing
// strain". One record per origin, in storage.local so it survives restarts.
//
// The analyzer already decides what's strained each scan (performance.live /
// .background / .leaks / .predictions). This module just folds those verdicts
// into a running tally per origin, then the analyzer reads the tally back (via
// the snapshot) to surface the chronic offenders. No new measurement here.

import {
  STRAIN_HISTORY_KEY,
  STRAIN_HISTORY_MAX_ORIGINS,
  STRAIN_STREAK_GAP_MS,
  CHRONIC_FORGET_DAYS,
} from "./constants.js";

const DAY_MS = 86400000;

/** Exact origin (scheme://host:port) to match the per-origin perf history. */
function originOf(raw) {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Collapse one analyzed summary into origin -> Set(kinds) strained this scan.
 * Live jank / background drain / leaks are per-tab (resolve origin from the tab
 * url); predictions are already per-origin. Heavy main-thread blocking — whether
 * measured live or predicted from history — both fold into the "jank" kind.
 */
function strainedOriginsFrom(summary) {
  const perf = summary.performance || {};
  const map = new Map();
  const add = (origin, kind) => {
    if (!origin) return;
    if (!map.has(origin)) map.set(origin, new Set());
    map.get(origin).add(kind);
  };

  for (const a of perf.live || []) add(originOf(a.url), "jank");
  for (const b of perf.background || []) add(originOf(b.url), "background");
  for (const lk of perf.leaks || []) add(originOf(lk.url), "leak");
  for (const p of perf.predictions || []) {
    if (p.heavy) add(p.origin, "jank");
    if (p.poorVitals && p.poorVitals.length) add(p.origin, "vitals");
  }
  return map;
}

/**
 * Fold one scan's strained origins into the persistent ledger. Called once per
 * authoritative background scan (NOT on every 5s panel re-render — that would
 * inflate the counts).
 */
export async function recordStrain(summary, now) {
  const strained = strainedOriginsFrom(summary);
  const wrap = await chrome.storage.local.get(STRAIN_HISTORY_KEY);
  const ledger = wrap[STRAIN_HISTORY_KEY] || {};

  for (const [origin, kinds] of strained) {
    const prev = ledger[origin];
    // Consecutive only if the previous strained scan was recent enough.
    const consecutive = prev && now - prev.lastStrained <= STRAIN_STREAK_GAP_MS;
    const streak = consecutive ? prev.streak + 1 : 1;

    const kindCounts = { ...(prev?.kinds || {}) };
    for (const k of kinds) kindCounts[k] = (kindCounts[k] || 0) + 1;

    ledger[origin] = {
      firstSeen: prev?.firstSeen ?? now,
      lastStrained: now,
      strainScans: (prev?.strainScans || 0) + 1,
      streak,
      maxStreak: Math.max(prev?.maxStreak || 0, streak),
      kinds: kindCounts,
    };
  }

  // Origins that WERE strained before but recovered this scan: break the running
  // streak so chronic-intensity reflects current behavior. Cumulative counts and
  // the worst-ever streak are preserved.
  for (const origin of Object.keys(ledger)) {
    if (!strained.has(origin) && ledger[origin].streak > 0) {
      ledger[origin] = { ...ledger[origin], streak: 0 };
    }
  }

  prune(ledger, now);
  await chrome.storage.local.set({ [STRAIN_HISTORY_KEY]: ledger });
}

/** Drop long-quiet origins, then LRU-cap the ledger by last-strained time. */
function prune(ledger, now) {
  const forgetMs = CHRONIC_FORGET_DAYS * DAY_MS;
  for (const origin of Object.keys(ledger)) {
    if (now - ledger[origin].lastStrained > forgetMs) delete ledger[origin];
  }
  const origins = Object.keys(ledger);
  if (origins.length <= STRAIN_HISTORY_MAX_ORIGINS) return;
  origins
    .sort((a, b) => ledger[a].lastStrained - ledger[b].lastStrained)
    .slice(0, origins.length - STRAIN_HISTORY_MAX_ORIGINS)
    .forEach((o) => delete ledger[o]);
}

/** Read the ledger for the analyzer. */
export async function getStrainHistory() {
  const wrap = await chrome.storage.local.get(STRAIN_HISTORY_KEY);
  return wrap[STRAIN_HISTORY_KEY] || {};
}
