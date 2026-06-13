// current-tab-ui.js — the "Current Tab" inspector card.
//
// Shows ads/trackers and cookies for whatever tab you're actually looking at.
// Tracker data comes from the probe's reported hostnames (in storage.session,
// classified by core/trackers.js); cookie data comes live from chrome.cookies.
// Self-contained, like automation-ui: its own listeners + paced refresh, so it
// stays in sync as you switch tabs without touching the main scan loop.

import { esc } from "../shared/summary-view.js";
import { PERF_LIVE_KEY } from "../../core/constants.js";
import { analyzeTrackers, CATEGORY_LABELS } from "../../core/trackers.js";
import {
  summarizeSiteCookies,
  trackerCookieSummary,
  clearSiteCookies,
  isInspectableUrl,
} from "../../core/cookies.js";

const card = document.getElementById("current-tab");

let expanded = false; // detail (domain + cookie lists) open?
let lastUrl = null; // collapse detail automatically when the tab changes
let busy = false; // guard against overlapping renders

// Cookie queries are comparatively expensive — summarizeSiteCookies plus up to ~25
// chrome.cookies.getAll calls for the tracker probe. The cookie picture only changes
// on navigation, reload, or an explicit clear, NOT on the 5s heartbeat. So we cache
// the results: the idle refresh just recomputes the (in-memory) tracker view and
// reuses the cached cookies, while tab switches / reloads / clears invalidate the
// cache to force a fresh read. First-party cookies key on the url; tracker cookies
// key on the exact set of tracker domains queried (which grows as the probe reports).
let cookieCache = { url: null, summary: null };
let trackerCookieCache = { key: null, summary: null };

function invalidateCookieCache() {
  cookieCache = { url: null, summary: null };
  trackerCookieCache = { key: null, summary: null };
}

async function cookiesFor(url) {
  if (cookieCache.url === url) return cookieCache.summary;
  const summary = await summarizeSiteCookies(url);
  cookieCache = { url, summary };
  return summary;
}

async function trackerCookiesFor(domains) {
  const key = [...domains].sort().join(",");
  if (trackerCookieCache.key === key) return trackerCookieCache.summary;
  const summary = await trackerCookieSummary(domains);
  trackerCookieCache = { key, summary };
  return summary;
}

/** The active tab in the user's focused window. */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

/** Read the probe's latest hostnames for a tab from session storage. */
async function resourceHostsFor(tabId) {
  const wrap = await chrome.storage.session.get(PERF_LIVE_KEY);
  const live = (wrap[PERF_LIVE_KEY] || {})[tabId];
  return live?.resourceHosts || null;
}

function readout(value, label, hot = false) {
  return `<div class="readout"><span class="rv${hot ? " hot" : ""}">${value}</span><span class="rl">${label}</span></div>`;
}

function detailSection(trackers, trackerCookies, cookies) {
  const parts = [];

  if (trackers.thirdParties.length) {
    const items = trackers.thirdParties
      .map((d) => {
        const tag = d.category
          ? `<span class="ct-tag ${d.category}">${esc(CATEGORY_LABELS[d.category])}</span>`
          : `<span class="ct-tag third">3rd-party</span>`;
        return `<li><span class="ct-dom">${esc(d.domain)}</span>${tag}</li>`;
      })
      .join("");
    parts.push(`<div class="ct-sub">Third-party domains</div><ul class="ct-list">${items}</ul>`);
  }

  if (trackerCookies.perDomain.length) {
    const items = trackerCookies.perDomain
      .map((d) => `<li><span class="ct-dom">${esc(d.domain)}</span><span class="ct-n">${d.count}</span></li>`)
      .join("");
    parts.push(`<div class="ct-sub">Tracker cookies</div><ul class="ct-list">${items}</ul>`);
  }

  if (cookies && cookies.count) {
    const kv = [
      ["secure", cookies.secure],
      ["httponly", cookies.httpOnly],
      ["session", cookies.session],
      ["persistent", cookies.persistent],
      ["samesite none", cookies.sameSite.none],
      ["size", `${(cookies.bytes / 1024).toFixed(1)} KB`],
    ];
    parts.push(
      `<div class="ct-sub">First-party cookies</div><div class="kv-grid">${kv
        .map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
        .join("")}</div>`
    );
  }

  return `<div class="ct-detail">${parts.join("") || '<span class="d-empty">// nothing to show</span>'}</div>`;
}

