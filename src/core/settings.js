// settings.js — the user's auto-management configuration.
//
// One source of truth, read by both the service worker (to decide whether/how to
// act each scan) and the panel (to render and edit the form). Stored in
// storage.local so it survives restarts. The whole feature ships OFF by default —
// nothing is ever auto-slept or auto-closed until the user opts in.

import {
  SETTINGS_KEY,
  DEFAULT_SUSTAIN_MINUTES,
  AI_DEFAULT_MODEL,
} from "./constants.js";

// A "trigger" pairs a strain signal (from analyzer.performance.*) with what to do
// about it. action is "sleep" (reversible) or "close" (destructive). Triggers can
// be individually toggled; the master `enabled` gates the whole engine.
export const DEFAULT_SETTINGS = {
  enabled: false, // master switch — automation does nothing until this is true
  sustainMinutes: DEFAULT_SUSTAIN_MINUTES,
  triggers: {
    // Hidden tabs burning CPU. Clearest waste, safest to act on.
    backgroundDrain: { enabled: true, action: "sleep" },
    // Tabs whose JS heap keeps climbing. Sleeping reclaims the memory.
    leak: { enabled: true, action: "sleep" },
  },
  // Optional AI analysis. apiKey empty = feature off (the panel shows a prompt to
  // add one). The key lives only in storage.local on this machine.
  ai: {
    apiKey: "",
    model: AI_DEFAULT_MODEL,
  },
};

// Human-facing labels for each trigger kind (used in the UI and the action log).
export const TRIGGER_LABELS = {
  backgroundDrain: "Background CPU drain",
  leak: "Memory leak",
};

/** Deep-merge stored settings over the defaults so new fields get sane values. */
function withDefaults(stored) {
  const s = stored || {};
  const triggers = {};
  for (const key of Object.keys(DEFAULT_SETTINGS.triggers)) {
    triggers[key] = { ...DEFAULT_SETTINGS.triggers[key], ...(s.triggers?.[key] || {}) };
  }
  return {
    enabled: s.enabled ?? DEFAULT_SETTINGS.enabled,
    sustainMinutes: clampSustain(s.sustainMinutes),
    triggers,
    ai: {
      apiKey: typeof s.ai?.apiKey === "string" ? s.ai.apiKey : "",
      model: s.ai?.model || DEFAULT_SETTINGS.ai.model,
    },
  };
}

/** Keep the sustain window sane: at least 1 minute, no upper-bound surprises. */
function clampSustain(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SETTINGS.sustainMinutes;
  return Math.min(n, 120);
}

/** Read the current settings, always fully-populated. */
export async function getSettings() {
  const wrap = await chrome.storage.local.get(SETTINGS_KEY);
  return withDefaults(wrap[SETTINGS_KEY]);
}

/** Persist a settings object (normalized through the defaults first). */
export async function saveSettings(next) {
  const clean = withDefaults(next);
  await chrome.storage.local.set({ [SETTINGS_KEY]: clean });
  return clean;
}
