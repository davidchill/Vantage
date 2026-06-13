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

  const REPORT_MS = 5000; // probe report cadence (the panel re-renders on the same beat)

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
  try {
    new PerformanceObserver((list) => {
      for (const r of list.getEntries()) {
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
    }).observe({ type: "resource", buffered: true });
  } catch {
    /* Resource Timing API unsupported here */
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
    const mem = performance.memory; // Chrome-only; coarse/quantized but useful.
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
      jsHeapMB,
      domNodes,
      resourceCount,
      transferMB: +(transferBytes / 1048576).toFixed(1),
      resourceHosts: [...resourceHosts],
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