function shell(inner, { showClear = false } = {}) {
  const clear = showClear
    ? `<button class="act danger" data-act="clear-cookies" title="Delete this site's cookies">clear cookies</button>`
    : "";
  card.hidden = false;
  card.innerHTML = `
    <div class="ct-head">
      <span class="ct-mark"></span>
      <span class="ct-title">CURRENT TAB</span>
      <span class="ct-slot">${clear}</span>
    </div>
    ${inner}`;
}

async function render() {
  if (busy) return;
  busy = true;
  try {
    const tab = await activeTab();
    if (!tab || !isInspectableUrl(tab.url)) {
      lastUrl = null;
      shell(`<div class="ct-empty">// no inspectable page in view</div>`);
      return;
    }

    if (tab.url !== lastUrl) {
      expanded = false; // fresh page — start collapsed
      lastUrl = tab.url;
    }

    const hosts = await resourceHostsFor(tab.id);
    const trackers = analyzeTrackers(hosts || [], tab.url);
    const cookies = await cookiesFor(tab.url);
    const trackerCookies = await trackerCookiesFor(
      trackers.trackerDomains.map((d) => d.domain)
    );

    const gathering = hosts == null;
    const cluster =
      `<div class="ct-cluster${expanded ? " open" : ""}" data-act="toggle">` +
      readout(gathering ? "…" : trackers.totals.ads, "ads", trackers.totals.ads > 0) +
      readout(gathering ? "…" : trackers.totals.trackers, "trackers", trackers.totals.trackers > 0) +
      readout(gathering ? "…" : trackers.totals.thirdParties, "3rd-party") +
      readout(cookies ? cookies.count : "—", "cookies", cookies && cookies.count > 0) +
      `</div>`;

    const host = esc(trackers.pageDomain || tab.url);
    const note = gathering
      ? `<div class="ct-note">${host} · gathering page data…</div>`
      : `<div class="ct-note">${host}${
          trackerCookies.totalCookies
            ? ` · ${trackerCookies.totalCookies} tracker cookie${trackerCookies.totalCookies > 1 ? "s" : ""}`
            : ""
        }</div>`;

    const detail = expanded ? detailSection(trackers, trackerCookies, cookies) : "";
    shell(note + cluster + detail, { showClear: !!(cookies && cookies.count) });
  } catch (err) {
    shell(`<div class="ct-empty">// inspector error: ${esc(String(err.message || err))}</div>`);
  } finally {
    busy = false;
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

card.addEventListener("click", async (e) => {
  if (e.target.closest("[data-act='clear-cookies']")) {
    const tab = await activeTab();
    if (tab && confirm(`Delete all cookies for ${tab.url ? new URL(tab.url).hostname : "this site"}?`)) {
      const n = await clearSiteCookies(tab.url);
      console.info(`Vantage: cleared ${n} cookie(s)`);
      invalidateCookieCache(); // cookies just changed — force a fresh read
      render();
    }
    return;
  }
  if (e.target.closest("[data-act='toggle']")) {
    expanded = !expanded;
    render();
  }
});

// Re-render promptly when the user switches or reloads tabs. Both are points where
// cookies may have changed (different site, or a reload of the same url), so drop
// the cookie cache before re-reading. The plain 5s heartbeat keeps the cache.
chrome.tabs.onActivated.addListener(() => {
  invalidateCookieCache();
  render();
});
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && (info.status === "complete" || info.url)) {
    invalidateCookieCache();
    render();
  }
});

/** Start the inspector: paint now, then keep it fresh on a gentle interval. */
export function initCurrentTabUI() {
  render();
  let timer = setInterval(render, 5000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(timer);
    } else {
      render();
      timer = setInterval(render, 5000);
    }
  });
}
