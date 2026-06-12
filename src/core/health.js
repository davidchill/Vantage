// health.js — synthesize every signal into one verdict + the top culprits.
//
// Severity scale: 3 = serious, 2 = notable, 1 = minor. The level is derived
// from the summed severity so that one serious issue, or several notable ones,
// tips Chrome from "Good" into "Strained"/"Heavy".

export function computeHealth({
  memoryPercent,
  tabCount,
  backgroundDrain,
  leaks,
  liveJank,
  heavyOrigins,
}) {
  const factors = [];
  const add = (label, severity) => factors.push({ label, severity });
  const plural = (n) => (n > 1 ? "s" : "");

  if (memoryPercent >= 85) add(`System memory at ${memoryPercent}%`, 3);
  else if (memoryPercent >= 70) add(`System memory at ${memoryPercent}%`, 2);

  if (tabCount >= 70) add(`${tabCount} tabs open`, 3);
  else if (tabCount >= 40) add(`${tabCount} tabs open`, 2);

  if (backgroundDrain > 0)
    add(`${backgroundDrain} background tab${plural(backgroundDrain)} using CPU`, 3);
  if (leaks > 0) add(`${leaks} tab${plural(leaks)} growing in memory`, 2);
  if (liveJank > 0) add(`${liveJank} tab${plural(liveJank)} janky right now`, 2);
  if (heavyOrigins > 0) add(`${heavyOrigins} heavy site${plural(heavyOrigins)} open`, 1);

  const score = factors.reduce((s, f) => s + f.severity, 0);
  let level = "Good";
  if (score >= 5) level = "Heavy";
  else if (score >= 2) level = "Strained";

  factors.sort((a, b) => b.severity - a.severity);
  return { level, score, factors: factors.slice(0, 3) };
}
