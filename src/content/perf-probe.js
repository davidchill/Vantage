// perf-probe.js — lightweight in-page performance probe (content script).
//
// Runs in the page's isolated world at document_start. It reads the page's OWN
// Performance APIs — the same data behind DevTools' Performance tab — and reports
// compact metrics to the background worker. No DevTools "debugging" banner, and
// cheap enough to run on every tab continuously.
//
// Windowed counters (longTasks, blocking) accumulate between reports and reset
// each time. Web Vitals (LCP/CLS/INP) and heap/DOM are cumulative/point-in-time
// gauges of the page's current state.

(() => {
  // Only the top document reports, to avoid double-counting iframes.
  if (window.top !== window) return;

  const REPORT_MS = 5000; // keep in sync with PERF_REPORT_INTERVAL_MS

  // Windowed (reset each report)
  let longTasks = 0;
  let blockingMs = 0;
  let blockingHiddenMs = 0; // blocking that happened while the tab was hidden

  // Cumulative Web Vitals (persist for the page's life)
  let lcpMs = null; // Largest Contentful Paint
  let cls = 0; // Cumulative Layout Shift
  let inpMs = 0; // worst interaction latency (INP approximation)

  // Long tasks — and whether they ran while the page was backgrounded.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks++;
        const over = Math.max(0, e.duration - 50);
        blockingMs += over;
        if (document.visibilityState === "hidden") blockingHiddenMs += over;
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* Long Tasks API unsupported here */
  }

  // Largest Contentful Paint — keep the latest reported value.
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) lcpMs = Math.round(last.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    /* unsupported */
  }

  // Cumulative Layout Shift — sum shifts not caused by recent user input.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.hadRecentInput) cls += e.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    /* unsupported */
  }

  // Interaction latency — track the worst real interaction (INP approximation).
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.interactionId && e.duration > inpMs) inpMs = Math.round(e.duration);
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 40 });
  } catch {
    /* unsupported */
  }

  function buildReport() {
    let jsHeapMB = null;
    const mem = performance.memory; // Chrome-only; coarse/quantized but useful.
    if (mem && mem.usedJSHeapSize) {
      jsHeapMB = Math.round(mem.usedJSHeapSize / 1048576);
    }

    let resourceCount = 0;
    let transferBytes = 0;
    try {
      const res = performance.getEntriesByType("resource");
      resourceCount = res.length;
      for (const r of res) transferBytes += r.transferSize || 0;
    } catch {
      /* ignore */
    }

    // Navigation timing: load duration and time-to-first-byte.
    let loadMs = null;
    let ttfbMs = null;
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      if (nav) {
        if (nav.loadEventEnd > 0) loadMs = Math.round(nav.loadEventEnd);
        if (nav.responseStart > 0) ttfbMs = Math.round(nav.responseStart);
      }
    } catch {
      /* ignore */
    }

    return {
      origin: location.origin,
      hidden: document.visibilityState === "hidden",
      longTasks,
      blockingMs: Math.round(blockingMs),
      blockingHiddenMs: Math.round(blockingHiddenMs),
      jsHeapMB,
      domNodes: document.getElementsByTagName("*").length,
      resourceCount,
      transferMB: +(transferBytes / 1048576).toFixed(1),
      lcpMs,
      cls: +cls.toFixed(3),
      inpMs: inpMs || null,
      loadMs,
      ttfbMs,
    };
  }

  function report() {
    const data = buildReport();
    try {
      chrome.runtime.sendMessage({ type: "perf-report", data });
    } catch {
      // Extension context invalidated (reloaded/updated) — stop reporting.
      clearInterval(timer);
      return;
    }
    // Reset the windowed counters; vitals stay cumulative.
    longTasks = 0;
    blockingMs = 0;
    blockingHiddenMs = 0;
  }

  const timer = setInterval(report, REPORT_MS);

  // Capture late activity right before the page is backgrounded/unloaded.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") report();
  });
})();
