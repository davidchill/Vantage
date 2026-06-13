// summary-view.js — shared rendering for the monitoring surface.
// Emits the "observability console" markup; the data all comes from analyze().
// Rows are collapsible: each carries a stable data-key, and the caller passes an
// `expanded` Set of keys so open/closed state survives the 5s live re-render.

import { collectSnapshot, sampleCpuPercent } from "../../core/collector.js";
import { analyze } from "../../core/analyzer.js";

/** Escape untrusted text (tab titles/URLs are page-controlled). */
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function fmtBytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

function trackClass(pct) {
  if (pct >= 85) return "high";
  if (pct >= 60) return "mid";
  return "";
}

function formatIdle(min) {
  if (min < 60) return `${min}m idle`;
  return `${Math.floor(min / 60)}h idle`;
}

export function readout(value, label, hot = false) {
  return `<div class="readout"><span class="rv${hot ? " hot" : ""}">${value}</span><span class="rl">${label}</span></div>`;
}

/** Expandable detail: optional URL line, a key/value grid, and a bullet list. */
function detailBlock(item) {
  if (!item) return "";
  let html = "";
  if (item.url) html += `<div class="d-url">${esc(item.url)}</div>`;
  if (item.stats && item.stats.length) {
    html += `<div class="kv-grid">${item.stats
      .map(
        ([k, v]) =>
          `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`
      )
      .join("")}</div>`;
  }
  if (item.bullets && item.bullets.length) {
    html += `<ul class="d-list">${item.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
  }
  return `<div class="detail">${html || '<span class="d-empty">// no further detail</span>'}</div>`;
}

/** One collapsible log line + (when open) its detail block. */
function lineRow(key, expanded, cls, titleHtml, metaHtml, actionsHtml, item, leadHtml = "") {
  const open = expanded.has(key);
  const head = `<div class="line${cls ? " " + cls : ""}${open ? " open" : ""}" data-key="${esc(key)}">
      <span class="caret">›</span>
      ${leadHtml}
      <span class="ln-title">${titleHtml}</span>
      ${metaHtml ? `<span class="ln-meta">${metaHtml}</span>` : ""}
      ${actionsHtml || ""}
    </div>`;
  return open ? head + detailBlock(item) : head;
}

/**
 * A section with a hairline-boxed list of log lines (or an empty marker).
 * The header is a collapse toggle: clicking it hides the body. Collapsed state is
 * keyed by `id` in the `collapsed` Set so it survives the 5s live re-render.
 */
function section(id, title, rows, emptyMsg, slot = "", collapsed) {
  const isCollapsed = !!(collapsed && collapsed.has(id));
  const count = rows.length ? `<span class="sec-count">${rows.length}</span>` : "";
  const head = `<div class="sec-head" data-sec="${esc(id)}" role="button" aria-expanded="${!isCollapsed}">
      <span class="caret sec-caret">›</span>
      <span class="sec-mark"></span>
      <span class="sec-title">${title}</span>
      ${count}
      ${slot && rows.length ? `<span class="sec-slot">${slot}</span>` : ""}
    </div>`;
  const body = rows.length
    ? `<div class="lines">${rows.join("")}</div>`
    : `<div class="empty">${emptyMsg}</div>`;
  // Body is always in the DOM; CSS hides it when the section carries .collapsed.
  return `<section class="sec${isCollapsed ? " collapsed" : ""}">${head}${body}</section>`;
}

// ── Sorting ──────────────────────────────────────────────────────────────────
// Each data section can be re-ordered from its header. The FIRST option in each
// list reproduces that section's existing default order, so nothing moves until
// the user clicks. Direction is baked into each option's meaning ("most idle" vs
// "least idle") rather than a separate asc/desc toggle — clearer at a glance, and
// it survives the 5s re-render because clicking just cycles + re-renders.
function cmpStr(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

const SORTS = {
  heavy: [
    { key: "weight", label: "weight", cmp: (a, b) => b.score - a.score },
    { key: "cpu", label: "cpu", cmp: (a, b) => b.blockingMs - a.blockingMs },
    { key: "mem", label: "memory", cmp: (a, b) => (b.jsHeapMB || 0) - (a.jsHeapMB || 0) },
    { key: "name", label: "name", cmp: (a, b) => cmpStr(a.title, b.title) },
  ],
  dupes: [
    { key: "count", label: "count", cmp: (a, b) => b.count - a.count },
    { key: "name", label: "name", cmp: (a, b) => cmpStr(a.title, b.title) },
  ],
  chronic: [
    {
      key: "episodes",
      label: "episodes",
      cmp: (a, b) => b.strainScans - a.strainScans || b.maxStreak - a.maxStreak,
    },
    { key: "streak", label: "streak", cmp: (a, b) => b.maxStreak - a.maxStreak },
    { key: "recent", label: "recent", cmp: (a, b) => b.lastStrained - a.lastStrained },
    { key: "name", label: "name", cmp: (a, b) => cmpStr(a.origin, b.origin) },
  ],
  idle: [
    { key: "idle", label: "most idle", cmp: (a, b) => b.idleMinutes - a.idleMinutes },
    { key: "recent", label: "least idle", cmp: (a, b) => a.idleMinutes - b.idleMinutes },
    { key: "name", label: "name", cmp: (a, b) => cmpStr(a.title, b.title) },
  ],
  domains: [
    { key: "tabs", label: "tabs", cmp: (a, b) => b.count - a.count },
    { key: "name", label: "name", cmp: (a, b) => cmpStr(a.host, b.host) },
  ],
  ext: [
    {
      key: "impact",
      label: "impact",
      cmp: (a, b) =>
        b.weight - a.weight || b.warningCount - a.warningCount || cmpStr(a.name, b.name),
    },
    { key: "warnings", label: "warnings", cmp: (a, b) => b.warningCount - a.warningCount },
    { key: "name", label: "name", cmp: (a, b) => cmpStr(a.name, b.name) },
  ],
};

/** The active sort option for a section (defaults to the first / current order). */
function activeSort(sectionId, sortState) {
  const opts = SORTS[sectionId];
  if (!opts) return null;
  return opts.find((o) => o.key === sortState.get(sectionId)) || opts[0];
}

/** A re-ordered copy of `list` per the section's active sort. */
function sortedFor(sectionId, list, sortState) {
  const opt = activeSort(sectionId, sortState);
  return opt ? [...list].sort(opt.cmp) : list;
}

/** Header control showing the current sort; cycles to the next on click. */
function sortControl(sectionId, sortState) {
  const opt = activeSort(sectionId, sortState);
  if (!opt) return "";
  return `<button class="sortbtn" data-sort="${sectionId}" title="Sort — click to cycle"><span class="sortbtn-ico">⇅</span>${esc(opt.label)}</button>`;
}

/** Advance a section to its next sort option (wraps). Mutates `sortState`. */
export function advanceSort(sortState, sectionId) {
  const opts = SORTS[sectionId];
  if (!opts) return;
  const curKey = sortState.get(sectionId) || opts[0].key;
  const idx = opts.findIndex((o) => o.key === curKey);
  sortState.set(sectionId, opts[(idx + 1) % opts.length].key);
}

/** Sleep + close controls for a tab (Sleep hidden if it's already asleep). */
function tabActions(t) {
  const sleep = t.discarded
    ? ""
    : `<button class="act" data-act="sleep" data-id="${t.id}" title="Discard (sleep) tab">⏾</button>`;
  return `<span class="acts">${sleep}<button class="act danger" data-act="close" data-id="${t.id}" title="Close tab">✕</button></span>`;
}

/** Heavy-tab controls: deep-profile (real metrics) + sleep + close. */
function heavyActions(t) {
  const profile = `<button class="act" data-act="profile" data-id="${t.id}" title="Deep profile — real heap/CPU via DevTools (flashes a debug banner)">⌖</button>`;
  const sleep = t.discarded
    ? ""
    : `<button class="act" data-act="sleep" data-id="${t.id}" title="Discard (sleep) tab">⏾</button>`;
  return `<span class="acts">${profile}${sleep}<button class="act danger" data-act="close" data-id="${t.id}" title="Close tab">✕</button></span>`;
}

/** A badge calling out an extension's install source, when notable. */
function sourceBadge(e) {
  if (e.installType === "sideload")
    return `<span class="tag src-warn" title="Installed by another program on your computer — worth scrutinizing">sideload</span>`;
  if (e.installType === "development")
    return `<span class="tag src-dev" title="Loaded unpacked in developer mode">dev</span>`;
  if (e.mayDisable === false)
    return `<span class="tag src-locked" title="Force-installed by policy — can't be removed">🔒</span>`;
  return "";
}

/**
 * Render a summary into the given container element.
 * @param {Set<string>} expanded — keys of rows that should be shown expanded.
 */
export function renderSummary(
  contentEl,
  summary,
  cpuPercent,
  expanded = new Set(),
  sortState = new Map(),
  collapsed = new Set()
) {
  const { totals, memory, idleTabs, duplicates, heavyDomains, heavyTabs, extensions } =
    summary;

  // ── Health verdict ──────────────────────────────────────────────────────
  const health = summary.health;
  const signalPct = { Good: 34, Strained: 67, Heavy: 100 }[health?.level] ?? 0;
  const tokens =
    health && health.factors.length
      ? health.factors.map((f) => `<span class="token">${esc(f.label)}</span>`).join("")
      : `<span class="token">all systems nominal</span>`;
  const verdict = health
    ? `<div class="verdict v-${health.level.toLowerCase()}">
        <div class="verdict-label">System Status</div>
        <div class="verdict-word">${health.level}</div>
        <div class="signal"><span style="width:${signalPct}%"></span></div>
        <div class="tokens">${tokens}</div>
      </div>`
    : "";

  // ── Metric cluster ──────────────────────────────────────────────────────
  const cluster =
    `<div class="cluster">` +
    readout(totals.tabs, "tabs") +
    readout(totals.windows, "windows") +
    readout(totals.sleeping, "sleeping") +
    readout(totals.audible, "audio", totals.audible > 0) +
    readout(duplicates.length, "dupe sets", duplicates.length > 0) +
    readout(idleTabs.length, "idle", idleTabs.length > 0) +
    readout(
      (summary.performance?.chronic || []).length,
      "chronic",
      (summary.performance?.chronic || []).length > 0
    ) +
    `</div>`;

  // ── Telemetry gauges ────────────────────────────────────────────────────
  const memGauge = `<div class="gauge">
      <span class="gl">MEM</span>
      <span class="track ${trackClass(memory.usedPercent)}"><span style="width:${memory.usedPercent}%"></span></span>
      <span class="gv">${memory.usedPercent}% · ${fmtBytes(memory.usedBytes)}/${fmtBytes(memory.capacityBytes)}</span>
    </div>`;
  const cpuGauge =
    cpuPercent == null
      ? ""
      : `<div class="gauge">
          <span class="gl">CPU</span>
          <span class="track ${trackClass(cpuPercent)}"><span style="width:${cpuPercent}%"></span></span>
          <span class="gv">${cpuPercent}%</span>
        </div>`;
  const gauges = `<div class="gauges">${memGauge}${cpuGauge}</div>`;

  // ── Page performance (worst-first) ──────────────────────────────────────
  const perf = summary.performance;
  const perfRows = [];
  if (perf) {
    for (const b of (perf.background || []).slice(0, 5)) {
      perfRows.push(
        lineRow(`pb:${b.id}`, expanded, "warn", `🌙 ${esc(b.title)}`, `bg-cpu ${b.blockingHiddenMs}ms`, tabActions(b), b)
      );
    }
    for (const a of perf.live.slice(0, 5)) {
      perfRows.push(
        lineRow(
          `pl:${a.id}`,
          expanded,
          "warn",
          esc(a.title),
          `⚠ ${a.blockingMs}ms${a.jsHeapMB != null ? ` · ${a.jsHeapMB}M` : ""}`,
          tabActions(a),
          a
        )
      );
    }
    for (const lk of (perf.leaks || []).slice(0, 4)) {
      perfRows.push(
        lineRow(
          `pk:${lk.id}`,
          expanded,
          "warn",
          `📈 ${esc(lk.title)}`,
          `+${lk.growthMB}M/${lk.spanMin}m → ${lk.currentMB}M`,
          tabActions(lk),
          lk
        )
      );
    }
    for (const p of (perf.predictions || []).slice(0, 4)) {
      const bits = [];
      if (p.heavy) bits.push(`~${p.avgBlockingMs}ms`);
      if (p.poorVitals && p.poorVitals.length) bits.push(p.poorVitals.join(", "));
      perfRows.push(
        lineRow(`pp:${p.origin}`, expanded, "", esc(p.origin), bits.join(" · ") || "tends heavy", "", p)
      );
    }
  }
  const perfEmpty =
    perf && !perf.hasData ? "// gathering data — browse a little" : "// all clear";

  // ── Chronic strain (repeat offenders over time) ─────────────────────────
  const chronicRows = sortedFor("chronic", (perf && perf.chronic) || [], sortState).map((c) => {
    const bits = [`×${c.strainScans}`];
    if (c.topLabel) bits.push(c.topLabel);
    if (c.maxStreak >= 2) bits.push(`streak ${c.maxStreak}`);
    bits.push(c.ageDays < 1 ? "today" : `${c.ageDays}d`);
    if (c.open) bits.push("open now");
    const title = `${c.open ? "🔴" : "🔁"} ${esc(c.origin)}`;
    return lineRow(`pc:${c.origin}`, expanded, c.open ? "warn" : "", title, bits.join(" · "), "", c);
  });
  const chronicEmpty =
    perf && !perf.hasData
      ? "// gathering data — browse a little"
      : "// no repeat offenders — sites behave consistently";

  // ── Likely heavy tabs ───────────────────────────────────────────────────
  const warnMs = (perf && perf.warnMs) || 400;
  const heavyTabRows = sortedFor("heavy", heavyTabs || [], sortState).map((t) => {
    let note;
    if (t.blockingMs >= warnMs) note = `⚠ ${t.blockingMs}ms`;
    else if (t.audible) note = "🔊 media";
    else if (t.reason === "loaded · idle") note = formatIdle(t.idleMinutes);
    else note = "loaded";
    if (t.jsHeapMB != null) note += ` · ${t.jsHeapMB}M`;
    return lineRow(`ht:${t.id}`, expanded, t.blockingMs >= warnMs ? "warn" : "", esc(t.title), note, heavyActions(t), t);
  });

  // ── Duplicates / idle / domains ─────────────────────────────────────────
  const dupeRows = sortedFor("dupes", duplicates, sortState).slice(0, 8).map((d) =>
    lineRow(
      `dp:${d.url}`,
      expanded,
      "",
      esc(d.title),
      `×${d.count}`,
      `<span class="acts"><button class="act danger" data-act="close-set" data-ids="${d.tabIds.join(
        ","
      )}" title="Close extra copies">✕ dup</button></span>`,
      d
    )
  );

  const idleRows = sortedFor("idle", idleTabs, sortState).slice(0, 8).map((t) =>
    lineRow(
      `id:${t.id}`,
      expanded,
      "",
      esc(t.title),
      `${formatIdle(t.idleMinutes)}${t.discarded ? " · ⏾" : ""}`,
      tabActions(t),
      t
    )
  );

  const domainRows = sortedFor("domains", heavyDomains, sortState)
    .slice(0, 8)
    .map((d) => lineRow(`dm:${d.host}`, expanded, "", esc(d.host), `${d.count} tabs`, "", d));

  // ── Extensions ──────────────────────────────────────────────────────────
  const extRows = sortedFor("ext", (extensions && extensions.list) || [], sortState)
    .slice(0, 15)
    .map((e) => {
    const icon = e.iconUrl
      ? `<img class="ext-ico" src="${esc(e.iconUrl)}" alt="" />`
      : `<span class="ext-ico ext-fallback"></span>`;
    const warn = e.warningCount
      ? `<span class="tag warn-pill" title="${esc(e.warnings.join("\n"))}">⚠${e.warningCount}</span>`
      : "";
    const acts = `<span class="acts" style="opacity:1">${sourceBadge(e)}${warn}<span class="tag ${e.breadth}">${e.breadth}</span></span>`;
    const title = `${esc(e.name)} <span class="ext-ver">${esc(e.version)}</span>`;
    return lineRow(`ex:${e.id}`, expanded, "", title, "", acts, e, icon);
  });
  const extHeader = extensions
    ? `<span class="sec-note">${extensions.enabled} on · ${extensions.disabled} off${
        extensions.broad ? ` · ${extensions.broad} broad` : ""
      }${extensions.sideloaded ? ` · ${extensions.sideloaded} sideload` : ""}</span>`
    : "";

  const purgeDupes = `<button class="act danger" data-act="close-dupes" title="Close every redundant copy">purge dupes</button>`;
  const sleepIdle = `<button class="act" data-act="sleep-idle" title="Sleep every idle tab">sleep idle</button>`;

  // ── Compose ─────────────────────────────────────────────────────────────
  contentEl.innerHTML =
    verdict +
    cluster +
    gauges +
    section("perf", "Page Performance", perfRows, perfEmpty, `<span class="sec-note">live + predicted</span>`, collapsed) +
    section(
      "chronic",
      "Chronic Strain",
      chronicRows,
      chronicEmpty,
      sortControl("chronic", sortState) + `<span class="sec-note">over time</span>`,
      collapsed
    ) +
    section(
      "heavy",
      "Likely Heavy Tabs",
      heavyTabRows,
      "// nothing looks heavy",
      sortControl("heavy", sortState) + `<span class="sec-note">best guess</span>`,
      collapsed
    ) +
    section(
      "dupes",
      "Duplicate Tabs",
      dupeRows,
      "// no duplicates",
      sortControl("dupes", sortState) + purgeDupes,
      collapsed
    ) +
    section(
      "idle",
      "Idle Tabs · 60m+",
      idleRows,
      "// nothing idle",
      sortControl("idle", sortState) + sleepIdle,
      collapsed
    ) +
    section("domains", "Crowded Domains", domainRows, "// no domain hogging tabs", sortControl("domains", sortState), collapsed) +
    section("ext", "Extensions", extRows, "// no other extensions", sortControl("ext", sortState) + extHeader, collapsed);

  const scannedAt = document.getElementById("scanned-at");
  if (scannedAt) {
    scannedAt.textContent = "scan " + new Date(summary.takenAt).toLocaleTimeString();
  }
}

/**
 * Scan + analyze + render in one call. Returns the data so the caller can
 * re-render instantly (e.g. on expand/collapse) without another scan.
 */
export async function runAndRender(
  contentEl,
  expanded = new Set(),
  sortState = new Map(),
  collapsed = new Set()
) {
  const [snapshot, cpuPercent] = await Promise.all([
    collectSnapshot(),
    sampleCpuPercent().catch(() => null),
  ]);
  const summary = analyze(snapshot);
  renderSummary(contentEl, summary, cpuPercent, expanded, sortState, collapsed);
  return { summary, cpuPercent };
}

export { esc };
