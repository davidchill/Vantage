# Changelog

## v0.1.0 — 2026-06-11

Initial release of **Vantage** — a live performance console for Chrome. Read-only monitoring and diagnosis, plus manual tab cleanup actions.

### Architecture
- **Manifest V3** extension. Permissions: `tabs`, `tabGroups`, `system.memory`, `system.cpu`, `storage`, `alarms`, `sidePanel`, `management`, `debugger`. Content script on `http/https`. Requires Chrome 121+.
- **Surface-agnostic core** (`src/core/`): `collector.js` (reads Chrome APIs), `analyzer.js` (the "monitoring brain" — turns a snapshot into a structured, UI-ready summary), `constants.js` (thresholds), `health.js` (verdict synthesis), `perf-store.js` (page-performance persistence), `actions.js` (tab operations).
- **Background service worker** rescans every minute and on tab activity (debounced), caches the summary, and drives the toolbar badge (live tab count; red when issues exist).

### Monitoring
- **Tab telemetry** — totals (tabs, windows, sleeping, audio, pinned, muted), duplicate-tab sets, idle tabs (60m+), and crowded domains.
- **System resources** — memory and CPU gauges (CPU sampled over a short interval).
- **"Likely heavy" tabs** — a heuristic ranking from readable signals (media, loaded-but-idle, crowding) fused with measured main-thread blocking.

### Page-performance engine
- **In-page probe** (content script) reads the page's own Performance APIs — no DevTools banner: Long Tasks (main-thread blocking), `performance.memory`, resource timing, and Web Vitals (LCP, CLS, INP, load/TTFB).
- **Background CPU-drain detection** — flags tabs burning CPU while hidden.
- **Memory-leak trends** — tracks a downsampled per-tab heap series and flags steady climbers (e.g. +75 MB over 5 min+).
- **Per-origin history** (persisted) powers **predictions** — "this site tends to be heavy / slow to load / laggy to interact with."
- **Deep profiler** — on-demand real metrics (JS heap, DOM nodes, listeners, script time) for one tab via `chrome.debugger` → `Performance.getMetrics`.

### Extensions inventory
- Lists installed extensions ranked by inferred impact (permission breadth), with the extension's icon, version, install source (flags **sideloaded**, **dev**, and **policy-forced**), and the full plain-English permission warnings.

### Chrome Health Score
- Synthesizes every signal (memory pressure, tab count, background drain, leaks, live jank, heavy origins) into a single **Good / Strained / Heavy** verdict with the top contributing factors.

### Actions
- Per-tab **sleep** (`tabs.discard`) and **close**, plus bulk **sleep all idle** and **purge duplicate** sweeps. Destructive actions confirm first.

### UI
- **"Observability console"** side panel — dark, monospace, instrument-grade: command-bar header with a live indicator, health verdict hero, hairline metric cluster, segmented telemetry bars, and log-style sections. Blueprint-grid atmosphere; motion confined to the persistent shell so the 5s live refresh never flickers; honors `prefers-reduced-motion`.
- **Toolbar-toggled side panel** — clicking the toolbar icon opens/closes the panel from any page.
- **Collapsible rows** — every listed item expands to a detail block (full URL, tab state, live page metrics, heap trend, per-origin averages, duplicate/domain member lists, extension permission warnings). Expand state persists across the live refresh.

### Notes & limitations
- Stable Chrome does not expose per-tab or per-extension CPU/RAM to extensions; Vantage uses system-level resources plus behavioral heuristics and permission breadth as proxies. The deep profiler is the one source of true per-tab figures.
- `performance.memory` is coarse (Chrome quantizes it); treat live per-tab heap as a relative signal.
- Content scripts can't run on `chrome://`, the Web Store, or the PDF viewer; those tabs show metadata only.
- Uses the system monospace stack (Cascadia Code / JetBrains Mono / SF Mono); no bundled font.
- No custom toolbar icon yet — Chrome shows a default placeholder.
