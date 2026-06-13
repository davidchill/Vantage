// collector.js — gathers raw data from Chrome's APIs.
// No analysis here; this layer just answers "what is currently true?".

import { getPerf } from "./perf-store.js";
import { getStrainHistory } from "./strain-history.js";

/**
 * Take a point-in-time snapshot of tabs, groups, and system memory.
 * CPU usage is sampled separately (see sampleCpuPercent) because it needs
 * two readings over a short interval to produce a percentage.
 */
export async function collectSnapshot() {
  const [tabs, groups, memory, extensions, perf, strainHistory] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups?.query ? chrome.tabGroups.query({}) : Promise.resolve([]),
    chrome.system.memory.getInfo(),
    collectExtensions(),
    getPerf(),
    getStrainHistory(),
  ]);

  return {
    tabs,
    groups,
    memory,
    extensions,
    perfLive: perf.live,
    perfHistory: perf.history,
    strainHistory,
    takenAt: Date.now(),
  };
}

/**
 * List installed browser extensions (excluding themes/apps and this extension
 * itself). Returns [] if the management permission isn't available.
 *
 * Note: Chrome does not expose per-extension memory/CPU to other extensions on
 * the stable channel, so this is an inventory — resource impact is inferred
 * from permission breadth in the analyzer, not measured.
 */
export async function collectExtensions() {
  if (!chrome.management?.getAll) return [];
  try {
    const all = await chrome.management.getAll();
    const selfId = chrome.runtime.id;
    const exts = all.filter((e) => e.type === "extension" && e.id !== selfId);
    return Promise.all(
      exts.map(async (e) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        enabled: e.enabled,
        installType: e.installType, // admin | development | normal | sideload | other
        mayDisable: e.mayDisable, // false => force-installed by policy
        description: e.description,
        iconUrl: pickIcon(e.icons),
        hostPermissions: e.hostPermissions || [],
        permissions: e.permissions || [],
        permissionWarnings: await permissionWarningsFor(e.id, e.version),
      }))
    );
  } catch {
    return [];
  }
}

/** Pick a crisp ~16px icon URL from an extension's icon set. */
function pickIcon(icons) {
  if (!icons || !icons.length) return null;
  const sorted = [...icons].sort((a, b) => a.size - b.size);
  return (sorted.find((i) => i.size >= 16) || sorted[sorted.length - 1]).url;
}

// Permission warnings never change unless the extension updates, so cache them
// by id@version — otherwise we'd re-query on every 5s panel refresh.
const warningsCache = new Map();
async function permissionWarningsFor(id, version) {
  const key = `${id}@${version}`;
  if (warningsCache.has(key)) return warningsCache.get(key);
  let warnings = [];
  try {
    warnings = await chrome.management.getPermissionWarningsById(id);
  } catch {
    warnings = [];
  }
  warningsCache.set(key, warnings);
  return warnings;
}

/**
 * Estimate overall CPU usage as a percentage.
 *
 * chrome.system.cpu.getInfo() reports cumulative tick counters per core, so a
 * single reading is meaningless. We take two readings `ms` apart and look at how
 * much of the elapsed time was spent NOT idle.
 *
 * @returns {Promise<number|null>} 0-100, or null if it can't be computed.
 */
export async function sampleCpuPercent(ms = 300) {
  const a = await chrome.system.cpu.getInfo();
  await new Promise((resolve) => setTimeout(resolve, ms));
  const b = await chrome.system.cpu.getInfo();

  let totalDelta = 0;
  let idleDelta = 0;
  for (let i = 0; i < b.processors.length; i++) {
    const before = a.processors[i].usage;
    const after = b.processors[i].usage;
    totalDelta += after.total - before.total;
    idleDelta += after.idle - before.idle;
  }

  if (totalDelta <= 0) return null;
  return Math.round((1 - idleDelta / totalDelta) * 100);
}
