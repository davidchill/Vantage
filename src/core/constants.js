// Shared configuration for the monitoring core.
// manifest.json is the canonical version for Chrome; keep VERSION in sync with it.
export const VERSION = "0.1.0";

// A tab not accessed in this many minutes is flagged as "idle".
export const IDLE_MINUTES = 60;

// When this many tabs share one domain, flag it as a "heavy domain".
export const HEAVY_DOMAIN_TAB_COUNT = 4;

// Background scan cadence and the alarm that drives it.
export const ALARM_NAME = "optimizer-scan";
export const SCAN_INTERVAL_MINUTES = 1;

// Where the background worker caches the latest summary for UI surfaces to read.
export const SESSION_KEY = "latestSummary";

// --- Page-performance monitoring ---
// Storage keys for the perf engine (see perf-store.js).
export const PERF_LIVE_KEY = "perfLive"; // storage.session: { [tabId]: report }
export const PERF_HISTORY_KEY = "perfHistory"; // storage.local: { [origin]: stats }

// How often the in-page probe reports (mirror REPORT_MS in perf-probe.js).
export const PERF_REPORT_INTERVAL_MS = 5000;

// Main-thread blocking (ms per reporting window) at/above which we call a page
// "heavy" — both for live warnings and for the per-origin prediction threshold.
export const BLOCKING_WARN_MS = 400;

// Smoothing factor for the per-origin rolling average (higher = more reactive).
export const PERF_HISTORY_ALPHA = 0.3;

// Cap on how many origins we retain history for (LRU-evicted beyond this).
export const PERF_HISTORY_MAX_ORIGINS = 250;

// A live report older than this is treated as stale and ignored.
export const PERF_STALE_MS = 60000;

// Minimum samples before an origin's history is trusted for predictions.
export const PERF_MIN_SAMPLES = 3;

// Background-drain: main-thread blocking (ms/window) accrued while the tab was
// HIDDEN. Lower bar than foreground — any background CPU burn is suspect.
export const BACKGROUND_BLOCKING_WARN_MS = 150;

// Memory-leak detection: flag a tab whose JS heap climbs at least this much
// over at least this long. Heap samples are downsampled into a rolling series.
export const LEAK_GROWTH_MB = 75;
export const LEAK_MIN_SPAN_MIN = 5;
export const HEAP_SERIES_MAX = 40; // samples retained per tab
export const HEAP_SERIES_MIN_GAP_MS = 25000; // downsample cadence (~25s)

// Web Vitals "poor" cutoffs (Google's thresholds) used to flag page quality.
export const LCP_POOR_MS = 4000; // slow to load
export const INP_POOR_MS = 500; // laggy interactions
export const CLS_POOR = 0.25; // visual instability
