// Shared configuration for the monitoring core.
// manifest.json is the canonical version for Chrome; keep VERSION in sync with it.
export const VERSION = "0.2.1";

// A tab not accessed in this many minutes is flagged as "idle".
export const IDLE_MINUTES = 60;

// When this many tabs share one domain, flag it as a "heavy domain".
export const HEAVY_DOMAIN_TAB_COUNT = 4;

// Background scan cadence and the alarm that drives it.
export const ALARM_NAME = "optimizer-scan";
export const SCAN_INTERVAL_MINUTES = 1;

// --- Page-performance monitoring ---
// Storage keys for the perf engine (see perf-store.js).
export const PERF_LIVE_KEY = "perfLive"; // storage.session: { [tabId]: report }
export const PERF_HISTORY_KEY = "perfHistory"; // storage.local: { [origin]: stats }

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

// --- Chronic strain ledger (persistent "repeat offenders" over time) ---
// perfHistory answers "how heavy is this origin on average?". This answers the
// orthogonal question "how OFTEN, and how persistently, does it cross into
// strain?" — the time dimension behind "continuously causing strain". One record
// per origin in storage.local, so it survives restarts (see strain-history.js).
export const STRAIN_HISTORY_KEY = "strainHistory"; // storage.local: { [origin]: record }
export const STRAIN_HISTORY_MAX_ORIGINS = 250; // LRU cap, mirrors perf history

// Two strained scans count as "consecutive" (one streak) if seen within this
// gap. A generous multiple of the scan cadence so a single missed/bursted scan
// doesn't falsely break a streak.
export const STRAIN_STREAK_GAP_MS = SCAN_INTERVAL_MINUTES * 60 * 1000 * 3;

// An origin is "chronic" once flagged strained in at least this many scans...
export const CHRONIC_MIN_EPISODES = 5;
// ...and still strained within this window (keeps the list about CURRENT pain,
// not something that misbehaved once last month).
export const CHRONIC_RECENT_DAYS = 7;
// Forget origins not strained in this long, so the ledger reflects recent life.
export const CHRONIC_FORGET_DAYS = 30;

// --- Auto-management (rule-based sleep/close) ---
// Settings live in storage.local (survive restarts); the strain tracker lives in
// storage.session (a within-session concept that should reset each browser run).
export const SETTINGS_KEY = "settings"; // storage.local: user config
export const STRAIN_TRACKER_KEY = "strainTracker"; // storage.session: tabId:kind -> since
export const ACTION_LOG_KEY = "actionLog"; // storage.local: audit trail of auto-actions
export const ACTION_LOG_MAX = 100; // newest-first; older entries evicted past this

// How long a tab must stay continuously strained before automation acts on it.
// At the 1-minute scan cadence this is roughly "must be bad for N scans in a row".
export const DEFAULT_SUSTAIN_MINUTES = 5;

// --- AI analysis (optional; bring-your-own Anthropic API key) ---
// On demand, we send the analyzed summary to Claude and render its read on what's
// straining the browser plus concrete suggestions. Off until the user adds a key.
export const AI_API_URL = "https://api.anthropic.com/v1/messages";
export const AI_API_VERSION = "2023-06-01"; // anthropic-version header
export const AI_DEFAULT_MODEL = "claude-opus-4-8";
// Models offered in the settings dropdown (id must be a valid Anthropic model).
export const AI_MODELS = [
  { id: "claude-opus-4-8", label: "Opus 4.8 — most capable" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — fast & cheap" },
];
// Output cap. The structured reply (headline + a handful of suggestions) is small;
// this stays well under the non-streaming timeout ceiling.
export const AI_MAX_TOKENS = 2000;
