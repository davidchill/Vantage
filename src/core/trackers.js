// trackers.js — classify the hostnames a page contacted into ads / trackers.
//
// We don't use webRequest (the very "broad API" Vantage's analyzer flags in other
// extensions). Instead the in-page probe reports the unique hostnames the page
// loaded resources from, and we match each against a curated database of common
// ad/analytics/social/fingerprinting endpoints. It's a representative list, not
// an exhaustive blocklist — enough to answer "what's tracking me on this page".

// Registrable-domain → category. Matching is suffix-based, so "doubleclick.net"
// also catches "stats.g.doubleclick.net", "ad.doubleclick.net", etc.
export const TRACKER_DB = {
  // ── Advertising ──────────────────────────────────────────────────────────
  "doubleclick.net": "ads",
  "googlesyndication.com": "ads",
  "googleadservices.com": "ads",
  "google-analytics.com": "analytics",
  "adservice.google.com": "ads",
  "2mdn.net": "ads",
  "amazon-adsystem.com": "ads",
  "adnxs.com": "ads",
  "adsrvr.org": "ads",
  "rubiconproject.com": "ads",
  "pubmatic.com": "ads",
  "openx.net": "ads",
  "criteo.com": "ads",
  "criteo.net": "ads",
  "taboola.com": "ads",
  "outbrain.com": "ads",
  "casalemedia.com": "ads",
  "smartadserver.com": "ads",
  "advertising.com": "ads",
  "yieldmo.com": "ads",
  "moatads.com": "ads",
  "adform.net": "ads",
  "teads.tv": "ads",
  "media.net": "ads",
  "sharethrough.com": "ads",
  "bidswitch.net": "ads",
  "3lift.com": "ads",
  "gumgum.com": "ads",
  "indexww.com": "ads",
  "districtm.io": "ads",
  "adroll.com": "ads",
  "adsymptotic.com": "ads",
  "spotxchange.com": "ads",
  "contextweb.com": "ads",

  // ── Analytics / measurement ──────────────────────────────────────────────
  "googletagmanager.com": "analytics",
  "googletagservices.com": "ads",
  "scorecardresearch.com": "analytics",
  "quantserve.com": "analytics",
  "hotjar.com": "analytics",
  "mixpanel.com": "analytics",
  "segment.com": "analytics",
  "segment.io": "analytics",
  "amplitude.com": "analytics",
  "fullstory.com": "analytics",
  "mouseflow.com": "analytics",
  "newrelic.com": "analytics",
  "nr-data.net": "analytics",
  "chartbeat.com": "analytics",
  "chartbeat.net": "analytics",
  "parsely.com": "analytics",
  "branch.io": "analytics",
  "optimizely.com": "analytics",
  "crazyegg.com": "analytics",
  "clarity.ms": "analytics",
  "cdn.heapanalytics.com": "analytics",
  "heapanalytics.com": "analytics",
  "kissmetrics.com": "analytics",
  "yandex.ru": "analytics",
  "mc.yandex.ru": "analytics",
  "matomo.cloud": "analytics",
  "statcounter.com": "analytics",

  // ── Social / share widgets (often tracking too) ──────────────────────────
  "facebook.net": "social",
  "facebook.com": "social",
  "connect.facebook.net": "social",
  "twitter.com": "social",
  "ads-twitter.com": "social",
  "t.co": "social",
  "linkedin.com": "social",
  "licdn.com": "social",
  "pinterest.com": "social",
  "pinimg.com": "social",
  "tiktok.com": "social",
  "snapchat.com": "social",
  "sc-static.net": "social",
  "reddit.com": "social",
  "redditstatic.com": "social",

  // ── Tag/consent/other trackers ───────────────────────────────────────────
  "onetrust.com": "other",
  "cookielaw.org": "other",
  "trustarc.com": "other",
  "quantcast.com": "other",
  "demdex.net": "other",
  "omtrdc.net": "other",
  "everesttech.net": "other",
  "bluekai.com": "other",
  "krxd.net": "other",
  "agkn.com": "other",
  "rlcdn.com": "other",
  "crwdcntrl.net": "other",
  "tapad.com": "other",
  "bounceexchange.com": "other",
};

export const CATEGORY_LABELS = {
  ads: "Ads",
  analytics: "Analytics",
  social: "Social",
  other: "Trackers",
};

// Multi-part public suffixes we special-case so "example.co.uk" groups as one
// registrable domain rather than "co.uk". Not exhaustive — covers the common ones.
const MULTI_SUFFIX = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "or.jp", "ne.jp",
  "com.au", "net.au", "org.au", "co.nz", "com.br", "com.cn", "com.mx",
  "co.in", "co.za", "com.tr", "com.sg", "com.hk",
]);

/** Best-effort registrable domain (eTLD+1) without a full public-suffix list. */
export function registrableDomain(host) {
  if (!host) return host;
  const parts = host.replace(/\.$/, "").split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_SUFFIX.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}

/** Return the tracker category for a host, or null if it isn't a known tracker. */
export function classifyHost(host) {
  if (!host) return null;
  const h = host.toLowerCase();
  // Direct registrable-domain hit, then suffix match for sub-domained endpoints.
  const reg = registrableDomain(h);
  if (TRACKER_DB[reg]) return TRACKER_DB[reg];
  for (const domain in TRACKER_DB) {
    if (h === domain || h.endsWith("." + domain)) return TRACKER_DB[domain];
  }
  return null;
}

/**
 * Turn the probe's raw host list into a structured view for the current tab.
 * @param {string[]} hosts  unique resource hostnames (already excludes page host)
 * @param {string}   pageUrl the active tab's URL (to fix the first-party domain)
 */
export function analyzeTrackers(hosts = [], pageUrl = "") {
  let pageDomain = "";
  try {
    pageDomain = registrableDomain(new URL(pageUrl).hostname);
  } catch {
    /* opaque / non-web URL */
  }

  const thirdSeen = new Map(); // registrable domain -> { domain, category|null }
  for (const host of hosts) {
    const reg = registrableDomain(host.toLowerCase());
    if (!reg || reg === pageDomain) continue; // same-site is first-party
    const category = classifyHost(host);
    // Keep the strongest signal if we've seen this domain before.
    const prev = thirdSeen.get(reg);
    if (!prev || (!prev.category && category)) thirdSeen.set(reg, { domain: reg, category });
  }

  const thirdParties = [...thirdSeen.values()].sort((a, b) =>
    a.domain.localeCompare(b.domain)
  );
  const trackerDomains = thirdParties.filter((d) => d.category);

  const categoryCounts = { ads: 0, analytics: 0, social: 0, other: 0 };
  for (const d of trackerDomains) categoryCounts[d.category]++;

  return {
    pageDomain,
    thirdParties, // every distinct third-party registrable domain
    trackerDomains, // the subset classified as ad/tracker
    categoryCounts,
    totals: {
      thirdParties: thirdParties.length,
      trackers: trackerDomains.length,
      ads: categoryCounts.ads,
    },
  };
}
