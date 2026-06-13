// perf-store.js — persistence for page-performance data.
//
// Two layers:
//   • live    (storage.session) — latest report per tab id; cleared each browser
//             session. Powers the "what's heavy right now" view.
//   • history (storage.local)    — rolling per-ORIGIN profile that survives
//             restarts. Powers prediction ("this site tends to be heavy").

import {
  PERF_LIVE_KEY,
  PERF_HISTORY_KEY,
  PERF_HISTORY_ALPHA,
  PERF_HISTORY_MAX_ORIGINS,
  HEAP_SERIES_MAX,
  HEAP_SERIES_MIN_GAP_MS,
} from "./constants.js";

/** Exponential moving average; seeds with x when there's no prior value. */
function ema(prev, x) {
  if (x == null) return prev;
  if (prev == null) return x;
  return Math.round(prev * (1 - PERF_HISTORY_ALPHA) + x * PERF_HISTORY_ALPHA);
}

/** Append one report to a tab's live entry, maintaining the downsampled heap series. */
function foldLive(prevLive, data, now) {
  let heapSeries = (prevLive && prevLive.heapSeries) || [];
  if (data.jsHeapMB != null) {
    const last = heapSeries[heapSeries.length - 1];
    if (!last || now - last.t >= HEAP_SERIES_MIN_GAP_MS) {
      heapSeries = [...heapSeries, { t: now, h: data.jsHeapMB }];
      if (heapSeries.length > HEAP_SERIES_MAX) {
        heapSeries = heapSeries.slice(-HEAP_SERIES_MAX);
      }
    }
  }
  return { ...data, ts: now, heapSeries };
}

/** Fold one report into an origin's rolling per-origin history record. */
function foldHistory(prev, data, now) {
  return prev
    ? {
        avgBlockingMs: ema(prev.avgBlockingMs, data.blockingMs),
        avgJsHeapMB:
          data.jsHeapMB != null ? ema(prev.avgJsHeapMB ?? data.jsHeapMB, data.jsHeapMB) : prev.avgJsHeapMB,
        avgLcpMs: ema(prev.avgLcpMs, data.lcpMs),
        avgInpMs: ema(prev.avgInpMs, data.inpMs),
        avgLoadMs: ema(prev.avgLoadMs, data.loadMs),
        maxCls: Math.max(prev.maxCls || 0, data.cls || 0),
        samples: prev.samples + 1,
        lastSeen: now,
      }
    : {
        avgBlockingMs: data.blockingMs,
        avgJsHeapMB: data.jsHeapMB,
        avgLcpMs: data.lcpMs ?? null,
        avgInpMs: data.inpMs ?? null,
        avgLoadMs: data.loadMs ?? null,
        maxCls: data.cls || 0,
        samples: 1,
        lastSeen: now,
      };
}

/**
 * Fold a batch of content-script reports into the live + history stores with a
 * single read-modify-write of each store, no matter how many reports are in the
 * batch. Each entry is { tabId, data, ts }; entries are folded in arrival order.
 */
export async function recordPerfReports(reports) {
  if (!reports.length) return;

  const [liveWrap, histWrap] = await Promise.all([
    chrome.storage.session.get(PERF_LIVE_KEY),
    chrome.storage.local.get(PERF_HISTORY_KEY),
  ]);
  const live = liveWrap[PERF_LIVE_KEY] || {};
  const history = histWrap[PERF_HISTORY_KEY] || {};
  let historyTouched = false;

  for (const { tabId, data, ts } of reports) {
    live[tabId] = { ...foldLive(live[tabId], data, ts), tabId };

    // Per-origin rolling history (skip opaque origins).
    if (data.origin && data.origin !== "null") {
      history[data.origin] = foldHistory(history[data.origin], data, ts);
      historyTouched = true;
    }
  }

  if (historyTouched) pruneHistory(history);

  await Promise.all([
    chrome.storage.session.set({ [PERF_LIVE_KEY]: live }),
    historyTouched
      ? chrome.storage.local.set({ [PERF_HISTORY_KEY]: history })
      : Promise.resolve(),
  ]);
}

/** Cap history size by evicting the least-recently-seen origins. */
function pruneHistory(history) {
  const origins = Object.keys(history);
  if (origins.length <= PERF_HISTORY_MAX_ORIGINS) return;
  origins
    .sort((a, b) => history[a].lastSeen - history[b].lastSeen)
    .slice(0, origins.length - PERF_HISTORY_MAX_ORIGINS)
    .forEach((o) => delete history[o]);
}

/** Forget a tab's live entry (call when the tab closes). */
export async function dropLiveTab(tabId) {
  const wrap = await chrome.storage.session.get(PERF_LIVE_KEY);
  const live = wrap[PERF_LIVE_KEY];
  if (live && live[tabId] != null) {
    delete live[tabId];
    await chrome.storage.session.set({ [PERF_LIVE_KEY]: live });
  }
}

/** Read both stores for the analyzer. */
export async function getPerf() {
  const [liveWrap, histWrap] = await Promise.all([
    chrome.storage.session.get(PERF_LIVE_KEY),
    chrome.storage.local.get(PERF_HISTORY_KEY),
  ]);
  return {
    live: liveWrap[PERF_LIVE_KEY] || {},
    history: histWrap[PERF_HISTORY_KEY] || {},
  };
}
