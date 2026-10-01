// @ts-check
// SVG artifacts are cleaned: shapes, text, gradients, filters, patterns, inline styles and a style
// element, and brand marks as data-URI images, all stay, because an SVG's design is its agent's. What
// goes: scripts, event handlers, links, foreign content, animation, use (a chain of references can
// expand without bound), an image that is not a data URI,
// and any style that loads or escapes (url() to anywhere but #id, @import, expression, escapes).
// The panel says when something was removed. The result is only ever shown through <img>, which
// runs nothing and loads nothing, so this is a second lock, not the only one.

/** Allowed elements, lowercase to the case SVG needs. A Map: no inherited names. `use` is not here: chains of references can expand without bound. */
const ELEMENTS = new Map(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath", "defs", "linearGradient", "radialGradient", "stop", "title", "desc", "marker", "clipPath", "mask", "pattern", "symbol", "filter", "feGaussianBlur", "feOffset", "feFlood", "feComposite", "feMerge", "feMergeNode", "feColorMatrix", "feBlend", "feDropShadow", "image", "style"].map(n => [n.toLowerCase(), n]));
const DROP_WITH_CONTENT = new Set(["script", "foreignobject", "iframe", "object", "embed", "audio", "video", "animate", "set", "animatetransform", "animatemotion", "animatecolor", "handler", "listener"]);
const ATTR_OK = /^(?:id|class|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|d|points|transform|viewbox|preserveaspectratio|xmlns|version|fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|stroke-dasharray|stroke-dashoffset|stroke-miterlimit|opacity|offset|stop-color|stop-opacity|gradientunits|gradienttransform|patternunits|patterncontentunits|patterntransform|fx|fy|fr|font-family|font-size|font-weight|font-style|font-variant|text-anchor|dominant-baseline|alignment-baseline|letter-spacing|word-spacing|text-decoration|markerwidth|markerheight|refx|refy|orient|markerunits|marker-start|marker-mid|marker-end|clip-path|clip-rule|clippathunits|mask|maskunits|maskcontentunits|filter|filterunits|primitiveunits|stddeviation|in|in2|result|flood-color|flood-opacity|operator|k1|k2|k3|k4|mode|values|type|dx|dy|rotate|textlength|lengthadjust|xml:space|display|visibility|vector-effect|shape-rendering|text-rendering|image-rendering|mix-blend-mode|isolation|startoffset|spreadmethod|media)$/i;

/** A style value that can only draw: no url() but to #id, no @import, escapes, markup or script. @param {string} v */
const unsafeCss = v => /url\s*\(\s*["']?\s*(?!#)|image-set|cross-fade|\b(?:src|image|element|paint)\s*\(|@import|@font-face|@namespace|expression\s*\(|behavior|-moz-binding|javascript:|vbscript:|\\|<|&#|\/\*/i.test(v);
/** An attribute value that can only draw. @param {string} v */
const badValue = v => unsafeCss(v) || /data:|&\w+;/i.test(v);
const DATA_IMG = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;


/**
 * A linear scan of markup into text, tags and junk, never backtracking: a tag ends at the first `>`
 * outside quotes, and anything unterminated ends the document. (A regex here was quadratic on a
 * document of many `<` and no `>`: reviewer-2 HIGH.)
 * @param {string} text
 * @returns {Generator<{ text?: string, name?: string, closing?: boolean, attrs?: string, junk?: boolean }>}
 */
function* tokens(text) {
  const n = text.length;
  const NAME = /<(\/?)([A-Za-z][\w:-]*)/y;
  let i = 0;
  while (i < n) {
    if (text[i] !== "<") { let j = text.indexOf("<", i); if (j < 0) j = n; yield { text: text.slice(i, j) }; i = j; continue; }
    const skip = text.startsWith("<!--", i) ? ["-->", 4] : text.startsWith("<![CDATA[", i) ? ["]]>", 9] : text.startsWith("<?", i) ? ["?>", 2] : text.startsWith("<!", i) ? [">", 2] : null;
    if (skip) { const j = text.indexOf(/** @type {string} */ (skip[0]), i + /** @type {number} */ (skip[1])); if (j < 0) return; i = j + /** @type {string} */ (skip[0]).length; yield {}; continue; }
    NAME.lastIndex = i;
    const m = NAME.exec(text);
    if (!m) { yield { junk: true }; i++; continue; }
    let k = i + m[0].length, end = -1;
    while (k < n) {
      const ch = text[k];
      if (ch === ">") { end = k; break; }
      if (ch === '"' || ch === "'") { const q = text.indexOf(ch, k + 1); if (q < 0) return; k = q + 1; continue; }
      k++;
    }
    if (end < 0) return;
    yield { closing: m[1] === "/", name: m[2], attrs: text.slice(i + m[0].length, end) };
    i = end + 1;
  }
}

/**
 * @param {string} src
 * @returns {{ svg: string, removed: { scripts: number, links: number, other: number } }}
 */
export function cleanSvg(src) {
  const removed = { scripts: 0, links: 0, other: 0 };
  const out = [];
  const text = String(src).slice(0, 5 * 1024 * 1024);
  let skipDepth = 0, skipName = "", styleBuf = /** @type {string|null} */ (null);
  for (const m of tokens(text)) {
    if (m.text !== undefined) {
      if (skipDepth) continue;
      if (styleBuf !== null) { styleBuf += m.text; continue; }
      out.push(m.text.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, "&amp;").replace(/>/g, "&gt;"));
      continue;
    }
    if (m.name === undefined) { if (m.junk) removed.other++; continue; } // comments, the XML declaration and a doctype go without a word
    const closing = m.closing, name = m.name.toLowerCase().replace(/^svg:/, ""), selfClose = /** @type {string} */ (m.attrs).trimEnd().endsWith("/");
    if (skipDepth) {
      if (name === skipName) skipDepth += closing ? -1 : selfClose ? 0 : 1;
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (name === "script") removed.scripts++; else removed.other++;
      if (!closing && !selfClose) { skipDepth = 1; skipName = name; }
      continue;
    }
    if (name === "a") { if (!closing) removed.links++; continue; } // the link goes, what it wrapped stays
    if (name === "style") {
      if (closing) {
        if (styleBuf !== null) {
          if (unsafeCss(styleBuf)) removed.other++;
          else if (styleBuf.trim()) out.push(`<style>${styleBuf.replace(/&/g, "&amp;")}</style>`);
          styleBuf = null;
        }
      } else if (!selfClose) styleBuf = "";
      continue;
    }
    const el = ELEMENTS.get(name);
    if (!el) { if (!closing) removed.other++; continue; }
    if (closing) { out.push(`</${el}>`); continue; }
    const attrs = [];
    const are = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    let dropMe = false;
    while ((a = are.exec(m.attrs))) {
      const an = a[1], av = a[2] ?? a[3] ?? a[4] ?? "";
      if (/^on/i.test(an)) { removed.scripts++; continue; }
      if (/^(?:xlink:)?href$/i.test(an)) {
        // An image carries its picture as a data URI, and a use points inside the file: nothing else.
        if (el === "image" && DATA_IMG.test(av)) { attrs.push(` href="${av}"`); continue; }
        if (el === "image") dropMe = true;
        removed.links++; continue;
      }
      if (an.toLowerCase() === "style") {
        if (unsafeCss(av)) { removed.other++; continue; }
        attrs.push(` style="${av.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`); continue;
      }
      if (!ATTR_OK.test(an) || badValue(av)) { if (!/^(?:xmlns:.*|xml:.*|data-.*|aria-.*|role|tabindex)$/i.test(an)) removed.other++; continue; }
      attrs.push(` ${an}="${av.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`);
    }
    // An image with nothing safe to show is dropped, not left empty.
    if (el === "image" && (dropMe || !attrs.some(x => x.startsWith(" href=")))) { if (!dropMe) removed.other++; continue; }
    out.push(`<${el}${attrs.join("")}${selfClose ? "/" : ""}>`);
  }
  let svg = out.join("").trim();
  if (!/^<svg[\s>]/i.test(svg)) svg = "";
  else if (!/xmlns=/.test(svg.slice(0, svg.indexOf(">")))) svg = svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return { svg, removed };
}

/** The panel's sentence about what was removed, or "". @param {{ scripts: number, links: number, other: number }} r */
export function removedSentence(r) {
  const parts = [];
  if (r.scripts) parts.push(r.scripts === 1 ? "a script" : `${r.scripts} scripts`);
  if (r.links) parts.push(r.links === 1 ? "a link" : `${r.links} links`);
  if (r.other) parts.push(r.other === 1 ? "one other unsafe part" : `${r.other} other unsafe parts`);
  return parts.length ? `Vyre removed ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]} from this SVG. The shapes and text are unchanged.` : "";
}
