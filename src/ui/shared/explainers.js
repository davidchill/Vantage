// explainers.js — the human-readable help text behind the hover tooltips and the
// per-section "ⓘ" pop-ups. Kept in one place so the copy is easy to review/edit
// and the renderers (summary-view, current-tab-ui) only carry keys, not prose.

// Short one-liners for the metric cluster readouts, keyed by their label.
export const READOUT_TIPS = {
  tabs: "Total open tabs across every window.",
  windows: "Open browser windows.",
  sleeping:
    "Tabs Chrome has discarded from memory to save resources. They reload automatically when you click back to them.",
  audio: "Tabs currently playing audio.",
  "dupe sets":
    "Groups of tabs pointing at the same page. Each set has at least one redundant copy you can close.",
  idle: "Tabs untouched for 60+ minutes that aren't pinned, playing audio, or active.",
  chronic:
    "Sites that have repeatedly strained the browser over time — detailed in the Chronic Strain section below.",
};

// Telemetry gauges.
export const GAUGE_TIPS = {
  MEM: "Memory in use across your whole computer, not just Chrome. Higher means less headroom for new tabs.",
  CPU: "Whole-machine CPU load, sampled about every 15s. A brief spike is normal; sustained high load isn't.",
  HEAP: "Chrome-only: the JS heap summed across tabs Vantage has measured. This is the part of Chrome's memory we can actually read — it excludes the browser/GPU processes and non-JS memory, so it undercounts Chrome's true footprint. The bar shows it as a share of total system RAM.",
};

// Current-Tab inspector readouts, keyed by label.
export const CT_TIPS = {
  ads: "Ad-network resources this page loaded.",
  trackers: "Known analytics / tracking resources this page loaded.",
  "3rd-party": "Distinct outside domains this page pulled resources from.",
  cookies: "First-party cookies this site has stored in your browser.",
};

// The hero health verdict.
export const VERDICT_TIP =
  "Overall read of browser health, combining system memory pressure, tab count, and any pages straining the browser right now.";

// Longer per-section explainers shown in the click-to-open "ⓘ" pop-up.
// `what` = what the section is; `interpret` = how to read the rows.
export const SECTION_INFO = {
  ct: {
    title: "Current Tab",
    what: "What the page you're actively looking at is loading and storing — ads, trackers, outside domains, and cookies. Click the tiles to expand the full breakdown.",
    interpret: [
      "ads / trackers — resources matched against known ad and analytics networks.",
      "3rd-party — distinct outside domains the page reached out to.",
      "cookies — first-party cookies this site has stored; 'clear cookies' wipes them.",
    ],
  },
  perf: {
    title: "Page Performance",
    what: "Pages affecting performance right now, plus ones predicted to based on how they've behaved on past visits.",
    interpret: [
      "⚠ blocking — milliseconds a page froze the main thread in the last 5s; over ~400ms feels janky.",
      "🌙 background CPU — a hidden tab still burning CPU where you can't see it.",
      "📈 memory growth — heap climbing steadily over time, a possible leak.",
      "Plain rows with no icon are predictions from this site's history, not live measurements.",
    ],
  },
  chronic: {
    title: "Chronic Strain",
    what: "Sites the strain ledger has flagged again and again over days — persistent repeat offenders, not a single bad moment.",
    interpret: [
      "×N — how many scans have flagged this site.",
      "streak — consecutive scans it stayed flagged.",
      "🔴 open now means it's loaded this instant; 🔁 means seen recently but not currently open.",
    ],
  },
  heavy: {
    title: "Likely Heavy Tabs",
    what: "A best-guess ranking of which tabs are using the most resources, scored from readable signals — measured jank, audio playback, and idle-but-loaded memory.",
    interpret: [
      "It's an estimate: Chrome doesn't expose true per-tab memory without deep profiling.",
      "Use the ⌖ deep-profile button on a row for real heap/CPU numbers.",
      "A ⚠ note means the tab actually janked; otherwise the score is inferred.",
    ],
  },
  dupes: {
    title: "Duplicate Tabs",
    what: "Tabs open to the same page. Each set keeps one copy and counts the extras.",
    interpret: [
      "×N is the total number of copies in that set.",
      "'purge dupes' closes every redundant copy across all sets at once.",
    ],
  },
  idle: {
    title: "Idle Tabs",
    what: "Tabs you haven't touched in over an hour that aren't pinned, audible, or currently active.",
    interpret: [
      "Good candidates to sleep — sleeping frees their memory but keeps the tab around.",
      "'sleep idle' discards them all in one click; the ⏾ icon marks ones already asleep.",
    ],
  },
  domains: {
    title: "Crowded Domains",
    what: "Hosts you have several tabs open to at once.",
    interpret: [
      "Useful for spotting a site that has quietly accumulated a pile of tabs.",
    ],
  },
  ext: {
    title: "Extensions",
    what: "Your enabled extensions, ranked by likely impact inferred from the permissions they hold.",
    interpret: [
      "broad = runs on every site or uses heavy network APIs; some = limited sites; minimal = little access.",
      "⚠ flags permission warnings; 'sideload', 'dev', and 🔒 call out a notable install source.",
      "Breadth is a proxy for impact — Chrome doesn't report per-extension CPU or memory.",
    ],
  },
};
