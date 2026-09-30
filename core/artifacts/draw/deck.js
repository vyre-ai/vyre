// @ts-check
// A deck artifact: Markdown slides split on a line of dashes, drawn at 16:9 in container units so
// one slide scales from the 340 px panel to a full screen. One look, no colour, no per-deck
// themes. Layouts come from the Markdown: title, bullets, a single big number, a quote, two columns
// (split on a line of three dots) and an image with a caption. Speaker notes follow a "Notes:" line.
// Images are data URIs only; a remote image makes that one slide an error, the rest still draw.
// Static: the filmstrip and the previous and next links are anchors to #s1, #s2 ..., Notes is a
// checkbox, nothing runs a script.

import { esc, markdown } from "../render.js";

/** @typedef {{ html: string, notes: string, bad?: string }} Slide */

const IMG = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const BIG = /^[+\-–]?[$€£]?\d[\d.,]*\s?(?:%|x|k|m|bn|[A-Za-z]{0,2})$/;

/** @param {string} md @param {boolean} first */
function drawOne(md, first) {
  const all = md.replace(/\r\n?/g, "\n").split("\n");
  const at = all.findIndex(l => /^notes?:\s*/i.test(l));
  const notes = at < 0 ? "" : [all[at].replace(/^notes?:\s*/i, ""), ...all.slice(at + 1)].join("\n").trim();
  const lines = (at < 0 ? all : all.slice(0, at));
  const text = lines.join("\n").trim();
  if (!text) return { html: "", notes, empty: true };
  const remote = lines.find(l => IMG.test(l.trim()) && !/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test((IMG.exec(l.trim()) || [])[2] || ""));
  if (remote) return { html: "", notes, bad: "It includes an image that is not inside the deck. Vyre never fetches a remote image." };
  const imgs = lines.map(l => IMG.exec(l.trim())).filter(Boolean);
  const plain = lines.filter(l => !IMG.test(l.trim()));
  if (imgs.length === 1 && !plain.some(l => l.trim())) {
    const m = /** @type {RegExpExecArray} */ (imgs[0]);
    return { html: `<figure><img alt="${esc(m[1])}" src="${esc(m[2])}">${m[1] ? `<figcaption>${esc(m[1])}</figcaption>` : ""}</figure>`, notes };
  }
  const body = plain.join("\n");
  const cols = body.split(/\n\s*\.{3}\s*\n/);
  if (cols.length === 2) return { html: `<div class="cols"><div>${markdown(cols[0])}</div><div>${markdown(cols[1])}</div></div>`, notes };
  const h = /^#{1,6}\s+(.*)$/m.exec(body);
  const rest = body.replace(/^#{1,6}\s+.*$/m, "").trim();
  if (h && BIG.test(h[1].trim()) && h[1].trim().length <= 9) return { html: `<p class="big">${esc(h[1].trim())}</p>${rest ? markdown(rest) : ""}`, notes };
  if (/^>\s?/.test(body.trim()) && !h) return { html: markdown(body), notes };
  if (first && h) {
    const before = body.slice(0, body.indexOf(h[0])).trim();
    const sub = body.slice(body.indexOf(h[0]) + h[0].length).trim();
    return { html: `${before ? `<p class="eyebrow">${esc(before.split("\n")[0])}</p>` : ""}<h1>${esc(h[1])}</h1>${sub ? markdown(sub) : ""}`, notes };
  }
  return { html: markdown(body).replace(/<h1>/g, "<h2>").replace(/<\/h1>/g, "</h2>"), notes };
}

/**
 * @param {string} title @param {string} src
 * @returns {string} the page body
 */
export function drawDeck(title, src) {
  const parts = String(src).replace(/\r\n?/g, "\n").split(/\n-{3,}[ \t]*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
  const slides = parts.map((p, i) => drawOne(p, i === 0)).filter(s => !s.empty);
  if (!slides.length) return `<h1>${esc(title)}</h1><div class="state" role="status"><b>No slides yet</b><span>The deck has no slide separators or text.</span></div>`;
  const n = slides.length;
  const face = (/** @type {any} */ s, /** @type {number} */ i) => s.bad
    ? `<div class="slide"><div class="sc"><h2>Slide ${i + 1} cannot be shown</h2><p>${esc(s.bad)}</p></div></div>`
    : `<div class="slide"><div class="sc">${s.html}</div></div>`;
  const frames = slides.map((s, i) => `<div class="frame${i === 0 ? " first" : ""}" id="s${i + 1}">${face(s, i)}
<div class="nav"><a href="#s${Math.max(1, i)}"${i === 0 ? ' class="off" aria-disabled="true"' : ""}>Previous</a><span>${i + 1} of ${n}</span><a href="#s${Math.min(n, i + 2)}"${i === n - 1 ? ' class="off" aria-disabled="true"' : ""}>Next</a><span class="sp"></span><label for="sn">Notes</label></div>
<div class="notes">${s.notes ? esc(s.notes) : "No notes for this slide."}</div></div>`).reverse().join(""); // the first slide comes last, so a targeted slide can hide it with a sibling selector
  const strip = slides.map((s, i) => `<a href="#s${i + 1}" aria-label="Slide ${i + 1}"><b>${i + 1}</b>${face(s, i).replace(/<h1>/g, "<h2>").replace(/<\/h1>/g, "</h2>")}</a>`).join("");
  return `<div class="deck"><input class="r" type="checkbox" id="sn"><div class="stage" aria-label="${esc(title)}, ${n} slides">${frames}</div><div class="strip">${strip}</div></div>`;
}
