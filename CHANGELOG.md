# Changelog

## v0.5.0 — 2026-10-28

New capability: **Tab CPU — every tab's real load, background tabs included.** This is the first release tested in real Chrome with the extension loaded: Chrome 156, headless, a throwaway profile separate from the user's browser, the unpacked extension loaded over the DevTools pipe (`Extensions.loadUnpacked`). That answered the questions v0.3.0 left open and exposed a blind spot:

- **Script attribution works.** The content-script probe receives Long Animation Frame entries, and it attributed a cross-origin script served without CORS headers (like a typical ad tag) to its host.
- **Chrome tells a page nothing about work done while it's hidden.** A background tab whose timers kept it 12% busy produced no `longtask` and no `long-animation-frame` entries — in the page's own main world too — and none were delivered when it came back to the front. So the probe's background-drain signal (`blockingHiddenMs`) can't fire in current Chrome, and Page Performance read "all clear" while a background tab was burning CPU.
- **Chrome caps hidden tabs' timers.** A hidden tab's timers ran at full speed for roughly 10–20s, then were budget-throttled to about 1% CPU. Work that isn't timer-driven — media, network replies, messages, workers — isn't capped this way.
- **The deep profiler's counter sees hidden tabs exactly.** `TaskDuration` matched a hidden tab's real work in every window (12% → 1.2% → 0%), making the profiler's two-reading method the right tool for background tabs.

The planned cross-tab LoAF view (roadmap 0.4.x) could only ever have covered on-screen time, so this replaces it.

Verified with 35 new harness checks (138 in all, earlier suites unchanged) against a scripted `chrome.debugger` — a hung tab, a refused attach, an attach that lands late, a minimized window, overlapping clicks, the tab cap — and end-to-end in real Chrome: a background tab kept awake by network replies read **29.8%** and was flagged, a background timer-driven tab read 0% (throttled), the on-screen tab 0.1%, a hung tab was skipped as unresponsive with the whole sweep done in 5.0s, a second click mid-sweep was refused, no tab was left attached, and System Status read "1 background tab using CPU".

### Tab CPU sweep (`service-worker.js`)
- **`measure-all`** → `measureAllTabs()` reads every loaded `http(s)` tab — asleep tabs and Chrome's own pages are left out — up to `CPU_SWEEP_MAX_TABS` (40), on-screen and audible tabs first, then the most recently used. Each tab is attached, read, given its 3s window, read again, all side by side: a sweep costs one window however many tabs are open, and a slow tab never stretches another's window. Everything attached is detached in `finally`.
- **Background** means not its window's showing tab, or its window is minimized (`chrome.windows.getAll`) — when Chrome treats the page as hidden.
- **A deadline on every DevTools call** (`withTimeout`, 5s). A hung page's main thread never answers; it's reported "page unresponsive" rather than stalling the sweep. An attach that completes after its deadline is detached as soon as it lands, so no debugging banner is left behind.
- **One measurement at a time.** The deep profiler is now a one-tab sweep through the same `sampleTabs()`, which refuses a second run while one holds the debugger ("another measurement is still running") — Chrome allows one attach per tab.
- The result is saved to `storage.session` (`CPU_SWEEP_KEY`) and a badge refresh is scheduled.

### Analyzer & health
- The collector reads the latest sweep; `measuredCpu()` joins it to the tabs still open. Tabs closed, put to sleep, or moved to another origin since are dropped (their reading no longer describes them); titles come from the live tab; rows are busiest first, with detail stats and plain-language notes.
- **Flags:** 25%+ busy (`CPU_BUSY_WARN_PCT`) for any tab; 5%+ (`CPU_BG_WARN_PCT`) for a background tab, since Chrome throttles hidden tabs to about 1% — except tabs playing audio, where background work is expected.
- **Health:** a fresh sweep's flagged background tabs feed the existing "background tab using CPU" factor, counted once per tab if the probe also reported it. After `CPU_SWEEP_STALE_MIN` (10 min) a sweep is shown as stale and stops counting.

