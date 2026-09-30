// @ts-check
// A dashboard artifact: a chart spec plus its data, drawn by Vyre as a Chart tab (line or bar, at
// most three series told apart by line style, marker shape and direct labels, never colour), stat
// tiles and a Table tab every chart has. Pure and static: the tabs are radio inputs, the hover is
// CSS, nothing runs a script.
//
// Spec (JSON): { "type": "line" | "bar", "x": "month", "series": ["referrals", {"key": "consults", "name": "Consults"}],
//   "title": "...", "unit": "%" }. Missing x is the first column; missing series are the numeric columns.
// Data (JSON): an array of row objects, or { "rows": [...] }.

import { esc } from "../render.js";

const MAX_SERIES = 3, MAX_ROWS = 500;
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
/** @param {unknown} v */ const num = v => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
/** @param {unknown} v */ const show = v => (v == null ? "" : num(v) !== null && typeof v !== "string" ? nf.format(/** @type {number} */ (v)) : String(v));

/** @param {string} title @param {string} body */
const state = (title, body) => `<div class="state" role="status"><b>${esc(title)}</b><span>${body}</span></div>`;

/** A round axis top and three ticks. @param {number} max */
function niceMax(max) {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max)), f = max / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/**
 * Parse and check, never throw: the answer is either the chart's parts or what is wrong in words.
 * @param {string} specText @param {string} dataText
 */
export function readChart(specText, dataText) {
  /** @type {any} */ let spec, data;
  try { spec = JSON.parse(specText || "{}"); } catch { return { error: ["Cannot draw this chart", "The chart spec is not valid JSON."] }; }
  try { data = JSON.parse(dataText || "[]"); } catch { return { error: ["Cannot draw this chart", "The data file is not valid JSON."] }; }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { error: ["Cannot draw this chart", "The chart spec must be a JSON object."] };
  const rowsIn = Array.isArray(data) ? data : data && Array.isArray(data.rows) ? data.rows : null;
  if (!rowsIn) return { error: ["Cannot draw this chart", "The data file must be a list of rows."] };
  const rows = rowsIn.filter((/** @type {any} */ r) => r && typeof r === "object" && !Array.isArray(r)).slice(0, MAX_ROWS);
  if (!rows.length) return { empty: true, spec };
  const cols = [...new Set(rows.flatMap((/** @type {any} */ r) => Object.keys(r)))].slice(0, 12);
  const x = typeof spec.x === "string" ? spec.x : cols[0];
  if (!cols.includes(x)) return { error: ["Cannot draw this chart", `The data file has no column <code>${esc(x)}</code>. The table view still shows what is there.`], rows, cols };
  const given = Array.isArray(spec.series) ? spec.series : null;
  /** @type {{ key: string, name: string }[]} */
  const series = (given || cols.filter(c => c !== x && rows.some((/** @type {any} */ r) => num(r[c]) !== null))).map((/** @type {any} */ s) => typeof s === "string" ? { key: s, name: s.charAt(0).toUpperCase() + s.slice(1) } : { key: String(s && s.key), name: String((s && (s.name || s.key)) || "") });
  for (const s of series) if (!cols.includes(s.key)) return { error: ["Cannot draw this chart", `The data file has no column <code>${esc(s.key)}</code>. The table view still shows what is there.`], rows, cols };
  if (!series.length) return { error: ["Cannot draw this chart", "There is no numeric column to draw. The table view still shows what is there."], rows, cols };
  return { spec, rows, cols, x, series };
}

const MARKS = [
  (/** @type {number} */ cx, /** @type {number} */ cy) => `<circle class="ring" cx="${cx}" cy="${cy}" r="4" fill="var(--s1)"/>`,
  (/** @type {number} */ cx, /** @type {number} */ cy) => `<rect class="ring" x="${cx - 4}" y="${cy - 4}" width="8" height="8" rx="2" fill="var(--s2)"/>`,
  (/** @type {number} */ cx, /** @type {number} */ cy) => `<path class="ring" d="M${cx} ${cy - 5}L${cx + 5} ${cy + 4}L${cx - 5} ${cy + 4}Z" stroke-linejoin="round" fill="var(--bo)" style="stroke:var(--t2)"/>`,
];
const DASH = ["", "6 4", "1.5 4"];
const COLOR = ["var(--s1)", "var(--s2)", "var(--t2)"];

