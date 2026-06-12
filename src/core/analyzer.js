// analyzer.js — turns a raw snapshot into a structured, UI-ready summary.
// This is the "monitoring brain": every UI surface (popup, side panel,
// dashboard) renders from the object that analyze() returns.

import {
  IDLE_MINUTES,
  HEAVY_DOMAIN_TAB_COUNT,
  BLOCKING_WARN_MS,
  PERF_STALE_MS,
  PERF_MIN_SAMPLES,
  BACKGROUND_BLOCKING_WARN_MS,
  LEAK_GROWTH_MB,
  LEAK_MIN_SPAN_MIN,
  LCP_POOR_MS,
  INP_POOR_MS,
  CLS_POOR,
} from "./constants.js";
import { computeHealth } from "./health.js";

/** Collapse trivial URL differences so true duplicates group together. */
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    return (u.origin + u.pathname.replace(/\/$/, "") + u.search).toLowerCase();
  } catch {
    return (raw || "").toLowerCase();
  }
}

/** Friendly host for grouping; strips a leading "www.". */
function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, "") || "(local)";
  } catch {
    return "(local)";
  }
}

/** Exact origin (scheme://host:port) to match the probe's per-origin history. */
function originOf(raw) {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

// API permissions that tend to mean an extension is doing heavy, always-on work.
const HEAVY_APIS = [
  "webRequest",
  "webRequestBlocking",
  "proxy",
  "debugger",
  "declarativeNetRequest",
  "declarativeNetRequestWithHostAccess",
];

// Host-permission patterns that grant access to (effectively) every site.
const ALL_SITES = /<all_urls>|\*:\/\/\*|:\/\/\*\//;

/**
 * Infer how impactful an extension is likely to be from its permissions.
 * We can't measure its memory/CPU, so "broad access" (runs on every page) is
 * our proxy for "probably one of the heavier ones".
 */
function classifyExtension(ext) {
  const hosts = ext.hostPermissions || [];
  const perms = ext.permissions || [];
  const broadHost = hosts.some((h) => ALL_SITES.test(h));
  const heavyApi = perms.some((p) => HEAVY_APIS.includes(p));

  let breadth;
  let weight;
  if (broadHost || heavyApi) {
    breadth = "broad";
    weight = 3;
  } else if (hosts.length) {
    breadth = "some";
    weight = 2;
  } else {
    breadth = "minimal";
    weight = 1;
  }
  return { breadth, weight, broadHost, heavyApi, hostCount: hosts.length };
}

/**
 * Heuristic "likely resource weight" for a single tab, from readable signals.
 * Returns { score, reason }. Asleep (discarded) tabs score 0 — they're unloaded.
 */
function tabWeight(t, isIdle, crowded, blockingMs) {
  if (t.discarded) return { score: 0, reason: "asleep" };

  let score = 10; // simply being loaded means it occupies memory
  let reason = "loaded";

  // Measured main-thread blocking is the strongest, most real signal we have.
  if (blockingMs) score += Math.min(blockingMs / 10, 50);
  if (t.audible) score += 20; // active audio/video decode is ongoing CPU
  if (isIdle && !t.active) score += 8; // loaded but untouched = wasted memory
  if (crowded) score += 4;
  if (t.pinned) score += 2;

  // Pick the most informative label, measured signals first.
  if (blockingMs >= BLOCKING_WARN_MS) reason = "janky";
  else if (t.audible) reason = "playing media";
  else if (isIdle && !t.active) reason = "loaded · idle";

  return { score, reason };
}

/** Human "Xm ago" / "Xh Ym ago" from a millisecond delta. */
function fmtAgo(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/** Compact state string for a tab. */
function tabFlags(t) {
  const f = [t.discarded ? "asleep" : "loaded"];
  if (t.active) f.push("active");
  if (t.pinned) f.push("pinned");
  if (t.audible) f.push("audio");
  if (t.mutedInfo?.muted) f.push("muted");
  if (t.status === "loading") f.push("loading");
  return f.join(", ");
}

/** Key/value detail rows for a tab (plus its live page metrics, if any). */
function tabStats(t, live, now) {
  const s = [
    ["window", t.windowId],
    ["state", tabFlags(t)],
  ];
  if (t.lastAccessed) {
    s.push(["last active", t.active ? "now" : fmtAgo(now - t.lastAccessed)]);
  }
  if (live) {
    s.push(["blocking/5s", `${live.blockingMs}ms`]);
    if ((live.blockingHiddenMs || 0) > 0) s.push(["bg blocking", `${live.blockingHiddenMs}ms`]);
    if (live.jsHeapMB != null) s.push(["js heap", `${live.jsHeapMB} MB`]);
    if (live.domNodes != null) s.push(["dom nodes", live.domNodes.toLocaleString()]);
    if (live.resourceCount != null)
      s.push(["resources", `${live.resourceCount} · ${live.transferMB}MB`]);
    if (live.lcpMs != null) s.push(["lcp", `${live.lcpMs}ms`]);
    if (live.inpMs != null) s.push(["inp", `${live.inpMs}ms`]);
    if (live.cls != null) s.push(["cls", live.cls]);
    if (live.loadMs != null) s.push(["load", `${live.loadMs}ms`]);
    const series = live.heapSeries;
    if (series && series.length >= 2) {
      const a = series[0];
      const b = series[series.length - 1];
      const span = Math.round((b.t - a.t) / 60000);
      const g = b.h - a.h;
      if (span >= 1) s.push(["heap trend", `${g >= 0 ? "+" : ""}${g}MB / ${span}m`]);
    }
  } else {
    s.push(["page metrics", "n/a (restricted/unloaded)"]);
  }
  return s;
}

/**
 * @param {{tabs: chrome.tabs.Tab[], groups?: any[], memory: any, takenAt?: number}} snapshot
 * @returns a structured summary with headline totals plus raw lists that future
 *          action UIs (sleep/close) can act on via the included tab ids.
 */
export function analyze(snapshot) {
  const { tabs, groups = [], memory, perfLive = {}, perfHistory = {} } = snapshot;
  const now = snapshot.takenAt || Date.now();
  const idleMs = IDLE_MINUTES * 60 * 1000;

  // A live perf report counts only if it's recent enough to still be true.
  const liveFor = (tabId) => {
    const l = perfLive[tabId];
    return l && now - l.ts < PERF_STALE_MS ? l : null;
  };

  const windows = new Set();
  let pinned = 0;
  let audible = 0;
  let muted = 0;
  let sleeping = 0;
  let loading = 0;

  const dupMap = new Map(); // normalized url -> tabs[]
  const domainMap = new Map(); // host -> count
  const domainTabs = new Map(); // host -> tab titles (for expandable detail)
  const idleTabs = [];

  for (const t of tabs) {
    windows.add(t.windowId);
    if (t.pinned) pinned++;
    if (t.audible) audible++;
    if (t.mutedInfo?.muted) muted++;
    if (t.discarded) sleeping++;
    if (t.status === "loading") loading++;

    const url = t.url || t.pendingUrl || "";
    const key = normalizeUrl(url);
    if (key) {
      if (!dupMap.has(key)) dupMap.set(key, []);
      dupMap.get(key).push(t);
    }

    const host = hostOf(url);
    domainMap.set(host, (domainMap.get(host) || 0) + 1);
    if (!domainTabs.has(host)) domainTabs.set(host, []);
    domainTabs.get(host).push(t.title || url || "(untitled)");

    // Idle = untouched for a while AND not something you're clearly using.
    const last = t.lastAccessed;
    if (last && now - last > idleMs && !t.active && !t.audible && !t.pinned) {
      idleTabs.push({
        id: t.id,
        title: t.title || url,
        url,
        windowId: t.windowId,
        idleMinutes: Math.round((now - last) / 60000),
        discarded: !!t.discarded,
        stats: tabStats(t, liveFor(t.id), now),
      });
    }
  }

  const duplicates = [...dupMap.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([url, arr]) => ({
      url,
      title: arr[0].title || url,
      count: arr.length,
      tabIds: arr.map((t) => t.id),
      stats: [["copies", arr.length]],
      bullets: arr.map((t) => t.title || t.url || "(untitled)"),
    }))
    .sort((a, b) => b.count - a.count);

  const domains = [...domainMap.entries()]
    .map(([host, count]) => ({
      host,
      count,
      stats: [["tabs", count]],
      bullets: (domainTabs.get(host) || []).slice(0, 12),
    }))
    .sort((a, b) => b.count - a.count);

  const heavyDomains = domains.filter((d) => d.count >= HEAVY_DOMAIN_TAB_COUNT);

  // "Likely heavy" tabs: score every loaded tab and keep the top of the list.
  const heavyTabs = tabs
    .map((t) => {
      const host = hostOf(t.url || t.pendingUrl || "");
      const crowded = (domainMap.get(host) || 0) >= HEAVY_DOMAIN_TAB_COUNT;
      const isIdle = t.lastAccessed && now - t.lastAccessed > idleMs;
      const live = liveFor(t.id);
      const blockingMs = live ? live.blockingMs : 0;
      const { score, reason } = tabWeight(t, isIdle, crowded, blockingMs);
      return {
        id: t.id,
        title: t.title || t.url || "",
        url: t.url,
        discarded: !!t.discarded,
        audible: !!t.audible,
        idleMinutes: t.lastAccessed ? Math.round((now - t.lastAccessed) / 60000) : 0,
        blockingMs,
        jsHeapMB: live ? live.jsHeapMB : null,
        score,
        reason,
        stats: tabStats(t, live, now),
      };
    })
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  // --- Page-performance advisories ------------------------------------------

  // (a) Janking the main thread right now (foreground).
  const liveWarnings = [];
  // (b) Burning CPU while hidden — the worst kind, you can't even see it.
  const backgroundDrain = [];
  // (c) Memory climbing steadily over time (likely leak / accumulator).
  const leaks = [];

  for (const t of tabs) {
    const l = liveFor(t.id);
    if (!l) continue;

    if (l.blockingMs >= BLOCKING_WARN_MS) {
      liveWarnings.push({
        id: t.id,
        title: t.title || l.origin || "",
        url: t.url,
        blockingMs: l.blockingMs,
        jsHeapMB: l.jsHeapMB,
        discarded: !!t.discarded,
        stats: tabStats(t, l, now),
      });
    }

    if (l.hidden && (l.blockingHiddenMs || 0) >= BACKGROUND_BLOCKING_WARN_MS) {
      backgroundDrain.push({
        id: t.id,
        title: t.title || l.origin || "",
        url: t.url,
        blockingHiddenMs: l.blockingHiddenMs,
        jsHeapMB: l.jsHeapMB,
        discarded: !!t.discarded,
        stats: tabStats(t, l, now),
      });
    }

    const series = l.heapSeries;
    if (series && series.length >= 4) {
      const first = series[0];
      const last = series[series.length - 1];
      const growthMB = last.h - first.h;
      const spanMin = (last.t - first.t) / 60000;
      if (growthMB >= LEAK_GROWTH_MB && spanMin >= LEAK_MIN_SPAN_MIN) {
        leaks.push({
          id: t.id,
          title: t.title || l.origin || "",
          url: t.url,
          growthMB: Math.round(growthMB),
          spanMin: Math.round(spanMin),
          currentMB: last.h,
          discarded: !!t.discarded,
          stats: tabStats(t, l, now),
        });
      }
    }
  }
  liveWarnings.sort((a, b) => b.blockingMs - a.blockingMs);
  backgroundDrain.sort((a, b) => b.blockingHiddenMs - a.blockingHiddenMs);
  leaks.sort((a, b) => b.growthMB - a.growthMB);

  // (d) Predict from per-origin history: heavy and/or poor Web Vitals. Skip
  //     origins already shouting in the live list above.
  const warningOrigins = new Set(liveWarnings.map((w) => liveFor(w.id)?.origin));
  const seenOrigins = new Set();
  const predictions = [];
  for (const t of tabs) {
    const origin = originOf(t.url || "");
    if (!origin || seenOrigins.has(origin) || warningOrigins.has(origin)) continue;
    seenOrigins.add(origin);
    const h = perfHistory[origin];
    if (!h || h.samples < PERF_MIN_SAMPLES) continue;

    const poorVitals = [];
    if (h.avgLcpMs >= LCP_POOR_MS) poorVitals.push("slow load");
    if (h.avgInpMs >= INP_POOR_MS) poorVitals.push("laggy input");
    if ((h.maxCls || 0) >= CLS_POOR) poorVitals.push("layout shift");
    const heavy = h.avgBlockingMs >= BLOCKING_WARN_MS;

    if (heavy || poorVitals.length) {
      const stats = [
        ["samples", h.samples],
        ["avg blocking", `${h.avgBlockingMs}ms`],
      ];
      if (h.avgJsHeapMB != null) stats.push(["avg heap", `${h.avgJsHeapMB}MB`]);
      if (h.avgLcpMs != null) stats.push(["avg lcp", `${h.avgLcpMs}ms`]);
      if (h.avgInpMs != null) stats.push(["avg inp", `${h.avgInpMs}ms`]);
      if (h.maxCls) stats.push(["max cls", h.maxCls]);
      if (h.avgLoadMs != null) stats.push(["avg load", `${h.avgLoadMs}ms`]);
      predictions.push({
        origin,
        avgBlockingMs: h.avgBlockingMs,
        avgJsHeapMB: h.avgJsHeapMB,
        lcpMs: h.avgLcpMs,
        inpMs: h.avgInpMs,
        poorVitals,
        heavy,
        stats,
      });
    }
  }
  predictions.sort((a, b) => b.avgBlockingMs - a.avgBlockingMs);

  const perfSummary = {
    warnMs: BLOCKING_WARN_MS,
    hasData: Object.keys(perfLive).length > 0,
    live: liveWarnings,
    background: backgroundDrain,
    leaks,
    predictions,
  };

  // Extension inventory, ranked by inferred impact (breadth, then warnings).
  const extList = snapshot.extensions || [];
  const enabledExts = extList
    .filter((e) => e.enabled)
    .map((e) => {
      const c = classifyExtension(e);
      const warnings = e.permissionWarnings || [];
      return {
        id: e.id,
        name: e.name,
        version: e.version,
        breadth: c.breadth,
        weight: c.weight,
        installType: e.installType,
        mayDisable: e.mayDisable,
        iconUrl: e.iconUrl,
        warnings,
        warningCount: warnings.length,
        stats: [
          ["version", e.version],
          ["source", e.installType || "normal"],
          ["removable", e.mayDisable === false ? "no (policy)" : "yes"],
          ["host access", c.breadth],
          ["host rules", c.hostCount],
        ],
        bullets: warnings,
      };
    })
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        b.warningCount - a.warningCount ||
        a.name.localeCompare(b.name)
    );

  const disabledList = extList
    .filter((e) => !e.enabled)
    .map((e) => ({ id: e.id, name: e.name, version: e.version }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const extensions = {
    total: extList.length,
    enabled: enabledExts.length,
    disabled: disabledList.length,
    broad: enabledExts.filter((e) => e.breadth === "broad").length,
    sideloaded: extList.filter((e) => e.installType === "sideload").length,
    dev: extList.filter((e) => e.installType === "development").length,
    forced: extList.filter((e) => e.mayDisable === false).length,
    list: enabledExts,
    disabledList,
  };

  const usedBytes = memory.capacity - memory.availableCapacity;
  const mem = {
    capacityBytes: memory.capacity,
    availableBytes: memory.availableCapacity,
    usedBytes,
    usedPercent: Math.round((usedBytes / memory.capacity) * 100),
  };

  // "Issues" = redundant duplicate tabs + idle tabs. Drives the badge color.
  const redundantDupes = duplicates.reduce((n, d) => n + (d.count - 1), 0);
  const issues = redundantDupes + idleTabs.length;

  const health = computeHealth({
    memoryPercent: mem.usedPercent,
    tabCount: tabs.length,
    backgroundDrain: backgroundDrain.length,
    leaks: leaks.length,
    liveJank: liveWarnings.length,
    heavyOrigins: predictions.filter((p) => p.heavy).length,
  });

  return {
    takenAt: now,
    totals: {
      tabs: tabs.length,
      windows: windows.size,
      groups: groups.length,
      pinned,
      audible,
      muted,
      sleeping,
      loading,
    },
    idleTabs: idleTabs.sort((a, b) => b.idleMinutes - a.idleMinutes),
    duplicates,
    domains,
    heavyDomains,
    heavyTabs,
    extensions,
    performance: perfSummary,
    health,
    memory: mem,
    issues,
  };
}