### Panel
- **Tab CPU section** above Page Performance. A **measure** button that's always there, even before the first sweep (`section()` gained `slotWhenEmpty`); a note like "5 tabs · 2m ago · 1 skipped" with skip reasons on hover; rows at 1%+ busiest first, 🌙 for background, 🔊 for audio, the ad-frame count, a warning highlight when flagged and fresh, and ⌖ / ⏾ / ✕. Expanding a row shows the busy % and load word, what the time went to, heap, DOM nodes, listeners, frames (ads), layouts, tab state, when measured, and notes ("Busy in the background…", layout-heavy, ad frames not counted). Shows "measuring…" while a sweep runs; a profile and a sweep can't overlap.
- **Detail layout fix (every section):** the key/value grid used `1fr 1fr`, so a long value pushed its column past half the panel and was cut off. Columns are now `minmax(0, 1fr)` and values wrap. Explanatory sentences get a new wrapping `notes` block; the one-line `bullets` list stays for titles and sources.

### Async JavaScript isn't "script" to Chrome
- Tested in real Chrome: the same 50% load read `ScriptDuration` 50% when run in a timer callback but **0%** after an `await` or in `.then` (`TaskDuration` 50% both). So "other" in the busy-time breakdown is often mostly async script. When "other" outweighs script, the deep-profile card and Tab CPU details say why. The shared formatters (`loadWord`, `fmtPct`, `busyMix`, `mostlyUnlabelled`) moved to `profile.js`.

### AI Analysis
- The snapshot gains `measuredCpu` (fresh sweeps only): the busiest tabs with busy %, script / other / layout+style, background, audio, ad frames, and heap. The system prompt calls it ground truth that outranks the heavyTabs estimate, flags background tabs over ~5%, and explains that `otherPct` is mostly async script.

### Help text
- New Tab CPU ⓘ. The Page Performance ⓘ now says 🌙 rows rarely appear in current Chrome and points to measure; the System Status tooltip mentions measured background tabs; the service worker's header comment no longer describes a popup cache.

### Known gap
- Background-drain detection from the probe is kept, since browsers on older Chromium may still report hidden-tab long tasks — but in current Chrome it doesn't fire, and neither does auto-management's **background CPU drain** trigger, which depends on it. The memory-leak trigger is unaffected.

## v0.4.0 — 2026-10-28

New capability: **real per-tab load from the deep profiler.** Stable Chrome gives extensions no per-tab CPU figure, and until now the ⌖ deep profile read Chrome's DevTools Performance counters once — so "Xs total script" meant work done since the page loaded, not how busy the tab is now. It now takes two readings a few seconds apart and reports the rate: how much of that window the tab's main thread spent busy, and on what.

