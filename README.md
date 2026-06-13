# Vantage

A live **performance console** for Chrome. Vantage runs as an always-on background monitor over your tabs, extensions, cookies/trackers, and the browser's resource usage, then diagnoses what's slowing Chrome down — all in a dark, monospace, instrument-grade side panel.

> **Status:** v0.2.1 — monitoring & diagnosis, a per-site privacy inspector, opt-in rule-based auto-management, long-term strain tracking, and an optional AI analysis. Still pre-1.0 and evolving.

---

## Table of contents

- [Philosophy](#philosophy)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Design decisions & reasoning](#design-decisions--reasoning)
- [Privacy & data](#privacy--data)
- [Permissions](#permissions-and-why)
- [Install (development)](#install-development)
- [Limitations](#limitations--notes)
- [Roadmap](#roadmap)

---

## Philosophy

Chrome's own Task Manager tells you a process is heavy *after* it already is, in numbers most people can't act on. Vantage aims to be the layer above that: it watches continuously, fuses the signals it *can* read into a single read on browser health, and points at the specific tab, site, or extension to do something about — with one click to actually do it.

Two constraints shape everything:

1. **Stable Chrome hides the good numbers.** Extensions can't read per-tab or per-extension CPU/RAM on the stable channel (the `chrome.processes` API is Dev/Canary-only). So Vantage leans on *measured behavioral signals* (main-thread blocking, heap trends) and *structural proxies* (permission breadth, media, idle time) instead of pretending to numbers it can't get.
2. **Cheap enough to always run.** The in-page probe reads the page's own Performance APIs — the same data behind DevTools' Performance tab — without attaching a debugger, so it can run on every tab continuously with no "debugging this tab" banner.

---

## Features

### Chrome Health Score
A single **Good / Strained / Heavy** verdict at the top of the panel, synthesized from every signal (memory pressure, tab count, background CPU drain, memory leaks, live jank, heavy origins, open chronic-strain sites). The top contributing factors are listed so the verdict is explainable, never a black box.

### Tab telemetry
Totals (tabs, windows, sleeping, audible, pinned, muted, loading), **duplicate-tab sets**, **idle tabs** (untouched 60 min+), and **crowded domains** (one site hogging many tabs).

### System gauges
Live **memory** and **CPU** usage. CPU is sampled over a short interval (two readings of the cumulative per-core tick counters) since a single reading is meaningless.

### Page-performance engine
An in-page probe reads each page's **own** Performance APIs — no DevTools banner — and reports compact metrics every 5s:

- **Live jank** — main-thread blocking happening *right now* (Long Tasks over the 50 ms budget).
- **Background CPU drain** — tabs burning CPU while **hidden**. The worst kind of waste: you can't even see it. Held to a lower bar than foreground blocking.
- **Memory-leak trends** — a downsampled per-tab JS-heap series flags steady climbers (e.g. +75 MB over 5 min+).
- **Web Vitals** — LCP (load), INP (interaction latency), CLS (layout shift), plus page load time.
- **Predictions** — a persisted per-origin rolling average ("this site *tends* to be heavy / slow / laggy"), so a known-bad site is flagged the moment you open it, before it misbehaves again.

### Chronic Strain tracking
A persistent **per-origin "repeat offender" ledger** — the time dimension the per-origin averages lack. It answers *how often, and how persistently,* a site crosses into strain, not just how heavy it is on average. Each scan folds the strained origins into a running tally (episode count, current/worst consecutive streak, per-kind breakdown) that survives restarts. The **Chronic Strain** section surfaces sites flagged repeatedly and still misbehaving recently, flagging which are open right now.

### Current Tab inspector
Ads, trackers, third-party domains, and cookies for the page you're actually looking at — refreshed as you switch tabs:

- **Trackers** — the probe reports the unique hostnames a page contacted; each is matched against a curated ad / analytics / social / consent database (eTLD+1 aware, suffix-matched). Notably this uses **no** `webRequest` interception — the same broad API Vantage flags as heavy in other extensions.
- **Cookies** — a first-party cookie summary (count, size, secure / httpOnly / session split, SameSite breakdown) plus a per-tracker-domain probe revealing which trackers have actually planted cookies. **Clear cookies** for the active site in one click.

### Extensions inventory
Every installed extension ranked by **inferred impact** (permission breadth — broad host access and heavy always-on APIs like `webRequest`/`declarativeNetRequest` rank highest), with icon, version, install source (flags **sideloaded**, **dev**, **policy-forced**), and the full plain-English permission warnings.

### Deep profiler
On-demand **real** metrics for a single tab — JS heap (used/total), DOM nodes, event listeners, frames, script/layout time — via the DevTools protocol (`chrome.debugger` → `Performance.getMetrics`). This briefly flashes Chrome's "debugging this tab" banner, by design: it's the one place you get ground-truth per-tab figures.

### Auto-Management (opt-in, ships OFF)
Rule-based **auto-sleep / auto-close** of tabs that stay strained too long. The detection is already done by the analyzer; this adds **time** — a tab is acted on only after staying continuously strained for a configurable **sustain window** (default 5 min), so a momentary spike never costs you a tab. Triggers (**background CPU drain**, **memory leak**) are individually toggleable and each maps to `sleep` (reversible) or `close`. Every action re-checks live tab state at the moment it fires and refuses to touch tabs you're using (active / pinned / audible). An **audit log** records every action and why.

### AI Analysis (optional, bring-your-own key)
On demand, Vantage ships the analyzed summary to the Anthropic API and renders Claude's plain-English verdict plus a prioritized, severity-ranked list of suggestions that name the actual tabs, sites, and extensions to act on. Off until you add an API key; **on-demand only**, never on the live loop.

### Cleanup actions
Per-tab **sleep** (`tabs.discard`) and **close**, plus bulk **sleep all idle** and **purge duplicates** sweeps. Destructive actions confirm first.

### The UI
A **dark, monospace, "observability console"** side panel: command-bar header with a live indicator, health-verdict hero, hairline metric cluster, segmented telemetry bars, and log-style sections. Every row **expands** to a detail block; every section and the AI card **collapse** to keep a data-dense panel navigable. Expand / collapse / sort state all survive the 5s live refresh. Blueprint-grid atmosphere, motion confined to the shell so the refresh never flickers, and `prefers-reduced-motion` honored.

---

## Tech stack

- **Manifest V3** Chrome extension — background **service worker** (ES module), a **content-script** probe, and a **side-panel** UI.
- **Vanilla JavaScript (ES modules), no build step, no dependencies.** Source files load directly as `type: "module"`; there is nothing to compile or bundle. `package.json` exists only for metadata.
- **Chrome platform APIs:** `tabs`, `tabGroups`, `system.memory`, `system.cpu`, `storage` (`session` + `local`), `alarms`, `sidePanel`, `management`, `debugger`, `cookies`.
- **Web Performance APIs** (in the page): `PerformanceObserver` (longtask, largest-contentful-paint, layout-shift, event), `performance.memory`, resource & navigation timing.
- **Anthropic API** (optional) — called directly from the extension via `fetch` with structured outputs; no SDK, no backend.
- Storage-only persistence (no server); system monospace font stack (Cascadia Code / JetBrains Mono / SF Mono), no bundled assets.

---

## Architecture

The logic is split so every surface renders from one source of truth — the object `analyze()` returns.

```
manifest.json                 MV3 config & permissions
src/
  core/                       the "monitoring brain" — surface-agnostic, no DOM
    collector.js              reads tabs / groups / memory / extensions / perf into one snapshot
    analyzer.js               snapshot → structured, UI-ready summary (the brain)
    health.js                 synthesizes the Good / Strained / Heavy verdict
    constants.js              every threshold & storage key (single source of tuning)
    perf-store.js             live per-tab + rolling per-origin performance history
    strain-history.js         persistent per-origin chronic-strain ledger (over time)
    trackers.js               hostname → ad/tracker classification (curated DB, eTLD+1)
    cookies.js                first-party + tracker cookie inspection / clearing
    settings.js               auto-management + AI config (storage.local)
    automation.js             rule-based sustained-strain sleep/close + audit log
    actions.js                sleep / close tab operations
    ai-analysis.js            builds the prompt, calls the Anthropic API, parses the reply
  background/
    service-worker.js         periodic + event-driven scans, badge, perf intake,
                              strain recording, automation, deep profiler
  content/
    perf-probe.js             in-page Performance-API probe (Long Tasks, Web Vitals, hosts)
  ui/
    panel/                    panel.html + panel.js, plus self-contained cards:
                              automation-ui.js, current-tab-ui.js, ai-ui.js
    shared/                   summary-view.js (rendering) + summary.css (theme)
```

**Data flow:** the content-script probe reports per-tab metrics → the service worker folds them into live + per-origin + strain stores → on each scan `collectSnapshot()` gathers Chrome state + the perf stores → `analyze()` turns it into a summary → the panel renders it and re-renders live every 5s. Automation and AI both consume that same summary.

**Two storage tiers, on purpose:** `storage.session` holds within-a-browser-run state (live per-tab metrics, the automation strain timer) that *should* reset each run; `storage.local` holds things that should persist across restarts (per-origin history, the chronic-strain ledger, settings, the audit log).

---

## Design decisions & reasoning

The interesting choices and *why* they went the way they did:

- **Behavioral proxies over fake precision.** Stable Chrome won't give extensions per-tab CPU/RAM, so rather than display a number we can't actually measure, Vantage ranks "likely heavy" from signals it *can* read (measured main-thread blocking first, then media/idle/crowding) and labels extensions by permission breadth. The deep profiler is the explicit escape hatch when you want true figures and accept the debug banner.
- **A passive probe, not a debugger.** Reading the page's own Performance APIs from a content script is cheap enough to run on every tab forever and shows no banner. Attaching `chrome.debugger` to every tab would be heavyweight and alarming — so that's reserved for explicit, one-tab deep profiling.
- **Per-origin *history* vs per-origin *strain* are different questions.** The rolling EMA answers "how heavy is this site on average" (→ predictions). The strain ledger answers "how often / how persistently does it cross the line" (→ chronic offenders). Keeping them separate avoids smearing a site that's occasionally terrible into a site that's mildly heavy all the time.
- **Automation gates on *time*, and ships off.** Detection is instantaneous, but acting on a momentary spike would be hostile, so automation waits for a continuous sustain window and re-validates live state before touching anything — and never auto-runs until you opt in. Sleep is preferred over close; the audit log means nothing disappears silently.
- **The tracker inspector refuses `webRequest`.** It would be ironic for a tool that flags `webRequest`-using extensions as heavy to use `webRequest` itself. Instead it classifies the hostnames the probe already collected against a curated database — lighter, and honest to the tool's own thesis.
- **AI is opt-in, bring-your-own-key, and on-demand.** Vantage is otherwise fully local and free. The one feature that leaves the machine requires *your* Anthropic key (stored only locally), never fires automatically (so it can't bill you silently), and only sends the already-analyzed summary — not raw page content. **Structured outputs** constrain the reply to a small JSON schema so rendering never depends on fragile text parsing, and it defaults to the most capable model with cheaper options a click away.
- **One source of truth, collapsible everywhere.** All surfaces render from `analyze()`'s output, so the popup/panel/automation/AI never disagree. As the data grew dense, every section and the AI card became collapsible (with state that survives the live refresh) so the panel stays navigable instead of becoming a wall.

---

## Privacy & data

- **Everything is local by default.** All monitoring, history, and the strain ledger live in `chrome.storage` on your machine; nothing is sent anywhere.
- **The one exception is AI Analysis**, and only when you click *Run analysis*. It sends the analyzed summary — which includes tab titles, site origins, and metrics — to the Anthropic API under **your** API key. No page contents or keystrokes are sent. The key is stored only in `storage.local` on this device.
- **Cookie/tracker inspection is read-only** unless you press *clear cookies*, which deletes that site's cookies after a confirmation.

---

## Permissions (and why)

| Permission | Why |
| --- | --- |
| `tabs`, `tabGroups` | Read tab/group state — the core of monitoring and the cleanup actions. |
| `system.memory`, `system.cpu` | The memory and CPU gauges. |
| `storage` | Persist history, the strain ledger, settings, and the audit log. |
| `alarms` | Drive the once-a-minute background scan. |
| `sidePanel` | The panel UI, toggled from the toolbar icon. |
| `management` | The extensions inventory (and the permission-warning text). |
| `debugger` | The opt-in deep profiler only (true per-tab metrics). |
| `cookies` | The Current-Tab cookie inspector and *clear cookies*. |
| `host_permissions: http/https` | Inject the performance probe into pages and read resource hostnames. |

---

## Install (development)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this project folder.
4. Pin **Vantage** to the toolbar and click the icon to toggle the panel.

Requires **Chrome 121+**. Page-performance data appears as you browse (the probe injects into pages loaded after install); predictions and chronic-strain history build up over time. To enable AI Analysis, open settings (⚙) and paste an Anthropic API key.

---

## Limitations & notes

- Stable Chrome does not expose per-tab or per-extension CPU/RAM to extensions; Vantage uses system-level resources plus behavioral heuristics and permission breadth as proxies. The deep profiler is the one source of true per-tab figures.
- `performance.memory` is coarse (Chrome quantizes it); treat live per-tab heap as a relative signal, not an exact byte count.
- Content scripts can't run on `chrome://` pages, the Web Store, or the PDF viewer; those tabs show metadata only.
- The tracker database is a curated, representative list — enough to answer "what's tracking me here," not an exhaustive blocklist.
- AI Analysis is metered by Anthropic and billed to your key; one analysis is a fraction of a cent to a few cents depending on the model.
- Uses the system monospace stack; no bundled font. No custom toolbar icon yet — Chrome shows a default placeholder.

---

## Roadmap

| Version | Focus |
| ------- | ----- |
| 0.1.0 | Monitoring, diagnosis, cleanup actions, console UI (initial release). |
| 0.2.0 | Current-Tab inspector, auto-management, chronic-strain tracking, AI analysis, collapsible UI (this release). |
| Later | Cross-session persistence for UI state, a chronic-strain automation trigger, extension enable/disable, a custom toolbar icon, optional inner-scroll cap on long AI results. |