/** @param {any} c @param {string} aria */
function svgChart(c, aria) {
  const { rows, x, series, spec } = c;
  const W = 308, H = 190, L = 4, R = 76, T = 14, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const vals = series.map((/** @type {any} */ s) => rows.map((/** @type {any} */ r) => num(r[s.key])));
  const top = niceMax(Math.max(0, ...vals.flat().filter((/** @type {any} */ v) => v !== null)));
  const n = rows.length, bar = spec.type === "bar";
  const xAt = (/** @type {number} */ i) => L + (bar ? pw * (i + 0.5) / n : n === 1 ? pw / 2 : pw * i / (n - 1));
  const yAt = (/** @type {number} */ v) => T + ph - ph * v / top;
  const out = [`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">`];
  for (const t of [0, top / 2, top]) out.push(`<line class="grid" x1="${L}" x2="${L + pw}" y1="${yAt(t)}" y2="${yAt(t)}"/>`);
  // y ticks sit at the left inside the plot, so the direct labels own the right.
  for (const t of [0, top / 2, top]) out.push(`<text x="${L}" y="${yAt(t) - 3}">${nf.format(t)}</text>`);
  const every = Math.ceil(n / 6);
  rows.forEach((/** @type {any} */ r, /** @type {number} */ i) => { if (i % every === 0 || i === n - 1 && n < 7) out.push(`<text x="${xAt(i)}" y="${H - 8}" text-anchor="middle">${esc(show(r[x]).slice(0, 10))}</text>`); });
  if (bar) {
    const k = series.length, gap = 2, bw = Math.max(3, Math.min(28, pw / n / k - gap));
    series.forEach((/** @type {any} */ s, /** @type {number} */ si) => vals[si].forEach((/** @type {number|null} */ v, /** @type {number} */ i) => {
      if (v === null) return;
      const bx = xAt(i) - (k * (bw + gap) - gap) / 2 + si * (bw + gap), by = yAt(Math.max(v, 0)), bh = Math.max(1, yAt(0) - by);
      const last = i === n - 1;
      const fill = k === 1 ? (last ? "var(--s1)" : "var(--bo)") : COLOR[si];
      out.push(`<path d="M${bx} ${by + bh}V${by + 4}a4 4 0 0 1 4 -4H${bx + bw - 4}a4 4 0 0 1 4 4V${by + bh}Z" fill="${fill}"${si === 2 ? ' style="stroke:var(--t2)" stroke-dasharray="2 2"' : ""}/>`);
      if (last && k === 1) out.push(`<text class="v" x="${bx + bw / 2}" y="${by - 4}" text-anchor="middle">${esc(nf.format(v))}</text>`);
    }));
  } else {
    series.forEach((/** @type {any} */ s, /** @type {number} */ si) => {
      const pts = vals[si].map((/** @type {number|null} */ v, /** @type {number} */ i) => v === null ? null : [xAt(i), yAt(v)]).filter(Boolean);
      if (!pts.length) return;
      out.push(`<path d="M${pts.map((/** @type {any} */ p) => p.join(" ")).join("L")}" fill="none" stroke="${COLOR[si]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${DASH[si] ? ` stroke-dasharray="${DASH[si]}"` : ""}/>`);
      for (const p of /** @type {number[][]} */ (pts)) out.push(MARKS[si](p[0], p[1]));
      const end = /** @type {number[]} */ (pts[pts.length - 1]), lastV = vals[si][vals[si].length - 1];
      out.push(`<text class="v" x="${end[0] + 9}" y="${end[1] - 1}">${esc(show(lastV))}</text><text class="nm" x="${end[0] + 9}" y="${end[1] + 10}">${esc(s.name.slice(0, 12))}</text>`);
    });
  }
  // One chip per x: hover, or keyboard focus, lists every series at that point.
  rows.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
    const cx = xAt(i), bw = pw / n, tx = Math.min(Math.max(cx - 58, 0), W - 120), lines = [show(r[x]), ...series.map((/** @type {any} */ s) => `${s.name}  ${show(r[s.key])}`)];
    out.push(`<rect class="hit" tabindex="0" x="${cx - bw / 2}" y="${T}" width="${bw}" height="${ph}"/><g class="tip"><line x1="${cx}" x2="${cx}" y1="${T}" y2="${T + ph}"/><rect x="${tx}" y="${T - 12}" width="118" height="${8 + lines.length * 14}" rx="6"/>${lines.map((l, j) => `<text x="${tx + 8}" y="${T + 1 + j * 14}" style="font-weight:${j ? 400 : 600}">${esc(l.slice(0, 22))}</text>`).join("")}</g>`);
  });
  out.push("</svg>");
  return out.join("");
}

