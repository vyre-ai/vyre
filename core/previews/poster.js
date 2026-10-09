// @ts-check
// previews/poster: the picture on a preview's card where no browser is at hand. It is drawn from the page's own HTML, without rendering it: the
// <title>, the first heading, the page's own background colour (theme-color, or what its stylesheet gives body) and a stand-in hue when it names none.
// It reads as "this is your page", not as a placeholder. Everything taken from the page is cut to a short plain string and escaped, and colours
// pass a strict pattern, so the SVG can carry no script, no link and nothing else of the page's.

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i;
const NAMED = /** @type {Record<string, string>} */ ({ white: "#ffffff", black: "#000000", red: "#dc2626", blue: "#2563eb", green: "#16a34a", gray: "#6b7280", grey: "#6b7280", navy: "#1e3a8a", teal: "#0d9488", orange: "#ea580c", purple: "#7c3aed", pink: "#db2777", yellow: "#facc15" });

/** A colour the page names, as #rrggbb, or null. @param {string} v */
export function colour(v) {
  const s = String(v || "").trim().toLowerCase();
  if (HEX.test(s)) return s.length === 4 ? "#" + [...s.slice(1)].map(c => c + c).join("") : s;
  const m = RGB.exec(s);
  if (m && [m[1], m[2], m[3]].every(n => Number(n) <= 255)) return "#" + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, "0")).join("");
  return NAMED[s] || null;
}
const lum = (/** @type {string} */ h) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const text = (/** @type {string} */ s, max) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&[#\w]+;/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const esc = (/** @type {string} */ s) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));

/** What the poster uses from a page: { title, heading, bg } (each possibly empty). @param {string} html */
export function readPage(html) {
  const h = String(html || "").slice(0, 200_000);
  const title = text((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1] || "", 80);
  const heading = text((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(h) || /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(h) || [])[1] || "", 110);
  let bg = null;
  const theme = /<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i.exec(h) || /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["']/i.exec(h);
  if (theme) bg = colour(theme[1]);
  if (!bg) for (const css of h.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const m = /(?:^|[}\s,])(?:body|html|:root)\s*(?:,\s*[\w.:#-]+\s*)*\{[^}]*?background(?:-color)?\s*:\s*([^;}]+)/i.exec(css[1]);
    if (m) { const first = (/#[0-9a-f]{3,6}\b|rgba?\([^)]*\)|\b[a-z]+\b/i.exec(m[1]) || [])[0]; bg = first ? colour(first) : null; if (bg) break; }
  }
  if (!bg) { const m = /<body[^>]+style=["'][^"']*background(?:-color)?\s*:\s*([^;"']+)/i.exec(h); if (m) bg = colour(m[1]); }
  return { title, heading, bg };
}

/** Break words into lines of at most `n` characters, at most `rows` of them (the last ends in an ellipsis when cut). @param {string} s @param {number} n @param {number} rows */
function wrap(s, n, rows) {
  const lines = []; let cur = "";
  for (const w of s.split(" ").filter(Boolean)) {
    if ((cur + " " + w).trim().length > n && cur) { lines.push(cur); cur = w.slice(0, n); } else cur = (cur + " " + w).trim().slice(0, n);
  }
  if (cur) lines.push(cur);
  if (lines.length > rows) { lines.length = rows; lines[rows - 1] = lines[rows - 1].replace(/.{0,2}$/, "") + "..."; }
  return lines;
}

/** A stand-in background hue from the title, soft enough to sit behind dark text. @param {string} seed */
function hueOf(seed) { let x = 0; for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0; const h = x % 360; const s = 0.35, l = 0.9, a = s * Math.min(l, 1 - l); const f = (/** @type {number} */ n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return "#" + [f(0), f(8), f(4)].map(n => n.toString(16).padStart(2, "0")).join(""); }

/**
 * The poster as an SVG string (800 by 500).
 * @param {{ html?: string, title?: string }} o  html: the page's source if there is one; title: the preview's own name, used when the page has none
 */
export function poster({ html = "", title = "" }) {
  const p = readPage(html);
  const name = p.title || p.heading || text(title, 80) || "Preview";
  const sub = p.heading && p.heading !== name ? p.heading : "";
  const bg = p.bg || hueOf(name);
  const dark = lum(bg) < 0.5;
  const ink = dark ? "#f6f5f1" : "#171716", soft = dark ? "#c9c7be" : "#5b5a55", line = dark ? "#ffffff" : "#000000";
  const big = wrap(name, 26, 3), small = sub ? wrap(sub, 46, 2) : [];
  let y = 250 - (big.length - 1) * 30 - (small.length ? 18 : 0);
  const out = [];
  for (const l of big) { out.push(`<text x="64" y="${y}" font-size="56" font-weight="700" fill="${ink}">${esc(l)}</text>`); y += 64; }
  y -= 8;
  for (const l of small) { y += 34; out.push(`<text x="64" y="${y}" font-size="26" fill="${soft}">${esc(l)}</text>`); }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500" font-family="-apple-system, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif"><rect width="800" height="500" fill="${bg}"/><rect x="24" y="24" width="752" height="452" rx="22" fill="none" stroke="${line}" stroke-opacity="0.12" stroke-width="2"/><circle cx="64" cy="64" r="6" fill="${soft}" fill-opacity="0.5"/><circle cx="86" cy="64" r="6" fill="${soft}" fill-opacity="0.35"/><circle cx="108" cy="64" r="6" fill="${soft}" fill-opacity="0.2"/>${out.join("")}</svg>`;
}
