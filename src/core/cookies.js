// cookies.js — read & manage cookies for the active tab via chrome.cookies.
//
// "First-party" here means cookies readable for the tab's own URL. "Third-party
// tracker cookies" are found by asking the cookie store about the specific
// ad/tracker domains the page contacted (from trackers.js) — so we report only
// cookies actually relevant to what you're looking at, not the whole browser jar.

import { registrableDomain } from "./trackers.js";

/** Bytes a cookie occupies (name + value), a reasonable "weight" proxy. */
function cookieBytes(c) {
  return (c.name?.length || 0) + (c.value?.length || 0);
}

/** True if the page URL is something we can read cookies for. */
export function isInspectableUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

/**
 * Summarize the cookies the active page can see (first-party).
 * @returns {Promise<object|null>} null if the URL isn't inspectable.
 */
export async function summarizeSiteCookies(url) {
  if (!isInspectableUrl(url)) return null;
  let cookies = [];
  try {
    cookies = await chrome.cookies.getAll({ url });
  } catch {
    return null;
  }

  let bytes = 0;
  let httpOnly = 0;
  let secure = 0;
  let session = 0; // no expiry — cleared when the browser closes
  const sameSite = { strict: 0, lax: 0, none: 0, unspecified: 0 };

  for (const c of cookies) {
    bytes += cookieBytes(c);
    if (c.httpOnly) httpOnly++;
    if (c.secure) secure++;
    if (c.session || c.expirationDate == null) session++;
    const ss = (c.sameSite || "unspecified").replace("no_restriction", "none");
    sameSite[ss in sameSite ? ss : "unspecified"]++;
  }

  return {
    count: cookies.length,
    bytes,
    httpOnly,
    secure,
    session,
    persistent: cookies.length - session,
    sameSite,
    names: cookies.map((c) => c.name).slice(0, 40),
  };
}

/**
 * For each tracker registrable domain the page contacted, see whether it has
 * cookies in the store. Reveals which trackers have actually planted state.
 * @param {string[]} domains registrable tracker domains (from analyzeTrackers)
 */
export async function trackerCookieSummary(domains = []) {
  const unique = [...new Set(domains.map((d) => registrableDomain(d)))].slice(0, 25);
  const perDomain = [];
  let totalCookies = 0;

  // Query the domains concurrently; a failure on one shouldn't sink the rest.
  const results = await Promise.all(
    unique.map(async (domain) => {
      try {
        const list = await chrome.cookies.getAll({ domain });
        return { domain, count: list.length };
      } catch {
        return { domain, count: 0 };
      }
    })
  );

  for (const r of results) {
    if (r.count > 0) {
      perDomain.push(r);
      totalCookies += r.count;
    }
  }
  perDomain.sort((a, b) => b.count - a.count);

  return {
    domainsWithCookies: perDomain.length,
    totalCookies,
    perDomain,
  };
}

/** Build the URL chrome.cookies.remove needs from a cookie's own fields. */
function removalUrl(c) {
  const host = (c.domain || "").replace(/^\./, "");
  const scheme = c.secure ? "https" : "http";
  return `${scheme}://${host}${c.path || "/"}`;
}

/**
 * Clear every first-party cookie for the active site.
 * @returns {Promise<number>} how many cookies were removed.
 */
export async function clearSiteCookies(url) {
  if (!isInspectableUrl(url)) return 0;
  let cookies = [];
  try {
    cookies = await chrome.cookies.getAll({ url });
  } catch {
    return 0;
  }

  let removed = 0;
  await Promise.all(
    cookies.map(async (c) => {
      try {
        await chrome.cookies.remove({
          url: removalUrl(c),
          name: c.name,
          storeId: c.storeId,
        });
        removed++;
      } catch {
        /* a cookie we couldn't remove — skip it */
      }
    })
  );
  return removed;
}
