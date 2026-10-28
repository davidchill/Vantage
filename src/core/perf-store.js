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
  PERF_WINDOW_MS,
} from "./constants.js";

/**
 * Blocking counters cover one reporting window, nominally PERF_WINDOW_MS. Chrome
 * throttles timers in long-hidden tabs to about one wake-up a minute, stretching
 * that window ~12×, so scale the counters back to a per-window rate — otherwise a
 * single 200ms task a minute reads like heavy background CPU, and per-origin
 * averages mix 5s and 60s windows. Only ever scales down: a short window (the early
 * report sent as a tab is hidden) is left as-is rather than amplifying one long
 * task into a huge rate. Reports without windowMs (older probes) pass through.
 */
function normalizeWindow(data) {
  const windowMs = Math.max(data.windowMs || PERF_WINDOW_MS, PERF_WINDOW_MS);
  if (windowMs === PERF_WINDOW_MS) return data;
  const scale = PERF_WINDOW_MS / windowMs;
  return {
    ...data,
    blockingMs: Math.round((data.blockingMs || 0) * scale),
    blockingHiddenMs: Math.round((data.blockingHiddenMs || 0) * scale),
  };
}

/**
 * Exponential moving average; seeds with x when there's no prior value. Rounds to
 * whole numbers unless `digits` asks for decimals (CLS is a small fraction).
 */
function ema(prev, x, digits = 0) {
  if (x == null) return prev;
  if (prev == null) return x;
  const v = prev * (1 - PERF_HISTORY_ALPHA) + x * PERF_HISTORY_ALPHA;
  return digits ? +v.toFixed(digits) : Math.round(v);
}

/**
 * Append one report to a tab's live entry, maintaining the downsampled heap series.
 * The series belongs to a single document: a navigation or reload (new documentId)
 * or a change of origin starts it fresh — otherwise moving a tab to a heavier site
 * would read as memory growth.
 */
function foldLive(prevLive, data, now, docId) {
  const sameDoc = prevLive && prevLive.docId === docId && prevLive.origin === data.origin;
  let heapSeries = (sameDoc && prevLive.heapSeries) || [];
  if (data.jsHeapMB != null) {
    const last = heapSeries[heapSeries.length - 1];
    if (!last || now - last.t >= HEAP_SERIES_MIN_GAP_MS) {
      heapSeries = [...heapSeries, { t: now, h: data.jsHeapMB }];
      if (heapSeries.length > HEAP_SERIES_MAX) {
        heapSeries = heapSeries.slice(-HEAP_SERIES_MAX);
      }
    }
  }
  return { ...data, ts: now, docId, heapSeries };
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
        // A rolling average rather than an all-time max, so one bad visit fades
        // instead of flagging the site for layout shift forever.
        avgCls: ema(prev.avgCls, data.cls, 3),
        samples: prev.samples + 1,
        lastSeen: now,
      }
    : {
        avgBlockingMs: data.blockingMs,
        avgJsHeapMB: data.jsHeapMB,
        avgLcpMs: data.lcpMs ?? null,
        avgInpMs: data.inpMs ?? null,
        avgLoadMs: data.loadMs ?? null,
        avgCls: data.cls ?? null,
        samples: 1,
        lastSeen: now,
      };
}

/**
 * Fold a batch of content-script reports into the live + history stores with a
 * single read-modify-write of each store, no matter how many reports are in the
 * batch. Each entry is { tabId, docId, data, ts }; entries are folded in arrival
 * order.
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

  for (const { tabId, docId, data: raw, ts } of reports) {
    const data = normalizeWindow(raw);
    live[tabId] = { ...foldLive(live[tabId], data, ts, docId), tabId };

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
