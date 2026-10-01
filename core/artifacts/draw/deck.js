// @ts-check
// A deck artifact: Markdown slides split on a line of dashes, drawn at 16:9 in container units so
// one slide scales from the 340 px panel to a full screen. One look, no colour, no per-deck
// themes. Layouts come from the Markdown: title, bullets, a single big number, a quote, two columns
// (split on a line of three dots) and an image with a caption. Speaker notes follow a "Notes:" line.
// Images are data URIs only; a remote image makes that one slide an error, the rest still draw.
// The design is the agent's: a line `@theme {json}` anywhere sets the deck's colours, fonts and a
// brand mark (logo: {src: data URI, position: top-left|top-right|bottom-left|bottom-right, size}),
// and a line `@slide {json}` inside a slide sets that slide's background colour or data-URI image,
// text colour, font, alignment and vertical position. Vyre's own look is the default. Values are
// checked in theme.js, so style can colour and lay out but never load anything.
// Static: the filmstrip and the previous and next links are anchors to #s1, #s2 ..., Notes is a
// checkbox, nothing runs a script.

import { esc, markdown } from "../render.js";
import { themeCss, colorOf, fontOf, dataImageOf, lengthOf } from "./theme.js";

/** @typedef {{ html: string, notes: string, bad?: string }} Slide */

const IMG = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const BIG = /^[+\-–]?[$€£]?\d[\d.,]*\s?(?:%|x|k|m|bn|[A-Za-z]{0,2})$/;


/** A slide's own look from its @slide object, every value checked. @param {any} sd */
function slideStyle(sd) {
  if (!sd || typeof sd !== "object" || Array.isArray(sd)) return "";
  const css = [];
  const bg = colorOf(sd.bg || sd.background), color = colorOf(sd.color || sd.text), font = fontOf(sd.font), img = dataImageOf(sd.image);
  if (bg) css.push(`background:${bg}`);
  if (img) css.push(`background-image:url(${img})`, `background-size:${sd.fit === "contain" ? "contain" : "cover"}`, "background-position:center", "background-repeat:no-repeat");
  if (color) css.push(`--text:${color}`, `--t2:${color}`, `--label:${color}`);
  if (font) css.push(`--font:${font}`, `font-family:${font}`);
  if (["left", "center", "right"].includes(sd.align)) css.push(`--align:${sd.align}`);
  if (["top", "center", "bottom"].includes(sd.valign)) css.push(`--valign:${{ top: "flex-start", center: "center", bottom: "flex-end" }[/** @type {"top"|"center"|"bottom"} */ (sd.valign)]}`);
  const pad = lengthOf(sd.padding, 0, 30); if (pad) css.push(`--pad:${parseFloat(pad)}cqw`);
  return css.join(";");
}

/** The deck's theme as a style element; a slide's ground is the theme's bg or background. @param {any} t */
function deckTheme(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return "";
  const fix = (/** @type {any} */ o) => { if (!o || typeof o !== "object" || Array.isArray(o)) return o; const x = { ...o }; if (x.bg || x.background) { x.slide = x.slide || x.bg || x.background; delete x.bg; delete x.background; } return x; };
  const f = fix(t); f.light = fix(t.light); f.dark = fix(t.dark);
  return themeCss(f);
}

/** The brand mark on every slide, if the theme gives one as a data URI. @param {any} t */
function logoOf(t) {
  const l = t && typeof t === "object" ? t.logo : null;
  const src = l && dataImageOf(l.src);
  if (!src) return "";
  const pos = { "top-left": "tl", "top-right": "tr", "bottom-left": "bl", "bottom-right": "br" }[/** @type {"top-left"} */ (l.position)] || "br";
  const size = lengthOf(l.size, 2, 40);
  return `<img class="logo ${pos}" alt="${esc(String(l.alt || "").slice(0, 80))}" src="${src}" style="width:${size ? parseFloat(size) : 8}cqw">`;
}

