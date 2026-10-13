// @ts-check
// Makes a rendered document's elements inert, for a file nobody trusts (a .docx drawn by docx-preview). It works on any DOM-like tree (querySelectorAll, attributes, removeAttribute, setAttribute, remove), so a
// test can run it without a browser. Defence in depth: the viewer also draws the result inside an iframe with sandbox="" (no scripts, no forms, no same-origin), where nothing here could run anyway.
//   - elements that run or load things are removed: script, iframe, frame, object, embed, applet, form, link, meta, base, audio, video, source
//   - every on* attribute goes
//   - href, xlink:href, src, action, formaction, srcset, poster, data: a link keeps only http, https or mailto; src keeps only an inline image (data:image/png|jpeg|gif|webp|bmp); the rest are dropped
//   - links open outside with rel="noopener noreferrer" and target="_blank"
//   - <style> text loses @import and any url() that is not an inline image

const REMOVE = "script,iframe,frame,frameset,object,embed,applet,form,link,meta,base,audio,video,source,noscript,template";
const URL_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction", "srcset", "poster", "data", "background", "ping"]);
const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;
const SAFE_IMG = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]*$/i;

// whitespace and control characters inside a scheme are ignored by a browser, so they are ignored here before the scheme is read
const IGNORED = new RegExp("[\\u0000-\\u0020\\u00a0\\u1680\\u180e\\u2000-\\u200b\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]", "g");
/** @param {unknown} v */
const flat = v => String(v).replace(IGNORED, "");

/** @param {string} css */
export const cleanCss = css => String(css).replace(/@import[^;]*;?/gi, "").replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (all, _q, u) => (SAFE_IMG.test(u.trim()) ? all : "none"));

/** @param {any} root */
export function neutralise(root) {
  for (const el of Array.from(root.querySelectorAll(REMOVE))) el.remove();
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "style") { el.textContent = cleanCss(el.textContent || ""); continue; }
    for (const a of Array.from(el.attributes || [])) {
      const name = String(a.name).toLowerCase();
      if (name.startsWith("on")) { el.removeAttribute(a.name); continue; }
      if (name === "style") { el.setAttribute(a.name, cleanCss(a.value)); continue; }
      if (!URL_ATTRS.has(name)) continue;
      const v = flat(a.value);
      const ok = tag === "a" && (name === "href") ? SAFE_LINK.test(v) : name === "src" && tag === "img" ? SAFE_IMG.test(v) : false;
      if (!ok) el.removeAttribute(a.name);
    }
    if (tag === "a" && el.getAttribute && el.getAttribute("href")) { el.setAttribute("rel", "noopener noreferrer"); el.setAttribute("target", "_blank"); }
  }
  return root;
}
