// profile.js — turn two DevTools Performance readings into "how busy is this tab".
//
// Chrome's Performance.getMetrics counters (TaskDuration, ScriptDuration, …) are
// cumulative since the page loaded, so one reading only says how much work ever
// happened. Two readings a few seconds apart give the rate: the share of wall time
// the tab's renderer main thread spent busy, and what it was busy with.
//
// Checked against Chrome 156: a page built to keep its main thread 50% busy read
// 49.9% from TaskDuration (49.6% of it script). ThreadTime and ProcessTime are
// deliberately not used — in the same test they read 70% and 45%, so they aren't a
// trustworthy "CPU %". Same-site tabs can share a renderer process, so its main
// thread's load can include their work too.

/** Round a percentage to one decimal place. */
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {Object<string, number>} before  metrics (name -> value) from the first reading
 * @param {Object<string, number>} after   metrics from the second reading
 * @returns the window length plus busy percentages (null when Chrome didn't report
 *          a counter) and point-in-time page figures from the second reading.
 */
export function summarizeProfile(before, after) {
  const wall = (after.Timestamp ?? 0) - (before.Timestamp ?? 0); // seconds, monotonic
  const delta = (k) => (k in before && k in after ? Math.max(0, after[k] - before[k]) : null);
  const pct = (seconds) => (seconds == null || wall <= 0 ? null : round1((seconds / wall) * 100));

  const task = delta("TaskDuration");
  const script = delta("ScriptDuration");
  const layout = delta("LayoutDuration");
  const style = delta("RecalcStyleDuration");
  // Busy time not spent in script, layout, or style: parsing, painting prep, GC, …
  const other = task == null ? null : Math.max(0, task - (script || 0) - (layout || 0) - (style || 0));
  const mb = (bytes) => (bytes ? Math.round(bytes / 1048576) : null);

  return {
    sampleSeconds: round1(wall),
    mainThreadPct: pct(task),
    scriptPct: pct(script),
    layoutPct: pct(layout),
    stylePct: pct(style),
    otherPct: pct(other),
    layouts: delta("LayoutCount"),
    jsHeapMB: mb(after.JSHeapUsedSize),
    jsHeapTotalMB: mb(after.JSHeapTotalSize),
    nodes: after.Nodes ?? null,
    listeners: after.JSEventListeners ?? null,
    frames: after.Frames ?? null,
    adFrames: after.AdSubframes ?? null, // iframes Chrome itself has tagged as ads
  };
}