/** @param {any} c */
function stats(c) {
  const { rows, x, series } = c;
  if (rows.length < 1) return "";
  const last = rows[rows.length - 1], prev = rows.length > 1 ? rows[rows.length - 2] : null;
  return `<div class="stats">${series.slice(0, 2).map((/** @type {any} */ s) => {
    const a = num(last[s.key]), b = prev ? num(prev[s.key]) : null;
    const d = a !== null && b !== null ? a - b : null;
    const change = d === null ? "" : d === 0 ? `same as ${esc(show(prev[x]))}` : `${d > 0 ? "up" : "down"} ${nf.format(Math.abs(d))} on ${esc(show(prev[x]))}`;
    return `<div class="stat"><div class="l">${esc(s.name)}, ${esc(show(last[x]))}</div><div class="n">${esc(show(last[s.key]))}</div><div class="c">${change}</div></div>`;
  }).join("")}</div>`;
}

/** @param {string[]} cols @param {any[]} rows */
function table(cols, rows) {
  return `<table class="data"><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td${num(r && r[c]) !== null && typeof (r && r[c]) !== "string" ? ' class="num"' : ""}>${esc(show(r && r[c]))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

/**
 * @param {string} title @param {string} specText @param {string} dataText
 * @returns {string} the page body (inside .pbody)
 */
export function drawChart(title, specText, dataText) {
  const c = /** @type {any} */ (readChart(specText, dataText));
  const head = `<h1>${esc(c.spec && c.spec.title ? String(c.spec.title) : title)}</h1>`;
  if (c.empty) return head + state("Nothing to draw yet", "The agent made this dashboard but has not added its data.");
  if (c.error) return head + state(c.error[0], c.error[1]) + (c.rows ? table(c.cols, c.rows) : "");
  const drawn = c.series.slice(0, MAX_SERIES);
  const extra = c.series.length > MAX_SERIES ? `<div class="note">Showing ${MAX_SERIES} of ${c.series.length} series. The table has all of them.</div>` : "";
  const cc = { ...c, series: drawn };
  const legend = `<div class="legend">${drawn.map((/** @type {any} */ s, /** @type {number} */ i) => `<span><svg viewBox="0 0 24 10" aria-hidden="true"><line x1="0" x2="24" y1="5" y2="5" stroke="${COLOR[i]}" stroke-width="2"${DASH[i] ? ` stroke-dasharray="${DASH[i]}"` : ""}/></svg>${esc(s.name)}</span>`).join("")}</div>`;
  return `${head}<input class="r" type="radio" name="vt" id="vt-chart" checked><input class="r" type="radio" name="vt" id="vt-table">
<div class="tabs"><label for="vt-chart">Chart</label><label for="vt-table">Table</label></div>
<div class="pane-chart">${stats(cc)}${svgChart(cc, `${title}: ${drawn.map((/** @type {any} */ s) => s.name).join(", ")} by ${c.x}`)}${legend}${extra}</div>
<div class="pane-table">${table(c.cols, c.rows)}</div>`;
}
