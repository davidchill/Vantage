// info-layer.js — the floating help layer: hover tooltips for telemetry items
// (anything carrying data-tip) and a click-to-open "ⓘ" pop-up that explains a
// whole section (any [data-info] button → SECTION_INFO[id]).
//
// Both surfaces are appended to <body>, NOT into #content, so the 5s live
// re-render never wipes them mid-read — the same reason deep-result / ai-card
// live outside #content. Hover uses event delegation, so it keeps working across
// re-renders for free; the pop-up, once open, floats on its own and isn't tied to
// the header button (which gets replaced on the next scan).

import { SECTION_INFO } from "./explainers.js";

const GAP = 8; // px between an anchor and its tooltip/pop-up
const MARGIN = 6; // keep this far from the viewport edge

let tipEl = null;
let popEl = null;
let openInfoId = null; // which section pop-up is open (null = none)

/** Clamp a left coord so a `width`-wide box stays fully on-screen. */
function clampLeft(left, width) {
  return Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
}

// ── Hover tooltip ────────────────────────────────────────────────────────────

function showTip(anchor) {
  const text = anchor.getAttribute("data-tip");
  if (!text) return hideTip();
  tipEl.textContent = text;
  // Render offscreen first so we can measure it, then place it.
  tipEl.style.left = "-9999px";
  tipEl.style.top = "0";
  tipEl.hidden = false;

  const a = anchor.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  const left = clampLeft(a.left + a.width / 2 - t.width / 2, t.width);
  let top = a.top - t.height - GAP; // prefer above
  if (top < MARGIN) top = a.bottom + GAP; // …else below
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

// ── Section pop-up ─────────────────────────────────────────────────────────────

function openInfo(id, btn) {
  const info = SECTION_INFO[id];
  if (!info) return;
  popEl.innerHTML =
    `<button class="info-close" data-info-close title="Close">✕</button>` +
    `<div class="info-title">${info.title}</div>` +
    `<p class="info-what">${info.what}</p>` +
    `<div class="info-sub">How to read it</div>` +
    `<ul class="info-list">${info.interpret.map((li) => `<li>${li}</li>`).join("")}</ul>`;

  // Measure offscreen, then anchor below the button, clamped to the viewport.
  popEl.style.left = "-9999px";
  popEl.style.top = "0";
  popEl.hidden = false;
  const b = btn.getBoundingClientRect();
  const p = popEl.getBoundingClientRect();
  const left = clampLeft(b.left, p.width);
  let top = b.bottom + GAP; // prefer below the button
  if (top + p.height > window.innerHeight - MARGIN && b.top - p.height - GAP > MARGIN) {
    top = b.top - p.height - GAP; // flip above if it would overflow the bottom
  }
  popEl.style.left = `${left}px`;
  popEl.style.top = `${top}px`;
  openInfoId = id;
}

function closeInfo() {
  if (popEl) popEl.hidden = true;
  openInfoId = null;
}

/**
 * Wire up the floating help layer. Call once on panel start; it self-manages
 * across the live re-render via document-level delegation.
 */
export function initInfoLayer() {
  tipEl = document.createElement("div");
  tipEl.className = "tip";
  tipEl.hidden = true;
  popEl = document.createElement("div");
  popEl.className = "info-pop";
  popEl.hidden = true;
  document.body.append(tipEl, popEl);

  // Tooltips: show on any data-tip element, hide the moment the pointer leaves it
  // (covers the re-render case — the replaced node simply stops matching).
  document.addEventListener("mouseover", (e) => {
    const anchor = e.target.closest?.("[data-tip]");
    if (anchor) showTip(anchor);
    else hideTip();
  });

  // Keyboard parity: tooltips on focus, and Esc closes the pop-up.
  document.addEventListener("focusin", (e) => {
    const anchor = e.target.closest?.("[data-tip]");
    if (anchor) showTip(anchor);
  });
  document.addEventListener("focusout", hideTip);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeInfo();
  });

  // Section pop-up: a [data-info] button toggles it; clicking its ✕ or anywhere
  // outside closes it.
  document.addEventListener("click", (e) => {
    const infoBtn = e.target.closest?.("[data-info]");
    if (infoBtn) {
      const id = infoBtn.getAttribute("data-info");
      if (openInfoId === id) closeInfo();
      else openInfo(id, infoBtn);
      return;
    }
    if (e.target.closest?.("[data-info-close]")) return closeInfo();
    if (openInfoId && !e.target.closest?.(".info-pop")) closeInfo();
  });

  // A floating box anchored to a now-scrolled element is stale — drop both on any
  // scroll, and reposition nothing (cheaper and less jumpy than tracking).
  window.addEventListener(
    "scroll",
    () => {
      hideTip();
      closeInfo();
    },
    true
  );
}
