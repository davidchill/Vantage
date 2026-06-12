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

function readout(value, label, hot = false) {
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

/** A section with a hairline-boxed list of log lines (or an empty marker). */
function section(title, rows, emptyMsg, slot = "") {
  const head = `<div class="sec-head"><span class="sec-mark"></span><span class="sec-title">${title}</span>${
    slot && rows.length ? `<span class="sec-slot">${slot}</span>` : ""
  }</div>`;
  const body = rows.length
    ? `<div class="lines">${rows.join("")}</div>`
    : `<div class="empty">${emptyMsg}</div>`;
  return `<section class="sec">${head}${body}</section>`;
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
export function renderSummary(contentEl, summary, cpuPercent, expanded = new Set()) {
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

  // ── Likely heavy tabs ───────────────────────────────────────────────────
  const warnMs = (perf && perf.warnMs) || 400;
  const heavyTabRows = (heavyTabs || []).map((t) => {
    let note;
    if (t.blockingMs >= warnMs) note = `⚠ ${t.blockingMs}ms`;
    else if (t.audible) note = "🔊 media";
    else if (t.reason === "loaded · idle") note = formatIdle(t.idleMinutes);
    else note = "loaded";
    if (t.jsHeapMB != null) note += ` · ${t.jsHeapMB}M`;
    return lineRow(`ht:${t.id}`, expanded, t.blockingMs >= warnMs ? "warn" : "", esc(t.title), note, heavyActions(t), t);
  });

  // ── Duplicates / idle / domains ─────────────────────────────────────────
  const dupeRows = duplicates.slice(0, 8).map((d) =>
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

  const idleRows = idleTabs.slice(0, 8).map((t) =>
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

  const domainRows = heavyDomains
    .slice(0, 8)
    .map((d) => lineRow(`dm:${d.host}`, expanded, "", esc(d.host), `${d.count} tabs`, "", d));

  // ── Extensions ──────────────────────────────────────────────────────────
  const extRows = ((extensions && extensions.list) || []).slice(0, 15).map((e) => {
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
    section("Page Performance", perfRows, perfEmpty, `<span class="sec-note">live + predicted</span>`) +
    section("Likely Heavy Tabs", heavyTabRows, "// nothing looks heavy", `<span class="sec-note">best guess</span>`) +
    section("Duplicate Tabs", dupeRows, "// no duplicates", purgeDupes) +
    section("Idle Tabs · 60m+", idleRows, "// nothing idle", sleepIdle) +
    section("Crowded Domains", domainRows, "// no domain hogging tabs") +
    section("Extensions", extRows, "// no other extensions", extHeader);

  const scannedAt = document.getElementById("scanned-at");
  if (scannedAt) {
    scannedAt.textContent = "scan " + new Date(summary.takenAt).toLocaleTimeString();
  }
}

/**
 * Scan + analyze + render in one call. Returns the data so the caller can
 * re-render instantly (e.g. on expand/collapse) without another scan.
 */
export async function runAndRender(contentEl, expanded = new Set()) {
  const [snapshot, cpuPercent] = await Promise.all([
    collectSnapshot(),
    sampleCpuPercent().catch(() => null),
  ]);
  const summary = analyze(snapshot);
  renderSummary(contentEl, summary, cpuPercent, expanded);
  return { summary, cpuPercent };
}

export { esc };