/** @param {string} md @param {boolean} first */
function drawOne(md, first) {
  let all = md.replace(/\r\n?/g, "\n").split("\n");
  /** @type {any} */ let sd = null;
  all = all.filter(l => { const m = /^@slide\s+(\{.*\})\s*$/.exec(l.trim()); if (!m) return true; try { sd = JSON.parse(m[1]); } catch {} return false; });
  const style = slideStyle(sd);
  const at = all.findIndex(l => /^notes?:\s*/i.test(l));
  const notes = at < 0 ? "" : [all[at].replace(/^notes?:\s*/i, ""), ...all.slice(at + 1)].join("\n").trim();
  const lines = (at < 0 ? all : all.slice(0, at));
  const text = lines.join("\n").trim();
  if (!text) return { html: "", notes, empty: true, style };
  const remote = lines.find(l => IMG.test(l.trim()) && !/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test((IMG.exec(l.trim()) || [])[2] || ""));
  if (remote) return { html: "", notes, bad: "It includes an image that is not inside the deck. Vyre never fetches a remote image.", style };
  const imgs = lines.map(l => IMG.exec(l.trim())).filter(Boolean);
  const plain = lines.filter(l => !IMG.test(l.trim()));
  if (imgs.length === 1 && !plain.some(l => l.trim())) {
    const m = /** @type {RegExpExecArray} */ (imgs[0]);
    return { html: `<figure><img alt="${esc(m[1])}" src="${esc(m[2])}">${m[1] ? `<figcaption>${esc(m[1])}</figcaption>` : ""}</figure>`, notes, style };
  }
  const body = plain.join("\n");
  const cols = body.split(/\n\s*\.{3}\s*\n/);
  if (cols.length === 2) return { html: `<div class="cols"><div>${markdown(cols[0])}</div><div>${markdown(cols[1])}</div></div>`, notes, style };
  const h = /^#{1,6}\s+(.*)$/m.exec(body);
  const rest = body.replace(/^#{1,6}\s+.*$/m, "").trim();
  if (h && BIG.test(h[1].trim()) && h[1].trim().length <= 9) return { html: `<p class="big">${esc(h[1].trim())}</p>${rest ? markdown(rest) : ""}`, notes, style };
  if (/^>\s?/.test(body.trim()) && !h) return { html: markdown(body), notes, style };
  if (first && h) {
    const before = body.slice(0, body.indexOf(h[0])).trim();
    const sub = body.slice(body.indexOf(h[0]) + h[0].length).trim();
    return { html: `${before ? `<p class="eyebrow">${esc(before.split("\n")[0])}</p>` : ""}<h1>${esc(h[1])}</h1>${sub ? markdown(sub) : ""}`, notes, style };
  }
  return { html: markdown(body).replace(/<h1>/g, "<h2>").replace(/<\/h1>/g, "</h2>"), notes, style };
}

/**
 * @param {string} title @param {string} src
 * @returns {string} the page body
 */
export function drawDeck(title, src) {
  /** @type {any} */ let theme = null;
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n").filter(l => { const m = /^@theme\s+(\{.*\})\s*$/.exec(l.trim()); if (!m) return true; if (!theme) try { theme = JSON.parse(m[1]); } catch {} return false; });
  const logo = logoOf(theme);
  const parts = lines.join("\n").replace(/\r\n?/g, "\n").split(/\n-{3,}[ \t]*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
  const slides = parts.map((p, i) => drawOne(p, i === 0)).filter(s => !s.empty);
  if (!slides.length) return `<h1>${esc(title)}</h1><div class="state" role="status"><b>No slides yet</b><span>The deck has no slide separators or text.</span></div>`;
  const n = slides.length;
  const face = (/** @type {any} */ s, /** @type {number} */ i) => s.bad
    ? `<div class="slide"${s.style ? ` style="${s.style}"` : ""}>${logo}<div class="sc"><h2>Slide ${i + 1} cannot be shown</h2><p>${esc(s.bad)}</p></div></div>`
    : `<div class="slide"${s.style ? ` style="${s.style}"` : ""}>${logo}<div class="sc">${s.html}</div></div>`;
  const frames = slides.map((s, i) => `<div class="frame${i === 0 ? " first" : ""}" id="s${i + 1}">${face(s, i)}
<div class="nav"><a href="#s${Math.max(1, i)}"${i === 0 ? ' class="off" aria-disabled="true"' : ""}>Previous</a><span>${i + 1} of ${n}</span><a href="#s${Math.min(n, i + 2)}"${i === n - 1 ? ' class="off" aria-disabled="true"' : ""}>Next</a><span class="sp"></span><label for="sn">Notes</label></div>
<div class="notes">${s.notes ? esc(s.notes) : "No notes for this slide."}</div></div>`).reverse().join(""); // the first slide comes last, so a targeted slide can hide it with a sibling selector
  const strip = slides.map((s, i) => `<a href="#s${i + 1}" aria-label="Slide ${i + 1}"><b>${i + 1}</b>${face(s, i).replace(/<h1>/g, "<h2>").replace(/<\/h1>/g, "</h2>")}</a>`).join("");
  return `${deckTheme(theme)}<div class="deck"><input class="r" type="checkbox" id="sn"><div class="stage" aria-label="${esc(title)}, ${n} slides">${frames}</div><div class="strip">${strip}</div></div>`;
}
