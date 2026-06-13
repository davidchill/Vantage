# Changelog

## v0.2.2 — 2026-06-12

Second efficiency phase — cuts redundant work from the always-on live loop. No user-facing behavior change; the same data is shown, just without the wasted queries each 5s tick.

### Current Tab inspector — cached cookie reads
- The inspector's 5s heartbeat no longer re-runs the cookie queries when nothing changed. Cookie lookups (`summarizeSiteCookies` plus **up to ~25 `chrome.cookies.getAll` calls** for the per-tracker probe) are now cached — first-party cookies keyed by url, tracker cookies keyed by the exact set of tracker domains queried (`current-tab-ui.js`).
- The cache is invalidated precisely when cookies can actually change: **tab switch**, **reload / navigation**, and **clear cookies**. The idle refresh keeps the cache; tab events and clears force a fresh read.
- The tracker counts (ads / trackers / third-parties) still recompute every tick from the probe's growing host list — only the cookie-store lookups are cached — so the card still fills in live as a page loads.

### Extensions inventory — event-driven enumeration
- `collectExtensions()` now caches the built extension list and only re-enumerates (`chrome.management.getAll()`) when an extension is **installed, uninstalled, enabled, or disabled** (`collector.js`). Previously it re-enumerated on every scan — every 5s from the panel and every minute from the worker.
- The cache lives per execution context (service worker and panel each keep/invalidate their own); the list is read-only downstream, so the shared reference is safe. Per-extension permission warnings remain cached by `id@version` on top of this.
- Tradeoff: `chrome.management` has no "updated" event, so a silent version auto-update of another extension may show stale version/warnings until the next install/enable/disable event or a context restart (the MV3 worker recycles on its own; the panel cache clears on close). Minor and bounded for a monitoring tool.

## v0.2.1 — 2026-06-12

Internal cleanup pass — no user-facing behavior change. Removes dead code and wasted work uncovered in a full optimization review, the first of several efficiency phases.

### Removed
- **Write-only summary cache.** The service worker wrote the full analyzed summary to `chrome.storage.session` (`latestSummary`) on every scan and every debounced tab event — a leftover from the old popup architecture that nothing read (the side panel runs its own scan). Removed both writes and the `SESSION_KEY` constant. The toolbar badge still updates from the in-memory summary.
- **Dead stored fields.** Dropped three values that were persisted/transmitted but never read back: `maxBlockingMs` (per-origin history, `perf-store.js`), `lastKinds` (chronic-strain ledger, `strain-history.js`), and `ttfbMs` (probe report payload, `perf-probe.js`). Existing stored records shed these naturally — each record is fully rewritten on its next update.
- **Unused `PERF_REPORT_INTERVAL_MS` constant** — only ever referenced in a comment; the probe hardcodes its own 5s cadence.

### Refactored
- Collapsed the duplicated `scanAfterAutomation()` into `scan({ automate })`. The post-automation corrective re-scan now calls `scan({ automate: false })`, so the strain-ledger update and auto-management still fire exactly once per authoritative scan (never on the re-scan) with no copy-pasted body.

## v0.2.0 — 2026-06-12

Everything new since the initial release: a per-site privacy inspector, opt-in auto-management, long-term strain tracking, an optional AI read of the whole console, and a collapsible UI to keep it all navigable.

### Current Tab inspector
- New **Current Tab** card (`current-tab-ui.js`) showing ads / trackers / third-parties / cookies for the page you're actually looking at — refreshes as you switch tabs, independent of the main scan loop.
- **Tracker classification** (`trackers.js`) — the in-page probe already reports the unique hostnames a page contacted; we match each against a curated ad/analytics/social/consent database (suffix-matched, eTLD+1 aware). Deliberately **does not** use `webRequest` — that's the same broad API Vantage flags as heavy in *other* extensions.
- **Cookie inspector** (`cookies.js`) — first-party cookie summary (count, size, secure/httpOnly/session split, SameSite breakdown) via `chrome.cookies`, plus a per-tracker-domain cookie probe to reveal which trackers actually planted state. One-click **clear cookies** for the active site (confirmed first).
- Adds the `cookies` permission.

### Auto-Management (opt-in)
- Rule-based **auto-sleep / auto-close** of tabs that stay strained too long (`automation.js`, `settings.js`, `automation-ui.js`). Ships **off**; nothing is ever auto-acted until you enable it.
- Adds the missing dimension the analyzer doesn't have — **time**: a tab is acted on only after staying continuously strained for a configurable **sustain window** (default 5 min). Momentary spikes never cost a tab.
- Triggers (each individually toggleable, each `sleep` or `close`): **background CPU drain** and **memory leak**. Every action re-validates live tab state at the moment it acts and never touches active / pinned / audible tabs.
- **Audit log** of every auto-action (what, why, when) in a settings modal, so an auto-close is never a silent disappearance. Strain tracker lives in `storage.session` (resets per browser run); settings + log live in `storage.local`.

### Chronic Strain tracking
- New persistent **per-origin strain ledger** (`strain-history.js`) — the orthogonal axis to the existing per-origin averages: not *how heavy on average* but *how often, and how persistently, a site crosses into strain over time*.
- Each background scan folds that scan's strained origins (jank / background CPU / leak / poor vitals) into the ledger: episode count, current/worst consecutive **streak**, and per-kind tallies. Survives restarts (`storage.local`); self-prunes origins quiet for 30 days.
- New **Chronic Strain** section surfaces repeat offenders (flagged in ≥ 5 scans and still strained within 7 days), sorted by episodes/streak, marking which are open right now. Open chronic sites also feed the health verdict.

### AI Analysis (optional, bring-your-own key)
- New **AI Analysis** card (`ai-analysis.js`, `ai-ui.js`) — on demand, ships the analyzed summary to the Anthropic API and renders Claude's plain-English verdict plus prioritized, severity-ranked suggestions.
- **Bring-your-own API key**, stored only in `storage.local` on this machine; the feature is dormant until a key is added. **On-demand only** (never on the live scan loop, so it never costs money silently).
- Uses **structured outputs** (`output_config.format` + JSON schema) so the reply is always renderable without fragile parsing; defaults to `claude-opus-4-8`, switchable to Sonnet/Haiku in settings. Friendly mapping of API errors (bad key, rate limit, offline) into the card.

### UI
- **Collapsible sections** — every data section's header is now a collapse toggle (rotating caret + item-count badge); collapse state survives the 5s live refresh, alongside the existing expand/sort state.
- **Collapsible AI card** — once a result exists, its header collapses the (tall) analysis so it doesn't crowd out everything below; re-running re-expands automatically.
- Settings modal gains an **AI Analysis** section (API key + model).

### Fixes
- `.ai-card` was missing `flex-shrink: 0`; the growing content area squeezed it and `overflow: hidden` clipped its body to a bare header. Now matches the other out-of-`#content` cards.

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
