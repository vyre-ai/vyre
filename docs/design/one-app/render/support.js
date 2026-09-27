// A stand-in for the design canvas's runtime, for render checks only (never published). It
// expands one .dc.html artboard to static DOM: {{holes}}, <sc-for>, <sc-if>, <dc-import>,
// <helmet>. Then it audits every text node's contrast against its real composited background,
// and flags text that falls outside the frame. Results land in <pre id="dc-audit"> as JSON.
(function () {
  class DCLogic { constructor(props) { this.props = props || {}; this.state = {}; } setState(s) { Object.assign(this.state, s); } forceUpdate() {} }
  window.DCLogic = DCLogic;

  const get = (scope, path) => {
    path = path.trim();
    if (path === "true") return true;
    if (path === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(path)) return +path;
    let v = scope;
    for (const k of path.split(".")) { if (v == null) return undefined; v = v[k]; }
    return v;
  };
  const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const fill = (s, scope) => s.replace(HOLE, (_, p) => { const v = get(scope, p); return v == null || typeof v === "function" ? "" : String(v); });

  function load(name) {
    const x = new XMLHttpRequest();
    x.open("GET", name, false);
    x.send();
    return new DOMParser().parseFromString(x.responseText, "text/html");
  }

  function component(doc, attrs) {
    const script = doc.querySelector("script[data-dc-script]");
    const decl = JSON.parse(script.getAttribute("data-props") || "{}");
    const props = {};
    for (const [k, d] of Object.entries(decl)) if (!k.startsWith("$") && d && "default" in d) props[k] = d.default;
    Object.assign(props, attrs);
    const Cls = new Function("DCLogic", script.textContent + "\nreturn Component;")(DCLogic);
    const c = new Cls(props);
    c.props = props;
    if (c.componentDidMount) { /* static render: no lifecycle */ }
    return c.renderVals ? c.renderVals() : {};
  }

  function helmet(doc) {
    for (const h of doc.querySelectorAll("helmet")) {
      for (const n of [...h.children]) document.head.appendChild(document.importNode(n, true));
      h.remove();
    }
  }

  function expand(node, scope) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) { if (child.nodeValue.includes("{{")) child.nodeValue = fill(child.nodeValue, scope); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "sc-for") {
        const list = get(scope, child.getAttribute("list").replace(/[{}]/g, "")) || [];
        const as = child.getAttribute("as") || "item";
        const frag = document.createDocumentFragment();
        list.forEach((item, i) => {
          const wrap = document.createElement("div");
          wrap.innerHTML = child.innerHTML;
          expand(wrap, { ...scope, [as]: item, $index: i });
          frag.append(...wrap.childNodes);
        });
        child.replaceWith(frag);
        continue;
      }
      if (tag === "sc-if") {
        const v = get(scope, child.getAttribute("value").replace(/[{}]/g, ""));
        if (!v) { child.remove(); continue; }
        expand(child, scope);
        child.replaceWith(...child.childNodes);
        continue;
      }
      if (tag === "dc-import") {
        const attrs = {};
        for (const a of child.attributes) if (!["name", "hint-size"].includes(a.name))
          attrs[a.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = fill(a.value, scope);
        child.replaceWith(render(load(child.getAttribute("name") + ".dc.html"), attrs));
        continue;
      }
      for (const a of [...child.attributes]) {
        if (!a.value.includes("{{")) continue;
        if (/^on[A-Z]/.test(a.name)) { child.removeAttribute(a.name); continue; }
        child.setAttribute(a.name, fill(a.value, scope));
      }
      expand(child, scope);
    }
  }

  function render(doc, attrs) {
    helmet(doc);
    const vals = component(doc, attrs);
    const x = doc.querySelector("x-dc");
    const wrap = document.createElement("div");
    wrap.innerHTML = x.innerHTML;
    wrap.querySelectorAll("helmet").forEach(h => h.remove());
    expand(wrap, vals);
    const frag = document.createDocumentFragment();
    frag.append(...wrap.childNodes);
    return frag;
  }

  // ---- contrast audit ----
  const rgba = s => { const m = s.match(/[\d.]+/g) || [0, 0, 0, 0]; return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]]; };
  const over = (top, under) => { const a = top[3] + under[3] * (1 - top[3]); if (!a) return [0, 0, 0, 0];
    return [0, 1, 2].map(i => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a); };
  const lum = c => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  function background(el) {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let bg = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  }

  function audit(root) {
    const box = root.getBoundingClientRect();
    const fails = [], clipped = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const text = t.nodeValue.trim();
      if (!text) continue;
      const el = t.parentElement;
      if (el.closest("svg")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const range = document.createRange(); range.selectNodeContents(t);
      const r = range.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const bg = background(el);
      const fg = over(rgba(cs.color), bg);
      const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
      const min = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const cr = ratio(fg, bg);
      if (cr < min) fails.push({ text: text.slice(0, 60), ratio: +cr.toFixed(2), min, color: cs.color, bg: `rgb(${bg.slice(0, 3).map(Math.round)})`, cls: el.className });
      if (!el.closest("[data-scrolls]") && (r.right > box.right + 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1)) clipped.push(text.slice(0, 60));
    }
    return { fails, clipped, offscale: system(root) };
  }

  // The reduced system: 5 sizes, 2 weights, 2 families, and only the palette's colours.
  const SIZES = [12, 13, 15, 17, 20, 22, 28], WEIGHTS = [400, 600];
  const FAMILIES = ["Instrument Sans", "JetBrains Mono"];
  function allowedColours() {
    const set = new Set(["0,0,0", "255,255,255"]);
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (!r.style || !/^\.t-(dark|light)/.test(r.selectorText || "")) continue;
        for (const name of r.style) if (name.startsWith("--")) for (const m of r.style.getPropertyValue(name).matchAll(/#([0-9a-f]{6})\b|rgba?\(([^)]+)\)/gi)) {
          if (m[1]) set.add([0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).join(","));
          else set.add(m[2].split(",").slice(0, 3).map(v => +v).join(","));
        }
      }
    }
    return set;
  }
  function system(root) {
    const ok = allowedColours(), out = new Set();
    const rgb = c => { const m = c.match(/[\d.]+/g); return m && (m[3] === undefined || +m[3] > 0) ? m.slice(0, 3).map(v => Math.round(+v)).join(",") : null; };
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none") continue;
      const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim());
      if (hasText) {
        const size = parseFloat(cs.fontSize), weight = +cs.fontWeight, fam = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
        if (!SIZES.includes(size)) out.add(`size ${size}px "${el.textContent.trim().slice(0, 30)}"`);
        if (!WEIGHTS.includes(weight)) out.add(`weight ${weight} "${el.textContent.trim().slice(0, 30)}"`);
        if (!FAMILIES.includes(fam)) out.add(`family ${fam}`);
        const c = rgb(cs.color); if (c && !ok.has(c)) out.add(`colour rgb(${c}) text "${el.textContent.trim().slice(0, 30)}"`);
      }
      for (const prop of ["backgroundColor", "borderTopColor"]) {
        if (prop === "borderTopColor" && parseFloat(cs.borderTopWidth) === 0) continue;
        const c = rgb(cs[prop]); if (c && !ok.has(c)) out.add(`colour rgb(${c}) ${prop} .${el.className}`);
      }
    }
    return [...out];
  }

  document.addEventListener("DOMContentLoaded", () => {
    const frag = render(document, {});
    const x = document.querySelector("x-dc");
    x.replaceWith(frag);
    document.querySelectorAll("script[data-dc-script]").forEach(s => s.remove());
    const run = () => {
      const root = document.body.firstElementChild;
      const pre = document.createElement("pre");
      pre.id = "dc-audit";
      pre.style.display = "none";
      pre.textContent = JSON.stringify(audit(root));
      document.body.appendChild(pre);
    };
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(run, 50));
  });
})();