Counters were chosen by testing, not by name. Against headless Chrome 156 (a throwaway profile, separate from the user's browser), a page built to keep its main thread 50% busy read **49.9%** from `TaskDuration` and 49.6% from `ScriptDuration`. `ThreadTime` and `ProcessTime` read 70% and 45% on the same page, so despite their names they aren't used as a "CPU %". End-to-end, the real service-worker code driven against real Chrome (through a `chrome.debugger` → CDP shim) measured a designed-50% page at **50.1%**, a layout-thrashing page at exactly its designed 9,000 layouts in 3s, and an idle page at 0%.

### Profiler (`service-worker.js`, new `src/core/profile.js`)
- **Two-sample measurement.** `deepProfile()` attaches the debugger, enables the Performance domain, reads `Performance.getMetrics`, waits `DEEP_PROFILE_SAMPLE_MS` (3s), reads again, and detaches (always, in `finally`). It also returns the tab's title.
- **`summarizeProfile(before, after)`** (pure, testable): over the `Timestamp` window, returns main-thread busy % (`TaskDuration`) and its breakdown — script (`ScriptDuration`), layout (`LayoutDuration`), style (`RecalcStyleDuration`), and other — plus layouts in the window, and point-in-time JS heap, DOM nodes, listeners, frames, and **ad frames** (`AdSubframes`: iframes Chrome itself has tagged as ads). Missing counters come back as `null` so the UI hides them; a zero-length window can't divide by zero.
- Replaced the old one-shot fields (`scriptSeconds`, `taskSeconds`, cumulative `layoutCount`, `documents`) with the windowed ones.

### Panel
- **Result card** leads with the load — e.g. "**62%** main-thread busy (heavy) over 3s — script 48% · layout 9.1% · other 4.7%" — amber at 50%+, with a plain word (idle / light / moderate / heavy) and components under 1% hidden. A second line has heap, DOM nodes, listeners, frames (with Chrome-tagged ads), and layouts; the tab's title (escaped) heads the card; a note says the figure is the tab's renderer main thread, which same-site tabs sharing a process can add to.
- **⌖ on Page Performance rows** (janky, background-drain, memory-growth) as well as Likely Heavy Tabs, so an estimate can be confirmed with a measurement on the spot (`heavyActions` → `profileActions`).
- **One profile at a time**: a second click mid-sample is ignored rather than failing to attach. The waiting message says how long it takes and that Chrome shows its "debugging this tab" banner meanwhile.

### Help text
- Likely Heavy Tabs and Page Performance explainers describe what ⌖ measures and that it shows the debug banner while it does.

## v0.3.0 — 2026-10-28

New feature: **script attribution**. Until now Vantage could say a page was janky but not *what* on it was responsible. Using Chrome's Long Animation Frames API (LoAF, Chrome 123+), the probe now records which script sources run in slow frames, so Vantage can name the domain — often an ad or analytics network — behind a page's main-thread cost and behind a specific janky moment.

The original plan was to use LoAF to measure each **extension's** cost. That isn't possible: Chrome's documentation states that "extension code running in an isolated world won't have script attribution in long animation frames", and most extension content scripts run in an isolated world. The feature is built around third-party script attribution instead; an extension shows up only if it injects a script into the page's own world. Extension impact in the Extensions section is still inferred from permission breadth.

Verified with scratch Node harnesses against a stubbed `chrome` API (27 new checks, 93 in all, earlier suites unchanged). **Not yet verified in real Chrome:** a check in the desktop app's embedded browser saw Long Tasks fire but no LoAF entries while its pane was hidden, which suggests LoAF may only report for tabs that are on screen. That is unconfirmed, and whether the extension's isolated-world probe receives LoAF entries also needs a real-Chrome test.

### Probe (`perf-probe.js`)
- **LoAF observer**, only where supported (`PerformanceObserver.supportedEntryTypes`): observing an unknown entry type logs a console warning in every page on Chrome 121–122, which an extension shouldn't add to sites. Each report now carries `loaf: true|false`.
- **Per-source script cost.** For every long frame, each script entry (Chrome itemizes those over 5 ms) adds its `duration` and `forcedStyleAndLayoutDuration` to its source: the hostname of `sourceURL`, `ext:<id>` for a `chrome-extension://` script, or `""` when Chrome gives no URL (inline handlers, eval). Totals are kept over the page's life (`scripts`, top 15 sent) and for the current reporting window (`scriptsWindow`, top 5, reset with each report), so a janky window is blamed on what ran in it rather than on what ran at page load. At most 100 distinct sources are tracked per page.

### Attribution core (`src/core/script-cost.js`, new)
- `analyzeScriptCost(scripts, pageUrl, extNames)` groups sources by registrable domain and labels each **this site**, a known tracker (**Ads / Analytics / Social / Trackers**, via the existing `trackers.js` database), **3rd-party**, **extension** (by name), or **inline / unknown**; returns heaviest-first sources plus total, this-site, and third-party milliseconds.
- `topCulprit(...)` names a source only when it clearly stands out: at least `CULPRIT_MIN_MS` (50 ms) and not inline/unknown code — naming a smaller second source then would mislead.
- Shared helpers `sourceTag`, `describeSource` ("doubleclick.net (Ads)"), and `fmtMs` are used by the analyzer, the panel, and the AI snapshot alike; the Current Tab card's private copies were removed.

### Current Tab inspector
- **Main-thread JS line** under the readouts — e.g. "main-thread JS 1.8s · 3rd-party 1.4s (79%)", amber when third parties account for half or more. Says "no slow frames yet" or "needs Chrome 123+" when there's nothing to show. A fifth readout tile was considered but would overflow the side panel's existing labels.
- **"Main-thread time by source"** list at the top of the expanded detail: up to 10 sources with tags, run time, and forced layout time when it's 50 ms or more.

### Page Performance & tab details
- **Culprits on janky and background rows**: `⚠ 900ms · doubleclick.net` / `bg-cpu 400ms · <source>`, from the latest window. The name is ellipsized at a fixed width with the full description on hover, and replaces the heap figure in the row meta when present (the heap stays in the detail). Expanding a row lists the window's top three sources.
- **"top script"** in every tab's detail block — the page-life leader, e.g. `site1.test (this site) · 4.0s` — which also explains *why* a heavy tab ranks high.
- `analyze()` builds an extension id → name map from the snapshot so injected extension scripts are named; heavy-tab rows gain `topScript`, perf rows gain `culprit` and `bullets`.

### AI Analysis
- The snapshot now includes `culprit` on janking and background-drain tabs and `topScript` on heavy tabs (omitted when nothing stands out), and the system prompt asks Claude to name them as the likely cause.

### Help text
- Current Tab tooltip and ⓘ explain the new line and list, and state the limits plainly: Chrome credits the script that *started* the work, skips scripts under 5 ms, and never shows extension content scripts or cross-origin iframes. The Page Performance ⓘ explains the culprit name on rows.

## v0.2.6 — 2026-10-28

An accuracy pass, driven by a full diagnostics review of the extension. The aim: what Vantage reports as slowing Chrome down should be **measured, current, and attributable** — not inflated by its own bookkeeping, distorted by Chrome's background throttling, or blind to tabs it never instrumented. Fixes 14 issues across the health verdict, memory signals, background-tab detection, tab-closing safety, and the worker's plumbing. Every fix was checked with scratch Node harnesses that load the real modules against a stubbed `chrome` API (66 checks), and each harness was also run against v0.2.5 to confirm it catches the old behavior.

### Health verdict & chronic strain
- **Strain is recorded on the alarm cadence only.** Debounced tab-event scans called `scan()` with `automate` defaulting to `true`, so the chronic-strain ledger and auto-management ran on every tab-event burst — a site could reach "chronic" (5 strained scans) in ~30s of tab switching, flipping the verdict to Strained. Event-driven scans are now badge-only (`scan({ automate: false })`); episode counts track elapsed time, not activity.
- **Only measured strain feeds the ledger.** `strainedOriginsFrom` no longer folds history-based predictions (heavy / poor vitals) into the ledger. They were re-recorded every minute for any open — even asleep — tab of a once-bad site, so the ledger fed on its own past verdicts. Live jank, background drain, and memory growth remain; the `vitals` ledger kind is retired.
- **Asleep tabs don't count.** Predictions and the chronic "open now" set skip discarded tabs, matching the explainer's "loaded this instant". Sleeping a tab now actually clears its contribution to the verdict.
- **Fresh ledger.** Ledgers recorded by earlier versions were inflated, so the ledger moves to a new storage key (`strainLedger`); the old `strainHistory` key is removed on install/update (idempotent).
- **Scan alarm re-checked on every worker start** (`ensureAlarm`). Chrome may clear alarms on browser restart, and the alarm is now the sole driver of the ledger and automation.

### Web Vitals
- **CLS measured per Core Web Vitals** — the worst session window (shifts grouped until a 1s gap or 5s total) instead of the sum of every shift over the page's life, which grew without bound on long-lived tabs (`perf-probe.js`).
- **Per-origin history keeps a rolling `avgCls`** (EMA, 3 decimals) instead of an all-time `maxCls` that never decayed and permanently flagged a site for "layout shift" (`perf-store.js`; `ema()` gained a `digits` parameter). Stored `maxCls` values are ignored and dropped on each origin's next update.

### Memory signals
- **Heap series scoped to one document.** A tab's series resets on navigation or reload (new `sender.documentId`) or an origin change. Previously navigating a tab to a heavier site read as "+260 MB growth" — a false leak that, with the leak trigger set to *close*, could auto-close the tab.
- **Prerendered and tearing-down documents ignored.** Reports whose `sender.documentLifecycle` isn't `active` are dropped, so Chrome's prerendered pages no longer mix their numbers into the tab or show the foreground tab as background drain.
- **Floor-based leak detection.** Growth now compares the heap's low point (minimum of `LEAK_FLOOR_SAMPLES` = 5 samples) at each end of the series rather than two single readings, so GC sawtooth can't fake or hide a climb. Sampled about once a minute, 40 samples retained; flagged at ≥75 MB of floor growth over ≥10 min (`LEAK_MIN_SPAN_MIN`).
- Confirmed by testing in desktop Chrome that `performance.memory` is precise and live (a review hypothesis that it refreshes only every ~20 minutes was disproved), so the leak cadence is tuned for precise-but-noisy readings.

### Background tabs
- **Throttling-aware blocking.** The probe now reports each window's length (`windowMs`), and `perf-store` normalizes blocking to a per-5s rate (`PERF_WINDOW_MS`). Chrome throttles long-hidden tabs to about one timer wake-up a minute, so a single 200ms task a minute used to count as "background tab using CPU" (severity 3), and per-origin averages mixed 5s and 60s windows. Normalization only scales *down* — a short window (the early report sent as a tab is hidden) isn't amplified.
- **Longer staleness allowance for hidden tabs** (`PERF_HIDDEN_STALE_MS`, 3 min vs 60s). Once-a-minute reports no longer drop a draining tab out of the list — which also reset automation's sustain clock, so auto-sleep could never fire. An asleep tab's last report is ignored immediately (perf advisories and the JS HEAP gauge).
- **Probe injected into already-open tabs on install/update** via `chrome.scripting.executeScript` (new **`scripting`** permission — no install warning; host access was already granted). Previously every open tab went unmeasured until reloaded, including after each update. Asleep tabs and Chrome's own updates are skipped; unscriptable pages fail quietly.
- **Probe lifecycle.** Observers are created through a `watch()` helper and tracked; `stop()` disconnects them, clears the timer, and removes the visibility listener. A newly injected probe stops any earlier copy on the page (`window.__vantageProbe`, in the isolated world only), and an invalidated context now shuts down fully (it used to leave its visibility listener behind).

### Likely Heavy Tabs
- **Score includes measured JS heap and DOM size** (`HEAVY_HEAP_MB` 500, `HEAVY_DOM_NODES` 15,000), with new row reasons *high memory* and *k DOM nodes*. A 1.5 GB tab previously scored the same as a blank page (10) and ranked below a small pinned tab playing music (32). Live jank remains the strongest single signal.
- **Sorts re-rank every loaded tab.** `analyze()` returns every loaded tab (score order) and the panel picks the top 8 *after* the user's sort (`topFor()`), so cpu/memory sorts surface the true heaviest tab; a `pick` option keeps "name" listing the heaviest 8 alphabetically. Detail rows are now built for every loaded tab, partly reversing the v0.2.3 deferral (negligible cost; the AI snapshot still takes the top 8 by score).

### Duplicate tabs
- **Exact address matching.** Only the scheme and host are lowercased; path, query, and `#fragment` are kept exactly. Gmail's `#inbox` vs `#inbox/<message>` (or a compose window) and case-differing video IDs are no longer "duplicates" that *purge dupes* would close.
- **Purge protects pinned and audible tabs.** `closeExtras` keeps the best copy (pinned › active › audible › most recent) and never closes pinned or audible copies. Confirmation prompts and the section explainer say so.

### Toolbar badge
- **Colour follows the health verdict** — blue Good, amber Strained (dark text), red Heavy — and the icon's tooltip shows the verdict and its top factors. It used to turn red whenever any idle (even asleep) or duplicate tab existed, and never reflected real strain. Removed the now-unused `issues` field from `analyze()`.

### Service worker plumbing
- **Tab events filtered.** Only changes that can move the badge trigger a scan: tab created/removed, navigation (`url`), load complete, sleep/wake (`discarded`). Title, favicon, and audio updates and tab switches are ignored — a page retitling itself every second used to cause a full scan every second.
- **Single write queue.** Every storage read-modify-write in the worker — perf flushes, closed-tab cleanup, and whole scans (strain ledger, automation tracker) — runs through one promise queue (`enqueue`), fixing lost updates when a tab closed mid-flush or two scans overlapped. The post-automation re-scan calls `runScan` directly, since it already holds the queue.

### Help text
- Explainers updated for the new behavior: memory growth (10+ min), chronic 🔁 (closed *or* asleep), exact duplicate matching and protected copies, and the heavy-tab signals and sorting.

## v0.2.5 — 2026-06-13

A quality-of-life release: in-context help layered over the whole panel, plus clearer and more honest resource gauges. No change to the monitoring engine — this is about making the data already on screen easier to read and harder to misread.

### In-context help (new)
- **Hover tooltips on telemetry items.** The metric cluster readouts (tabs, windows, sleeping, audio, dupe sets, idle, chronic), the gauges, the **System Status** verdict, and the **Current Tab** readouts (ads / trackers / 3rd-party / cookies) each carry a one-line explanation shown on hover or keyboard focus. Positioning is done in JS and clamped to the viewport so tooltips never clip off the narrow side panel, and flips above/below as room allows.
- **Per-section "ⓘ" explainers.** Every section header — Page Performance, Chronic Strain, Likely Heavy Tabs, Duplicate Tabs, Idle Tabs, Crowded Domains, Extensions, and the Current Tab card — gets a small info button that pops a card explaining *what the section is* and *how to read its rows* (e.g. that "Likely Heavy Tabs" is a heuristic estimate, what "blocking ms" means, why chronic strain differs from live perf).
- **New shared modules.** `explainers.js` holds all the help copy in one place; `info-layer.js` is the floating controller for both the tooltip and the pop-up. The layer is appended to `<body>`, **not** into `#content`, so the 5s live re-render never wipes it mid-read — the same reason `deep-result` / `ai-card` live outside `#content`. Hover uses document-level event delegation so it keeps working across re-renders; the pop-up floats independently once opened and isn't tied to the header button (which gets replaced on the next scan). Keyboard-accessible (focus shows tooltips, Esc closes the pop-up) and CSP-safe (no inline handlers; the pop-up renders only trusted static strings).

### Gauges — system vs. Chrome
- **`MEM` / `CPU` relabeled `SYS MEM` / `SYS CPU`.** These read `chrome.system.memory` and `chrome.system.cpu`, which report **whole-machine** totals across every process — not Chrome's slice. The labels (and their tooltips) now say so explicitly, so the numbers can't be mistaken for Chrome's footprint. Widened the gauge label column to fit.
- **New `JS HEAP` gauge.** Sums the per-renderer JS heap the in-page probe already reports (`usedJSHeapSize`) across tabs with a fresh reading, shown as a share of system RAM so it sits on the same scale as `SYS MEM`. This is the one **Chrome-attributable** memory figure obtainable without attaching the debugger. It's hidden until the probe has reported (no misleading hollow `0`), and its tooltip is explicit that it's **partial** — JS-heap only, excludes the browser/GPU processes and non-JS memory, and same-origin tabs sharing a renderer can be double-counted. Added a `chromeHeap` field (`{ mb, tabs, pct }`) to the `analyze()` summary; computed in the existing per-tab perf loop so it costs nothing extra.

## v0.2.4 — 2026-06-12

Fourth efficiency phase — cuts Vantage's own runtime footprint, especially the in-page probe that runs in every tab. A performance monitor should be featherweight in the pages it watches; this makes it markedly lighter. The probe's report contract (a compact payload every 5s) is unchanged, so nothing downstream had to change. Verified the batched store writer against a stubbed `chrome.storage` (correct live/history folding, EMA, heap series, opaque-origin skip, single write per batch).

### Probe (per-tab cost)
- **Resource timing accumulated incrementally.** A `resource` `PerformanceObserver` now tallies request count, transferred bytes, and contacted hosts as entries arrive, instead of re-scanning the whole (ever-growing) resource buffer on every 5s report (`perf-probe.js`). On a busy SPA that buffer holds thousands of entries; re-walking it each tick is gone.
  - Side benefit — **higher fidelity for the Current Tab inspector**: the host list is now cumulative over the page's life, so it catches trackers that loaded early even after the browser's ~250-entry resource buffer rotates (the old `getEntriesByType` scan silently missed those). Request count and transfer size become cumulative totals for the same reason.
- **DOM-node count throttled.** The full-tree `getElementsByTagName("*")` walk now samples ~every 30s and only while the tab is visible (it can't visibly change while hidden), reporting the last value in between. A never-seen background tab reports no node count rather than being walked.
- Navigation-timing load duration is read once and cached rather than re-read every report.

### Service worker (storage I/O)
- **Batched perf-report writes.** Reports from many tabs arrive staggered; the worker now buffers them and folds the whole batch into storage in one read-modify-write per store (1.5s debounce, early flush on bursts), replacing the per-message write chain (`service-worker.js`, `perf-store.js`). Storage ops drop from O(reports) to O(flush intervals).

### Panel (render path)
- **CPU sample cached (~15s).** Sampling system CPU costs a forced ~300ms (two tick-counter reads an interval apart); the panel no longer pays that on every 5s render, reusing the cached value between samples (`summary-view.js`). The machine-wide CPU gauge now updates ~every 15s.

## v0.2.3 — 2026-06-12

Third efficiency phase — tightens the analyzer (`analyze()`, the per-scan "brain"). No behavior change; the summary it returns is identical, verified by running `analyze()` against a synthetic snapshot and asserting on every section (health, duplicates, heavy tabs, background drain, leaks, predictions, chronic strain, extension classification).

### Analyzer
- **Detail rows built only for the tabs shown.** "Likely heavy tabs" scored every tab and built its full `tabStats` key/value detail, then kept only the top 8. Now it scores cheaply, slices to 8, and builds the detail rows for just those 8 — the rest are never materialized.
- **Each tab's URL parsed once.** The module-level `hostOf` / `originOf` helpers (two `new URL()` calls each, recomputed across the main loop, the heavy-tab pass, predictions, and the open-origins pass) are replaced by a single per-scan memoized `metaOf(raw) → { host, origin }`. Identical fallbacks (`"(local)"` host, `null` origin), keyed by the same raw url strings, so repeat passes hit the cache instead of re-parsing.

### UI
- Deduplicated the `readout()` helper — `summary-view.js` now exports it and `current-tab-ui.js` imports it instead of carrying its own copy.

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
