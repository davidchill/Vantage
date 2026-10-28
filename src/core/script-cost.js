// script-cost.js — who is spending a page's main-thread time.
//
// The probe reports, per script source, how long scripts ran inside long animation
// frames (the LoAF API, Chrome 123+). This groups those sources by site and labels
// each one — this site, a known ad / analytics / social tracker, another third
// party, an extension that injected a script into the page, or inline/unknown code
// — so the panel can say which domains actually cost CPU, not just which loaded.
//
// Caveats worth surfacing to the user: LoAF credits time to the script that
// STARTED the work (an event listener, a timer callback), not necessarily the file
// that ran longest; scripts under 5ms aren't itemized; and extension content
// scripts (isolated worlds) and cross-origin iframes never appear at all.

import { registrableDomain, classifyHost, CATEGORY_LABELS } from "./trackers.js";

// Tag text for each kind of source; known trackers use their category label instead.
export const SCRIPT_KIND_LABELS = {
  self: "this site",
  third: "3rd-party",
  extension: "extension",
  unknown: "inline",
};

/** Short tag for a source: its tracker category ("Ads") or its kind ("this site"). */
export function sourceTag(source) {
  return source.kind === "tracker"
    ? CATEGORY_LABELS[source.category]
    : SCRIPT_KIND_LABELS[source.kind];
}

/** "doubleclick.net (Ads)"-style name for a source. */
export function describeSource(source) {
  return `${source.label} (${sourceTag(source)})`;
}

/** Compact duration: "420ms" under a second, "1.8s" above. */
export function fmtMs(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The source most responsible for a set of script rows, or null when nothing
 * stands out: no attributed time, less than `minMs`, or the top source is code
 * Chrome couldn't tie to a file — naming a smaller source then would mislead.
 */
export function topCulprit(scripts, pageUrl, extNames, minMs) {
  const top = analyzeScriptCost(scripts, pageUrl, extNames).sources[0];
  return top && top.kind !== "unknown" && top.ms >= minMs ? top : null;
}

/**
 * @param {Array<[string, number, number]>} scripts  probe rows: [source, runMs, layoutMs]
 * @param {string} pageUrl  the tab's URL (fixes which site counts as "this site")
 * @param {Object<string, string>} extNames  extension id -> name, for "ext:<id>" sources
 * @returns {{ sources: object[], totalMs: number, selfMs: number, thirdPartyMs: number }}
 *   sources are heaviest-first: { label, kind, category, ms, layoutMs }, where kind is
 *   "self" | "tracker" | "third" | "extension" | "unknown".
 */
export function analyzeScriptCost(scripts = [], pageUrl = "", extNames = {}) {
  let pageDomain = "";
  try {
    pageDomain = registrableDomain(new URL(pageUrl).hostname);
  } catch {
    /* opaque / non-web URL */
  }

  const groups = new Map(); // group key -> source summary
  for (const [source, ms, layoutMs] of scripts) {
    let key;
    let label;
    let kind;
    let category = null;
    if (!source) {
      key = "";
      label = "inline / unknown";
      kind = "unknown";
    } else if (source.startsWith("ext:")) {
      key = source;
      label = extNames[source.slice(4)] || "an extension";
      kind = "extension";
    } else {
      key = registrableDomain(source.toLowerCase());
      label = key;
      category = classifyHost(source);
      kind = key === pageDomain ? "self" : category ? "tracker" : "third";
    }

    const g = groups.get(key) || { label, kind, category, ms: 0, layoutMs: 0 };
    g.ms += ms;
    g.layoutMs += layoutMs;
    // Several hosts can share one site; keep the strongest tracker signal seen.
    if (!g.category && category && g.kind !== "self") {
      g.category = category;
      g.kind = "tracker";
    }
    groups.set(key, g);
  }

  const sources = [...groups.values()].sort((a, b) => b.ms - a.ms);
  const sum = (pred) => sources.filter(pred).reduce((n, s) => n + s.ms, 0);
  return {
    sources,
    totalMs: sum(() => true),
    selfMs: sum((s) => s.kind === "self"),
    thirdPartyMs: sum((s) => s.kind === "tracker" || s.kind === "third"),
  };
}
