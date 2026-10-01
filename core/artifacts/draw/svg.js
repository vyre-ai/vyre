// @ts-check
// SVG artifacts are cleaned to shapes and text: no scripts, no links, no external images, no
// foreign content, no event handlers, no styles that load anything. The panel says when something
// was removed. The result is only ever shown through <img>, which runs nothing and loads nothing,
// so this is a second lock, not the only one.

const ALLOWED = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "lineargradient", "radialgradient", "stop", "title", "desc", "marker", "clippath", "symbol"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "foreignobject", "iframe", "object", "embed", "audio", "video", "animate", "set", "animatetransform", "animatemotion", "image", "use"]);
const ATTR_OK = /^(?:id|class|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|d|points|transform|viewbox|preserveaspectratio|xmlns|version|fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|stroke-dasharray|stroke-dashoffset|stroke-miterlimit|opacity|offset|stop-color|stop-opacity|gradientunits|gradienttransform|fx|fy|font-family|font-size|font-weight|font-style|text-anchor|dominant-baseline|letter-spacing|text-decoration|markerwidth|markerheight|refx|refy|orient|markerunits|marker-start|marker-mid|marker-end|clip-path|clip-rule|dx|dy|rotate|textlength|lengthadjust|xml:space|display|visibility|vector-effect|shape-rendering)$/i;

/** @param {string} v */
const badValue = v => /url\s*\(\s*["']?\s*(?!#)|javascript:|data:|expression\s*\(|@import|&#|&\w+;/i.test(v);

/**
 * @param {string} src
 * @returns {{ svg: string, removed: { scripts: number, links: number, other: number } }}
 */
export function cleanSvg(src) {
  const removed = { scripts: 0, links: 0, other: 0 };
  const out = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)|</g;
  let m, skipDepth = 0, skipName = "";
  const text = String(src).slice(0, 5 * 1024 * 1024);
  while ((m = re.exec(text))) {
    if (m[4] !== undefined) { if (!skipDepth) out.push(m[4].replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, "&amp;").replace(/>/g, "&gt;")); continue; }
    if (m[2] === undefined) { if (m[0] === "<") removed.other++; continue; } // comments, the XML declaration and a doctype go without a word
    const closing = m[1] === "/", name = m[2].toLowerCase().replace(/^svg:/, ""), selfClose = /\/\s*$/.test(m[3]);
    if (skipDepth) {
      if (name === skipName) skipDepth += closing ? -1 : selfClose ? 0 : 1;
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (name === "script") removed.scripts++; else if (name === "use" || name === "image") removed.links++; else removed.other++;
      if (!closing && !selfClose) { skipDepth = 1; skipName = name; }
      continue;
    }
    if (name === "a") { if (!closing) removed.links++; continue; } // the link goes, what it wrapped stays
    if (!ALLOWED.has(name)) { if (!closing) removed.other++; continue; }
    if (closing) { out.push(`</${name === "lineargradient" ? "linearGradient" : name === "radialgradient" ? "radialGradient" : name === "clippath" ? "clipPath" : name}>`); continue; }
    const attrs = [];
    const are = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = are.exec(m[3]))) {
      const an = a[1], av = a[2] ?? a[3] ?? a[4] ?? "";
      if (/^on/i.test(an)) { removed.scripts++; continue; }
      if (/^(?:xlink:)?href$/i.test(an)) { removed.links++; continue; }
      if (an.toLowerCase() === "style") { removed.other++; continue; }
      if (!ATTR_OK.test(an) || badValue(av)) { if (!/^(?:xmlns:.*|xml:.*|data-.*|aria-.*|role|tabindex)$/i.test(an)) removed.other++; continue; }
      attrs.push(` ${an}="${av.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`);
    }
    out.push(`<${name === "lineargradient" ? "linearGradient" : name === "radialgradient" ? "radialGradient" : name === "clippath" ? "clipPath" : name}${attrs.join("")}${selfClose ? "/" : ""}>`);
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
