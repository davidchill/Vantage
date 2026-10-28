# Vantage

A live **performance console** for Chrome. Vantage runs as an always-on background monitor over your tabs, extensions, cookies/trackers, and the browser's resource usage, then diagnoses what's slowing Chrome down — all in a dark, monospace, instrument-grade side panel.

> **Status:** v0.4.0 — monitoring & diagnosis, **script attribution** (which domains are actually spending a page's main-thread time), a **deep profiler that measures a tab's real main-thread load**, a per-site privacy inspector, opt-in rule-based auto-management, long-term strain tracking, an optional AI analysis, and in-context help throughout. Still pre-1.0 and evolving.

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
A single **Good / Strained / Heavy** verdict at the top of the panel, synthesized from every signal (memory pressure, tab count, background CPU drain, memory leaks, live jank, heavy origins, open chronic-strain sites). The top contributing factors are listed so the verdict is explainable, never a black box. The toolbar badge carries the same verdict — blue when Good, amber when Strained, red when Heavy — and hovering the icon shows the verdict and its top factors without opening the panel.

### Tab telemetry
Totals (tabs, windows, sleeping, audible, pinned, muted, loading), **duplicate-tab sets** (exact address match, including anything after `#` — many apps, like Gmail, route by it), **idle tabs** (untouched 60 min+), and **crowded domains** (one site hogging many tabs).

**Likely heavy tabs** ranks every loaded tab by measured signals first — main-thread blocking, then JS heap and DOM size — then audio, idle-but-loaded, and crowding, with the reason on each row (*janky*, *high memory*, *k DOM nodes*, …). Sorting by cpu or memory re-ranks every loaded tab, not just the rows already shown.

### System & Chrome gauges
- **`SYS MEM` / `SYS CPU`** — whole-machine memory and CPU usage (`chrome.system.memory` / `chrome.system.cpu`), across every process, not Chrome's slice. The labels and tooltips say so explicitly so the numbers aren't mistaken for Chrome's footprint. CPU is sampled over a short interval (two readings of the cumulative per-core tick counters) since a single reading is meaningless.
- **`JS HEAP`** — the one **Chrome-attributable** memory figure obtainable without attaching the debugger: the per-renderer JS heap (`usedJSHeapSize`) the in-page probe already reports, summed across measured tabs and shown as a share of system RAM. Deliberately partial — JS-heap only, excludes the browser/GPU processes and non-JS memory, and same-origin tabs sharing a renderer can be double-counted — and labeled as such. Hidden until the probe has reported.

### Page-performance engine
An in-page probe reads each page's **own** Performance APIs — no DevTools banner — and reports compact metrics every 5s:

- **Live jank** — main-thread blocking happening *right now* (Long Tasks over the 50 ms budget).
- **Background CPU drain** — tabs burning CPU while **hidden**. The worst kind of waste: you can't even see it. Held to a lower bar than foreground blocking. Throttling-aware: Chrome slows long-hidden tabs' timers to about one wake-up a minute, so each report carries its window length and blocking is normalized to a per-5s rate, and hidden tabs get a longer staleness allowance.
- **Memory-leak trends** — a per-tab JS-heap series (sampled about once a minute, scoped to the current page) flags a heap whose **floor** — its low point — climbs 75 MB+ over 10 min+. Comparing low points rather than single readings means garbage-collection sawtooth can't fake or hide a leak; navigating, reloading, or a prerendered page never reads as growth.
- **Web Vitals** — LCP (load), INP (interaction latency), CLS (layout shift, measured as Core Web Vitals defines it: the worst session window), plus page load time.
- **Predictions** — a persisted per-origin rolling average ("this site *tends* to be heavy / slow / laggy"), so a known-bad site is flagged the moment you open it, before it misbehaves again. Rolling averages (no all-time maximums) let a site's record recover; asleep tabs aren't predicted.
- **Script attribution** (Chrome 123+) — via the Long Animation Frames API, the probe records which script sources run in slow frames. A janky or background-draining row names the source behind its latest window (`⚠ 900ms · doubleclick.net`, the top three on expand), and every tab's detail shows its page-life **top script** — so you see *who* is costing the CPU, not just that something is.

### Chronic Strain tracking
A persistent **per-origin "repeat offender" ledger** — the time dimension the per-origin averages lack. It answers *how often, and how persistently,* a site crosses into strain, not just how heavy it is on average. Once a minute, on the background alarm (tab activity never adds counts), the origins with **measured** strain — live jank, background drain, memory growth — fold into a running tally (episode count, current/worst consecutive streak, per-kind breakdown) that survives restarts. History-based predictions are deliberately kept out, so the ledger can't feed on its own past verdicts. The **Chronic Strain** section surfaces sites flagged repeatedly and still misbehaving recently, flagging which are loaded right now (open and not asleep).

### Current Tab inspector
Ads, trackers, third-party domains, cookies, and script cost for the page you're actually looking at — refreshed as you switch tabs:

- **Main-thread JS** — how much script time the page has spent in slow frames and how much of it came from third parties (e.g. "main-thread JS 1.8s · 3rd-party 1.4s (79%)"), with a by-source breakdown that tags each domain as this site, Ads / Analytics / Social / Trackers, other 3rd-party, an extension, or inline code. A large third-party share usually means outside code is what's making the page sluggish.
- **Trackers** — the probe reports the unique hostnames a page contacted; each is matched against a curated ad / analytics / social / consent database (eTLD+1 aware, suffix-matched). Notably this uses **no** `webRequest` interception — the same broad API Vantage flags as heavy in other extensions.
- **Cookies** — a first-party cookie summary (count, size, secure / httpOnly / session split, SameSite breakdown) plus a per-tracker-domain probe revealing which trackers have actually planted cookies. **Clear cookies** for the active site in one click.

### Extensions inventory
Every installed extension ranked by **inferred impact** (permission breadth — broad host access and heavy always-on APIs like `webRequest`/`declarativeNetRequest` rank highest), with icon, version, install source (flags **sideloaded**, **dev**, **policy-forced**), and the full plain-English permission warnings.

### Deep profiler
On-demand **real load** for a single tab — the ⌖ button on Likely Heavy Tabs and Page Performance rows. Stable Chrome gives extensions no per-tab CPU figure, so the profiler attaches the DevTools protocol (`chrome.debugger` → `Performance.getMetrics`) and reads the tab's counters **twice, 3 seconds apart**: those counters are cumulative since page load, and the difference says how busy the tab is *now*. The result reads like "**62%** main-thread busy (heavy) over 3s — script 48% · layout 9.1% · other 4.7%", followed by JS heap (used/total), DOM nodes, listeners, frames — including how many Chrome itself has tagged as **ads** — and layouts in the window.

The counters were picked by testing against real Chrome rather than by name: a page built to keep its main thread 50% busy measured 50.1% end-to-end. The figure is the tab's renderer main thread, which same-site tabs sharing a process can add to. Chrome shows its "debugging this tab" banner during the 3-second sample, by design: it's the one place you get ground-truth per-tab figures.

### Auto-Management (opt-in, ships OFF)
Rule-based **auto-sleep / auto-close** of tabs that stay strained too long. The detection is already done by the analyzer; this adds **time** — a tab is acted on only after staying continuously strained for a configurable **sustain window** (default 5 min), so a momentary spike never costs you a tab. Triggers (**background CPU drain**, **memory leak**) are individually toggleable and each maps to `sleep` (reversible) or `close`. Every action re-checks live tab state at the moment it fires and refuses to touch tabs you're using (active / pinned / audible). An **audit log** records every action and why.

### AI Analysis (optional, bring-your-own key)
On demand, Vantage ships the analyzed summary to the Anthropic API and renders Claude's plain-English verdict plus a prioritized, severity-ranked list of suggestions that name the actual tabs, sites, and extensions to act on — including the script source behind a janky or heavy tab when attribution has one. Off until you add an API key; **on-demand only**, never on the live loop.

### Cleanup actions
Per-tab **sleep** (`tabs.discard`) and **close**, plus bulk **sleep all idle** and **purge duplicates** sweeps. Destructive actions confirm first. Purge keeps the copy you're most invested in (pinned › active › audible › most recent) and never closes a pinned or audible copy.

### The UI
A **dark, monospace, "observability console"** side panel: command-bar header with a live indicator, health-verdict hero, hairline metric cluster, segmented telemetry bars, and log-style sections. Every row **expands** to a detail block; every section and the AI card **collapse** to keep a data-dense panel navigable. Expand / collapse / sort state all survive the 5s live refresh. Blueprint-grid atmosphere, motion confined to the shell so the refresh never flickers, and `prefers-reduced-motion` honored.

**In-context help.** The dense readouts explain themselves on demand: telemetry items (the metric cluster, the gauges, the System Status verdict, and the Current-Tab readouts) show a one-line **tooltip** on hover or focus, and every section header carries a small **"ⓘ" button** that pops a card describing what the section is and how to read its rows. The whole help layer floats over the panel rather than living inside the live-refreshed content, so it never flickers or vanishes mid-read, and it's keyboard-accessible.

---

## Tech stack

- **Manifest V3** Chrome extension — background **service worker** (ES module), a **content-script** probe, and a **side-panel** UI.
- **Vanilla JavaScript (ES modules), no build step, no dependencies.** Source files load directly as `type: "module"`; there is nothing to compile or bundle. `package.json` exists only for metadata.
- **Chrome platform APIs:** `tabs`, `tabGroups`, `system.memory`, `system.cpu`, `storage` (`session` + `local`), `alarms`, `sidePanel`, `management`, `debugger`, `cookies`, `scripting`.
- **Web Performance APIs** (in the page): `PerformanceObserver` (longtask, long-animation-frame, largest-contentful-paint, layout-shift, event), `performance.memory`, resource & navigation timing.
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
    script-cost.js            LoAF script sources → per-site main-thread cost + culprits
    profile.js                two DevTools readings → a tab's main-thread busy % + breakdown
    cookies.js                first-party + tracker cookie inspection / clearing
    settings.js               auto-management + AI config (storage.local)
    automation.js             rule-based sustained-strain sleep/close + audit log
    actions.js                sleep / close tab operations
    ai-analysis.js            builds the prompt, calls the Anthropic API, parses the reply
  background/
    service-worker.js         alarm scans (+ badge-only event scans), health badge,
                              perf intake, strain recording, automation, probe
                              injection on install/update, one queue for all
                              storage writes, deep profiler
  content/
    perf-probe.js             in-page Performance-API probe (Long Tasks, Web Vitals, hosts)
  ui/
    panel/                    panel.html + panel.js, plus self-contained cards:
                              automation-ui.js, current-tab-ui.js, ai-ui.js
    shared/                   summary-view.js (rendering) + summary.css (theme),
                              explainers.js (help copy) + info-layer.js (tooltips / "ⓘ" pop-ups)
```

**Data flow:** the content-script probe reports per-tab metrics → the service worker folds them into live + per-origin + strain stores → on each scan `collectSnapshot()` gathers Chrome state + the perf stores → `analyze()` turns it into a summary → the panel renders it and re-renders live every 5s. Automation and AI both consume that same summary.

**Two storage tiers, on purpose:** `storage.session` holds within-a-browser-run state (live per-tab metrics, the automation strain timer) that *should* reset each run; `storage.local` holds things that should persist across restarts (per-origin history, the chronic-strain ledger, settings, the audit log).

---

## Design decisions & reasoning

The interesting choices and *why* they went the way they did:

- **Behavioral proxies over fake precision.** Stable Chrome won't give extensions per-tab CPU/RAM, so rather than display a number we can't actually measure, Vantage ranks "likely heavy" from signals it *can* read (measured main-thread blocking first, then measured JS heap and DOM size, then media/idle/crowding) and labels extensions by permission breadth. The deep profiler is the explicit escape hatch when you want true figures and accept the debug banner — and it measures a *rate* over a few seconds, because a single reading of cumulative counters can't tell you whether a tab is busy now.
- **A passive probe, not a debugger.** Reading the page's own Performance APIs from a content script is cheap enough to run on every tab forever and shows no banner. Attaching `chrome.debugger` to every tab would be heavyweight and alarming — so that's reserved for explicit, one-tab deep profiling.
- **Per-origin *history* vs per-origin *strain* are different questions.** The rolling EMA answers "how heavy is this site on average" (→ predictions). The strain ledger answers "how often / how persistently does it cross the line" (→ chronic offenders). Keeping them separate avoids smearing a site that's occasionally terrible into a site that's mildly heavy all the time.
- **The verdict counts only what was measured, at a fixed cadence.** A diagnostics tool that overstates strain trains you to ignore it. So the chronic ledger records only measured strain, once a minute on the alarm — never predictions, never tab-activity bursts; asleep tabs don't count as strain; Web Vitals follow the standard definitions; and readings are corrected for Chrome's own behavior (hidden-tab timer throttling, prerendered pages, garbage-collection sawtooth) before they're judged.
- **Automation gates on *time*, and ships off.** Detection is instantaneous, but acting on a momentary spike would be hostile, so automation waits for a continuous sustain window and re-validates live state before touching anything — and never auto-runs until you opt in. Sleep is preferred over close; the audit log means nothing disappears silently.
- **The tracker inspector refuses `webRequest`.** It would be ironic for a tool that flags `webRequest`-using extensions as heavy to use `webRequest` itself. Instead it classifies the hostnames the probe already collected against a curated database — lighter, and honest to the tool's own thesis.
- **AI is opt-in, bring-your-own-key, and on-demand.** Vantage is otherwise fully local and free. The one feature that leaves the machine requires *your* Anthropic key (stored only locally), never fires automatically (so it can't bill you silently), and only sends the already-analyzed summary — not raw page content. **Structured outputs** constrain the reply to a small JSON schema so rendering never depends on fragile text parsing, and it defaults to the most capable model with cheaper options a click away.
- **One source of truth, collapsible everywhere.** All surfaces render from `analyze()`'s output, so the popup/panel/automation/AI never disagree. As the data grew dense, every section and the AI card became collapsible (with state that survives the live refresh) so the panel stays navigable instead of becoming a wall.
- **The always-on loop does no redundant work.** Because the panel re-renders every 5s for as long as it's open, the live path is kept deliberately lean. The toolbar badge runs off the in-memory summary rather than a written-then-read storage cache; the cookie/tracker inspector caches its cookie-store lookups and re-queries them only on a tab switch, reload, or *clear cookies* (the tracker counts still recompute each tick from the probe's host list); and the installed-extension list is enumerated event-driven — on install / uninstall / enable / disable — rather than on every tick. The analyzer itself parses each tab's URL once per scan. In the background, tab events only refresh the badge, and only the ones that can change it (title, favicon, and tab-switch events are ignored), and every storage read-modify-write goes through a single queue so concurrent updates can't overwrite each other. The heartbeat re-reads — and re-computes — only what can actually have changed.
- **The probe is featherweight in every tab.** The one component that runs in *every* page is held to a stricter bar still: it accumulates resource timing incrementally through a `PerformanceObserver` instead of re-scanning the page's whole (ever-growing) resource buffer each tick, samples the expensive full-DOM node count only occasionally and only while the tab is visible, and reads fixed navigation timing just once. On the receiving end, the worker batches the staggered reports from all tabs into a single storage write per flush. The result: a performance monitor that imposes as little load as possible on the pages it's measuring — which is the whole point.

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
| `debugger` | The opt-in deep profiler only (a tab's real main-thread load, sampled over 3s). |
| `cookies` | The Current-Tab cookie inspector and *clear cookies*. |
| `scripting` | Inject the probe into tabs already open when Vantage is installed or updated — otherwise they'd go unmeasured until reloaded. No extra install warning. |
| `host_permissions: http/https` | Inject the performance probe into pages and read resource hostnames. |

---

## Install (development)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this project folder.
4. Pin **Vantage** to the toolbar and click the icon to toggle the panel.

Requires **Chrome 121+**. Page-performance data starts within seconds — the probe is injected into already-open tabs on install or update, and into every new page as it loads; predictions and chronic-strain history build up over time. To enable AI Analysis, open settings (⚙) and paste an Anthropic API key.

---

## Limitations & notes

- Stable Chrome does not expose per-tab or per-extension CPU/RAM to extensions; Vantage uses system-level resources plus behavioral heuristics and permission breadth as proxies. The deep profiler is the one source of true per-tab figures — and it measures the tab's renderer *main thread* (not workers or the GPU), which same-site tabs sharing a process can add to.
- `performance.memory` reports the JS heap of a page's whole renderer process, so tabs from the same site sharing a process show the same figure; treat per-tab heap as indicative rather than exact. (On desktop Chrome it is precise and updates live.)
- Long-hidden tabs report only about once a minute (Chrome's timer throttling). Vantage normalizes for it, but background readings are coarser than foreground ones.
- Long Tasks only see work in tasks over 50 ms on the page's main thread — not frequent short tasks, workers, or cross-origin iframes.
- Script attribution (Long Animation Frames) has its own limits: it needs Chrome 123+; Chrome credits the script that *started* the work, not necessarily the file that ran longest; scripts under 5 ms aren't itemized; and **extension content scripts and cross-origin iframes are never attributed** — so it measures third-party page scripts, not extensions (an extension appears only if it injects a script into the page itself). Whether hidden tabs report LoAF at all is still being verified.
- Content scripts can't run on `chrome://` pages, the Web Store, or the PDF viewer; those tabs show metadata only.
- The tracker database is a curated, representative list — enough to answer "what's tracking me here," not an exhaustive blocklist.
- AI Analysis is metered by Anthropic and billed to your key; one analysis is a fraction of a cent to a few cents depending on the model.
- Uses the system monospace stack; no bundled font. No custom toolbar icon yet — Chrome shows a default placeholder.

---

## Roadmap

| Version | Focus |
| ------- | ----- |
| 0.1.0 | Monitoring, diagnosis, cleanup actions, console UI (initial release). |
| 0.2.0 | Current-Tab inspector, auto-management, chronic-strain tracking, AI analysis, collapsible UI. |
| 0.2.x | Efficiency passes (lighter probe, batched writes, cached reads), QoL (in-context tooltips & per-section explainers, system-vs-Chrome gauge clarity, a measured `JS HEAP` gauge), and an accuracy pass in 0.2.6 (measured-only chronic strain, standard CLS, GC-robust leak detection, throttling-aware background detection, safer duplicate cleanup, health-coloured badge). |
| 0.3.0 | Script attribution via Long Animation Frames: per-page main-thread cost by source in the Current Tab inspector, culprits named on janky rows and in tab details, and in the AI snapshot. |
| 0.4.0 | Deep profiler measures a tab's real main-thread load (two readings 3s apart, with a script / layout / style breakdown and Chrome-tagged ad frames), available from Page Performance rows too (this release). |
| 0.4.x | A cross-tab view of which script sources cost the most main-thread time across all tabs — pending a real-Chrome check of whether hidden tabs report LoAF. |
| Later | Cross-session persistence for UI state, a chronic-strain automation trigger, extension enable/disable, a custom toolbar icon, optional inner-scroll cap on long AI results. |
