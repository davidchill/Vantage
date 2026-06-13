// ai-ui.js — the "AI Analysis" card in the side panel.
//
// Renders a single button that, on click, ships the latest scan to Claude (see
// core/ai-analysis.js) and paints back a headline + prioritized suggestions. The
// card lives outside #content so the 5s live re-render never wipes a result the
// user is reading. State is local to this module; nothing here runs on a timer.

import { esc } from "../shared/summary-view.js";
import { runAnalysis } from "../../core/ai-analysis.js";
import { getSettings } from "../../core/settings.js";

const card = document.getElementById("ai-card");

// Provided by panel.js so the button can grab the most recent scan + cpu reading.
let getLast = () => null;
// Last result kept so the live loop (which never touches this card) can't lose it.
let lastResult = null;
let running = false;
// Collapse the result body — a full analysis is tall and would otherwise crowd out
// everything below it. Toggle from the header once a result exists.
let collapsed = false;

const SEV_LABEL = { high: "high", medium: "med", low: "low" };

function headerHtml(busy) {
  // Only a real result is worth collapsing; pre-analysis the body is one line.
  const hasResult = !!(lastResult?.ok || lastResult?.error);
  const lead = hasResult
    ? `<span class="caret sec-caret">›</span>`
    : `<span class="ai-mark">✦</span>`;
  const count =
    lastResult?.ok && lastResult.suggestions.length
      ? `<span class="sec-count">${lastResult.suggestions.length}</span>`
      : "";
  return `<div class="ai-head"${hasResult ? ' data-act="ai-toggle"' : ""}>
      ${lead}
      <span class="ai-title">AI Analysis</span>
      ${count}
      <button class="ai-run${busy ? " busy" : ""}" data-act="ai-run"${busy ? " disabled" : ""}>
        ${busy ? "analyzing…" : "Run analysis"}
      </button>
    </div>`;
}

function suggestionHtml(s) {
  const sev = SEV_LABEL[s.severity] ? s.severity : "low";
  return `<div class="ai-sug sev-${sev}">
      <div class="ai-sug-top">
        <span class="ai-sev sev-${sev}">${esc(SEV_LABEL[sev])}</span>
        <span class="ai-sug-title">${esc(s.title)}</span>
      </div>
      <div class="ai-sug-detail">${esc(s.detail)}</div>
    </div>`;
}

// Always returns a populated <div class="ai-body"> so the card is the same size
// in every state (no key, ready, running, result, error) — no empty header sliver.
function bodyHtml(hasKey) {
  const wrap = (inner) => `<div class="ai-body">${inner}</div>`;

  if (running) return wrap(`<div class="ai-status">// consulting Claude…</div>`);
  if (lastResult?.error) return wrap(`<div class="ai-error">⚠ ${esc(lastResult.error)}</div>`);
  if (lastResult?.ok) {
    const sugs = lastResult.suggestions.length
      ? lastResult.suggestions.map(suggestionHtml).join("")
      : `<div class="ai-status">// no suggestions returned</div>`;
    return wrap(
      `<div class="ai-headline">${esc(lastResult.headline)}</div>${sugs}<div class="ai-foot">${esc(lastResult.model)} · ${esc(lastResult.at)}</div>`
    );
  }
  // Never run yet — a consistent one-line hint.
  return wrap(
    hasKey
      ? `<div class="ai-status">// ready — click “Run analysis” for Claude’s read of the current state</div>`
      : `<div class="ai-status">// add an Anthropic API key in settings (⚙) to enable AI analysis</div>`
  );
}

async function render() {
  const settings = await getSettings();
  const hasKey = !!settings.ai.apiKey.trim();
  card.classList.toggle("collapsed", collapsed);
  card.innerHTML = headerHtml(running) + bodyHtml(hasKey);
}

function toggleCollapse() {
  collapsed = !collapsed;
  render();
}

async function run() {
  if (running) return;
  const snap = getLast();
  if (!snap?.summary) {
    lastResult = { error: "No scan data yet — wait a moment and retry." };
    return render();
  }
  collapsed = false; // always reveal a fresh result
  running = true;
  await render();
  try {
    const res = await runAnalysis(snap.summary, snap.cpuPercent);
    lastResult = {
      ok: true,
      headline: res.headline,
      suggestions: res.suggestions,
      model: res.model,
      at: new Date().toLocaleTimeString(),
    };
  } catch (err) {
    lastResult = { error: String(err.message || err) };
  } finally {
    running = false;
    await render();
  }
}

card.addEventListener("click", (e) => {
  if (e.target.closest("[data-act='ai-run']")) {
    run();
    return;
  }
  // Clicking the header (anywhere but the Run button) collapses/expands the result.
  if (e.target.closest("[data-act='ai-toggle']")) toggleCollapse();
});

/**
 * @param {() => ({summary, cpuPercent}|null)} getLastFn — accessor for the latest scan.
 */
export function initAIUI(getLastFn) {
  getLast = getLastFn;
  render();
}

/** Re-render the card (e.g. after the API key is added/removed in settings). */
export function refreshAICard() {
  render();
}
