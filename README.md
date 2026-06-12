# Vantage

A live **performance console** for Chrome. Vantage runs as a background monitor over your tabs, extensions, and the browser's resource usage, then diagnoses what's slowing Chrome down — all in a dark, monospace, instrument-grade side panel.

> **Status:** v0.1.0 — initial release. Read-only monitoring & diagnosis, plus manual tab cleanup.

## What it does

- **Health verdict** — a single **Good / Strained / Heavy** score at the top of the panel, with the biggest contributing factors called out.
- **Tab telemetry** — total/sleeping/audible tabs, duplicates, idle tabs (60m+), and crowded domains.
- **System gauges** — live memory and CPU usage.
- **Page performance** — using each page's own Performance APIs (no DevTools banner), Vantage flags:
  - **Background CPU drain** — tabs burning CPU while hidden (the worst kind).
  - **Live jank** — tabs blocking the main thread right now.
  - **Memory leaks** — tabs whose JS heap keeps climbing over time.
  - **Predictions** — "this site tends to be heavy / slow / laggy," from per-origin history (Web Vitals: LCP, INP, CLS, load).
- **Extensions inventory** — every extension ranked by access breadth, with install source (sideloaded / dev / policy), version, and its full plain-English permission warnings.
- **Deep profiler** — on-demand real heap/CPU/DOM metrics for any tab via the DevTools protocol.
- **Cleanup actions** — sleep or close any tab, plus "sleep all idle" and "purge duplicates" sweeps.
- **Collapsible detail** — click any row to expand full stats for that item.

## How it works

The logic is split so each surface renders from one source of truth:

```
manifest.json              MV3 config & permissions
src/
  core/                    the "monitoring brain" — surface-agnostic
    collector.js           reads tabs / groups / memory / CPU / extensions / perf
    analyzer.js            snapshot → structured, UI-ready summary
    health.js              synthesizes the Good/Strained/Heavy verdict
    perf-store.js          live + per-origin performance history
    actions.js             sleep / close tab operations
    constants.js           thresholds
  background/
    service-worker.js      periodic scans, badge, perf intake, deep profiler
  content/
    perf-probe.js          in-page Performance-API probe (Long Tasks, Web Vitals)
  ui/
    panel/                 the side-panel surface (panel.html / panel.js)
    shared/                summary-view.js (rendering) + summary.css (theme)
```

The toolbar icon **toggles the side panel** open/closed from any page.

### On per-tab / per-extension resource numbers

Stable Chrome does **not** expose exact CPU or RAM per tab or per extension to extensions — the `chrome.processes` API that would is Dev/Canary-only. Vantage therefore reports **system-level** memory/CPU and uses **behavioral signals** (main-thread blocking, heap trends, media, idle time) and **permission breadth** as proxies for "likely heavy." The **deep profiler** (`chrome.debugger`) is the one place you get true per-tab figures, on demand.

## Install (development)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this project folder.
4. Pin **Vantage** to the toolbar and click the icon to toggle the panel.

Requires **Chrome 121+**. Page-performance data appears as you browse (the probe injects into pages loaded after install); predictions build up over a session.

## Roadmap

| Version | Focus |
| ------- | ----- |
| 0.1.0   | Monitoring, diagnosis, cleanup actions, console UI (this release) |
| Later   | Rule-based auto-management, settings page, extension enable/disable, optional AI summary |
