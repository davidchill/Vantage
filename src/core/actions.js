// actions.js — the layer that actually changes Chrome's state.
// Everything here re-reads live tab state at call time (rather than trusting a
// cached summary) so we never act on a tab id that's gone stale.

import { collectSnapshot } from "./collector.js";
import { analyze } from "./analyzer.js";

/** Put a single tab to sleep (unloads it from memory, keeps it in the tab strip). */
export async function sleepTab(id) {
  try {
    await chrome.tabs.discard(id);
  } catch {
    // Already discarded, or it's the active tab in its window — safe to ignore.
  }
}

/** Close one or more tabs. */
export async function closeTabs(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length) await chrome.tabs.remove(list);
  return list.length;
}

/**
 * Given tab ids that point at the same page, keep the most-recently-used one
 * and close the rest.
 * @returns number of tabs closed.
 */
export async function closeExtras(ids) {
  const tabs = (
    await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))
  ).filter(Boolean);
  if (tabs.length < 2) return 0;

  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const doomed = tabs.slice(1).map((t) => t.id);
  await chrome.tabs.remove(doomed);
  return doomed.length;
}

/** Sleep every currently-idle tab that isn't already asleep. */
export async function sleepAllIdle() {
  const summary = analyze(await collectSnapshot());
  const ids = summary.idleTabs.filter((t) => !t.discarded).map((t) => t.id);
  for (const id of ids) await sleepTab(id);
  return ids.length;
}

/** Close the redundant copies in every duplicate set, keeping the best of each. */
export async function closeAllDuplicateExtras() {
  const summary = analyze(await collectSnapshot());
  let closed = 0;
  for (const set of summary.duplicates) {
    closed += await closeExtras(set.tabIds);
  }
  return closed;
}
