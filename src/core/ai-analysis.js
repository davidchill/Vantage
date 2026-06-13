// ai-analysis.js — optional, on-demand AI read of the current monitoring state.
//
// Everything else in Vantage is local and free. This is the one feature that
// reaches out: it ships the already-analyzed summary to the Anthropic API and
// asks Claude for a plain-English verdict plus concrete suggestions. It's gated
// behind a user-supplied API key (storage.local) and only runs when the user
// clicks "Run analysis" — never automatically, so it never costs money silently.
//
// We send the analyzer's OUTPUT (titles, origins, metrics), not raw page content.
// Structured outputs constrain the reply to a small JSON shape the panel renders.

import {
  AI_API_URL,
  AI_API_VERSION,
  AI_MAX_TOKENS,
  AI_DEFAULT_MODEL,
} from "./constants.js";
import { getSettings } from "./settings.js";

// The shape we force the model to return — a headline plus a ranked list of
// suggestions. Structured outputs guarantee valid JSON, so the panel can render
// it without defensive parsing. (No min/maxItems — not supported; we ask in prose.)
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: {
      type: "string",
      description: "One sentence summarizing the browser's current health.",
    },
    suggestions: {
      type: "array",
      description: "Concrete, prioritized actions the user can take right now.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "Short imperative action." },
          detail: {
            type: "string",
            description:
              "1-2 sentences: what to do and why, naming the specific tab/site/extension when relevant.",
          },
          severity: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["title", "detail", "severity"],
      },
    },
  },
  required: ["headline", "suggestions"],
};

const SYSTEM_PROMPT = [
  "You are a browser-performance analyst embedded in a Chrome extension called Vantage.",
  "You receive a JSON snapshot of the user's current browser state: a health verdict,",
  "memory/CPU load, the heaviest tabs, pages janking or leaking memory, sites that have",
  "been chronically straining over time, installed extensions, duplicates, and idle tabs.",
  "",
  "Analyze it and return a brief headline plus 3-6 prioritized, concrete suggestions.",
  "Be specific: name the actual tab title, site origin, or extension when you can, and",
  "say what to do (sleep it, close duplicates, disable an extension, reload a leaking tab).",
  "Rank by real impact — measured jank, background CPU, and memory growth matter most;",
  "idle/duplicate cleanup is lower. If the browser looks healthy, say so plainly and keep",
  "suggestions light. Do not invent data that isn't in the snapshot. Be concise and",
  "practical — no preamble, no restating the raw numbers back.",
].join(" ");

/** Trim the full summary down to the signal worth sending (keeps the payload small). */
function buildSnapshot(summary, cpuPercent) {
  const perf = summary.performance || {};
  const pick = (arr, fn) => (arr || []).slice(0, 8).map(fn);

  return {
    health: summary.health
      ? { level: summary.health.level, factors: summary.health.factors.map((f) => f.label) }
      : null,
    cpuPercent,
    memory: summary.memory && {
      usedPercent: summary.memory.usedPercent,
      usedGB: +(summary.memory.usedBytes / 1024 ** 3).toFixed(1),
      totalGB: +(summary.memory.capacityBytes / 1024 ** 3).toFixed(1),
    },
    totals: summary.totals,
    heavyTabs: pick(summary.heavyTabs, (t) => ({
      title: t.title,
      reason: t.reason,
      blockingMs: t.blockingMs,
      jsHeapMB: t.jsHeapMB,
      idleMinutes: t.idleMinutes,
    })),
    jankingNow: pick(perf.live, (a) => ({ title: a.title, blockingMs: a.blockingMs })),
    backgroundDrain: pick(perf.background, (b) => ({
      title: b.title,
      blockingHiddenMs: b.blockingHiddenMs,
    })),
    leaks: pick(perf.leaks, (l) => ({
      title: l.title,
      growthMB: l.growthMB,
      spanMin: l.spanMin,
      currentMB: l.currentMB,
    })),
    chronicStrain: pick(perf.chronic, (c) => ({
      origin: c.origin,
      strainScans: c.strainScans,
      worstStreak: c.maxStreak,
      mostly: c.topLabel,
      openNow: c.open,
    })),
    tendHeavy: pick(perf.predictions, (p) => ({
      origin: p.origin,
      avgBlockingMs: p.avgBlockingMs,
      issues: p.poorVitals,
    })),
    extensions: summary.extensions && {
      enabled: summary.extensions.enabled,
      broadAccess: (summary.extensions.list || [])
        .filter((e) => e.breadth === "broad")
        .slice(0, 12)
        .map((e) => e.name),
    },
    duplicateSets: (summary.duplicates || []).length,
    idleTabs: (summary.idleTabs || []).length,
    crowdedDomains: pick(summary.heavyDomains, (d) => ({ host: d.host, tabs: d.count })),
  };
}

/** Turn an HTTP error body into a short, human message for the panel. */
function describeError(status, body) {
  const apiMsg = body?.error?.message;
  switch (status) {
    case 401:
      return "Invalid API key — check it in settings (⚙).";
    case 403:
      return "This API key isn't permitted to use that model.";
    case 404:
      return "Model not found — pick a different model in settings.";
    case 429:
      return "Rate limited by Anthropic — wait a moment and try again.";
    case 529:
      return "Anthropic is overloaded right now — try again shortly.";
    default:
      if (status >= 500) return "Anthropic had a server error — try again shortly.";
      return apiMsg || `Request failed (HTTP ${status}).`;
  }
}

/**
 * Run an analysis of the given summary. Returns { headline, suggestions, model }.
 * Throws an Error with a user-friendly message on any failure.
 */
export async function runAnalysis(summary, cpuPercent) {
  const settings = await getSettings();
  const apiKey = settings.ai.apiKey.trim();
  if (!apiKey) {
    throw new Error("Add an Anthropic API key in settings (⚙) to enable AI analysis.");
  }
  const model = settings.ai.model || AI_DEFAULT_MODEL;
  const snapshot = buildSnapshot(summary, cpuPercent);

  let resp;
  try {
    resp = await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": AI_API_VERSION,
        // Required to call the API from a browser/extension context (CORS opt-in).
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: AI_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        messages: [
          {
            role: "user",
            content:
              "Here is the current browser snapshot. Analyze it and return your structured assessment.\n\n" +
              JSON.stringify(snapshot, null, 2),
          },
        ],
      }),
    });
  } catch {
    // Network-level failure (offline, DNS, blocked).
    throw new Error("Couldn't reach the Anthropic API — check your connection.");
  }

  if (!resp.ok) {
    let body = null;
    try {
      body = await resp.json();
    } catch {
      /* non-JSON error body */
    }
    throw new Error(describeError(resp.status, body));
  }

  const data = await resp.json();
  const text = (data.content || []).find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Empty response from the model — try again.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Couldn't parse the model's response — try again.");
  }

  return {
    headline: parsed.headline || "",
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    model,
  };
}
