// perf-probe.js — lightweight in-page performance probe (content script).
//
// Runs in the page's isolated world at document_start. It reads the page's OWN
// Performance APIs — the same data behind DevTools' Performance tab — and reports
// compact metrics to the background worker. No DevTools "debugging" banner, and
// cheap enough to run on every tab continuously.
//
// Windowed counters (longTasks, blocking) accumulate between reports and reset
// each time. Each report also carries its window length (windowMs): Chrome stretches
// the 5s timer to about a minute in long-hidden tabs, and the worker normalizes by
// it. Web Vitals (LCP/CLS/INP) and heap/DOM are cumulative/point-in-time gauges of
// the page's current state.

(() => {
  // Only the top document reports, to avoid double-counting iframes.
  if (window.top !== window) return;

  // One probe per page. On install/update the worker also injects the probe into
  // tabs that are already open, which can land on a page that already runs one; the
  // newest instance stops the earlier one and takes over.
  window.__vantageProbe?.stop();

  const REPORT_MS = 5000; // probe report cadence (the panel re-renders on the same beat)

  // Windowed (reset each report)
  let longTasks = 0;
  let blockingMs = 0;
  let blockingHiddenMs = 0; // blocking that happened while the tab was hidden
  let windowStart = performance.now(); // when the current window opened

  // Cumulative Web Vitals (persist for the page's life)
  let lcpMs = null; // Largest Contentful Paint
  let cls = 0; // Cumulative Layout Shift (worst session window so far)
  let inpMs = 0; // worst interaction latency (INP approximation)

  // Every PerformanceObserver the probe opens, so stop() can disconnect them all.
  const observers = [];

  /** Observe one entry type, replaying entries recorded before we registered. */
  function watch(type, onEntries, opts = {}) {
    try {
      const o = new PerformanceObserver((list) => onEntries(list.getEntries()));
      o.observe({ type, buffered: true, ...opts });
      observers.push(o);
    } catch {
      /* entry type unsupported here */
    }
  }

  // Long tasks — and whether they ran while the page was backgrounded.
  watch("longtask", (entries) => {
    for (const e of entries) {
      longTasks++;
      const over = Math.max(0, e.duration - 50);
      blockingMs += over;
      if (document.visibilityState === "hidden") blockingHiddenMs += over;
    }
  });

  // Largest Contentful Paint — keep the latest reported value.
  watch("largest-contentful-paint", (entries) => {
    const last = entries[entries.length - 1];
    if (last) lcpMs = Math.round(last.startTime);
  });

  // Cumulative Layout Shift, as Core Web Vitals defines it: shifts not caused by
  // recent input are grouped into session windows (a window closes after a 1s gap
  // or 5s total) and CLS is the worst window. Summing every shift over the page's
  // life instead grows without bound on long-lived tabs.
  let sessionCls = 0;
  let sessionStart = 0;
  let sessionLast = 0;
  watch("layout-shift", (entries) => {
    for (const e of entries) {
      if (e.hadRecentInput) continue;
      if (sessionCls && e.startTime - sessionLast < 1000 && e.startTime - sessionStart < 5000) {
        sessionCls += e.value;
      } else {
        sessionCls = e.value;
        sessionStart = e.startTime;
      }
      sessionLast = e.startTime;
      if (sessionCls > cls) cls = sessionCls;
    }
  });

  // Interaction latency — track the worst real interaction (INP approximation).
  watch(
    "event",
    (entries) => {
      for (const e of entries) {
        if (e.interactionId && e.duration > inpMs) inpMs = Math.round(e.duration);
      }
    },
    { durationThreshold: 40 }
  );

  // Resource timing — accumulated incrementally as entries arrive, rather than
  // re-scanning the whole (ever-growing) resource buffer on every report. Count and
  // bytes are cumulative over the page's life; hosts is the unique set of cross-host
  // endpoints the page contacted (hostnames only — the raw material the panel
  // classifies into ads/trackers — capped to keep the payload small). buffered:true
  // replays the entries that loaded before this observer registered.
  let resourceCount = 0;
  let transferBytes = 0;
  const resourceHosts = new Set();
  const selfHost = location.hostname;
  watch("resource", (entries) => {
    for (const r of entries) {
      resourceCount++;
      transferBytes += r.transferSize || 0;
      if (resourceHosts.size < 200) {
        try {
          const h = new URL(r.name).hostname;
          if (h && h !== selfHost) resourceHosts.add(h);
        } catch {
          /* non-URL resource name */
        }
      }
    }
  });

  // Script attribution (Long Animation Frames, Chrome 123+). Each long frame lists
  // the scripts that ran in it (those over 5ms) with their source URL; we total
  // each source's run time and forced style/layout time over the page's life.
  // Sources are hostnames for web scripts, "ext:<id>" for an extension script
  // injected into the page itself, and "" when Chrome gives no URL (inline handlers,
  // eval). Extension content scripts (isolated worlds, this probe included) and
  // cross-origin iframes are never attributed by Chrome, so they can't appear here.
  const loafSupported = !!PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame");
  const SCRIPT_SOURCES_MAX = 100; // bound memory on script-heavy pages
  const SCRIPT_REPORT_MAX = 15; // heaviest sources sent per report
  const SCRIPT_WINDOW_MAX = 5; // heaviest sources of the latest window sent per report
  const scriptCost = new Map(); // source -> [runMs, forcedLayoutMs], page life
  // The same, for the current reporting window only (reset each report), so a janky
  // window can be blamed on what ran in it rather than on what ran at page load.
  let windowScriptCost = new Map();

  function scriptSource(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      return u.protocol === "chrome-extension:" ? `ext:${u.hostname}` : u.hostname;
    } catch {
      return "";
    }
  }

  // Only where supported: observing an unknown entry type logs a console warning in
  // every page on older Chrome, which an extension shouldn't add to sites.
  if (loafSupported) watch("long-animation-frame", (entries) => {
    for (const frame of entries) {
      for (const s of frame.scripts || []) {
        const source = scriptSource(s.sourceURL);
        const layoutMs = s.forcedStyleAndLayoutDuration || 0;
        addScriptCost(scriptCost, source, s.duration, layoutMs);
        addScriptCost(windowScriptCost, source, s.duration, layoutMs);
      }
    }
  });

  function addScriptCost(costs, source, ms, layoutMs) {
    let cost = costs.get(source);
    if (!cost) {
      if (costs.size >= SCRIPT_SOURCES_MAX) return;
      cost = [0, 0];
      costs.set(source, cost);
    }
    cost[0] += ms;
    cost[1] += layoutMs;
  }

  /** The heaviest sources in `costs`, as compact [source, runMs, layoutMs] rows. */
  function topScripts(costs, max) {
    return [...costs]
      .sort((a, b) => b[1][0] - a[1][0])
      .slice(0, max)
      .map(([source, [ms, layoutMs]]) => [source, Math.round(ms), Math.round(layoutMs)]);
  }

  // DOM node count is a full-tree walk — comparatively expensive — so sample it on a
  // slower cadence (every DOM_SAMPLE_EVERY reports) and never while hidden, where it
  // can't visibly change. Between samples we report the last value.
  let domNodes = null;
  let domTick = 0;
  const DOM_SAMPLE_EVERY = 6; // ~30s at the 5s report cadence

  // Navigation timing's load duration is fixed once the page finishes loading, so
  // read it only until it's known, then stop touching the navigation entry.
  let loadMs = null;

  function buildReport() {
    let jsHeapMB = null;
    const mem = performance.memory; // Chrome-only: this renderer's JS heap.
    if (mem && mem.usedJSHeapSize) {
      jsHeapMB = Math.round(mem.usedJSHeapSize / 1048576);
    }

    // Re-walk the DOM only on a sampled tick, and only while the tab is visible.
    domTick++;
    if (
      document.visibilityState !== "hidden" &&
      (domNodes == null || domTick >= DOM_SAMPLE_EVERY)
    ) {
      domNodes = document.getElementsByTagName("*").length;
      domTick = 0;
    }

    if (loadMs == null) {
      try {
        const nav = performance.getEntriesByType("navigation")[0];
        if (nav && nav.loadEventEnd > 0) loadMs = Math.round(nav.loadEventEnd);
      } catch {
        /* ignore */
      }
    }

    return {
      origin: location.origin,
      hidden: document.visibilityState === "hidden",
      longTasks,
      blockingMs: Math.round(blockingMs),
      blockingHiddenMs: Math.round(blockingHiddenMs),
      windowMs: Math.round(performance.now() - windowStart),
      jsHeapMB,
      domNodes,
      resourceCount,
      transferMB: +(transferBytes / 1048576).toFixed(1),
      resourceHosts: [...resourceHosts],
      scripts: topScripts(scriptCost, SCRIPT_REPORT_MAX),
      scriptsWindow: topScripts(windowScriptCost, SCRIPT_WINDOW_MAX),
      loaf: loafSupported,
      lcpMs,
      cls: +cls.toFixed(3),
      inpMs: inpMs || null,
      loadMs,
    };
  }

  function report() {
    const data = buildReport();
    try {
      chrome.runtime.sendMessage({ type: "perf-report", data });
    } catch {
      // Extension context invalidated (reloaded/updated) — stop reporting.
      stop();
      return;
    }
    // Reset the windowed counters; vitals stay cumulative.
    longTasks = 0;
    blockingMs = 0;
    blockingHiddenMs = 0;
    windowStart = performance.now();
    windowScriptCost = new Map();
  }

  // Capture late activity right before the page is backgrounded/unloaded.
  function onVisibilityChange() {
    if (document.visibilityState === "hidden") report();
  }

  /** Shut this probe down completely (context invalidated, or a newer probe took over). */
  function stop() {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    for (const o of observers) o.disconnect();
  }

  const timer = setInterval(report, REPORT_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.__vantageProbe = { stop };
})();
