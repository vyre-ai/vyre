// @ts-check
// Chat's tip (docs/design/system/components/tip.md, "Chat: the composer's hint line"): one quiet
// line on the left of the composer's hint line, from tips.next (docs/build/tips.md), only while the
// composer is empty and nothing else wants the person (no running turn, no open ask). It never
// takes focus and is never announced. Show me copies a tip's command or opens its docs page; the ×
// dismisses it; "Hide tips about this" is the ×'s right click.
//
// Asked once when the view opens (with the module in front of the person), then once after each
// idle minute with idle: true. Nothing polls faster than that (SPEC principle 8), and nothing is
// asked while the page is hidden.

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";

export const IDLE_MS = 60_000;
/** Where a tip's `docs` page is read (docs' pageUrl in scripts/lib/docs/load.js). Until production is
 * deployed, the same paths are on https://preview.vyre-docs.pages.dev: point this there to test. */
export const DOCS_BASE = "https://docs.vyre.run";
/**
 * "using/chat.md#rewind" is /using/chat#rewind; "index.md" is /; "<dir>/index.md" is /<dir>/.
 * @param {string} docs
 */
export function docsUrl(docs) {
  const raw = String(docs).replace(/^\/+/, "");
  const hash = raw.indexOf("#");
  const file = hash >= 0 ? raw.slice(0, hash) : raw, anchor = hash >= 0 ? raw.slice(hash) : "";
  const page = file === "index.md" ? "" : file.endsWith("/index.md") ? file.slice(0, -"index.md".length) : file.replace(/\.md$/, "");
  return `${DOCS_BASE}/${page}${anchor}`;
}
const SURFACE = "chat", MODULE = "chat";

/**
 * A tip's text as pieces: backticked parts that are its key become a key chip, the rest mono.
 * @param {string} text @param {string|null|undefined} key
 * @returns {{ kind: "text"|"key"|"code", text: string }[]}
 */
export function tipPieces(text, key) {
  /** @type {{ kind: "text"|"key"|"code", text: string }[]} */
  const out = [];
  const re = /`([^`]+)`/g;
  const s = String(text ?? "");
  let at = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > at) out.push({ kind: "text", text: s.slice(at, m.index) });
    out.push({ kind: key && m[1] === key ? "key" : "code", text: m[1] });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ kind: "text", text: s.slice(at) });
  return out;
}

/**
 * @param {HTMLElement} slot where the line goes (the composer hint line's left part)
 * @param {{ busy: () => boolean, empty: () => boolean, visible?: () => boolean, input?: EventTarget|null,
 *   copy?: (s: string) => Promise<void>, open?: (url: string) => void, now?: () => number }} o
 */
export function mountTip(slot, o) {
  let tip = /** @type {any} */ (null);
  let asking = false, stopped = false, copied = false;
  /** @type {any} */ let timer = null;
  const visible = o.visible || (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const quiet = () => !o.busy() && o.empty();

  function draw() {
    if (!tip || !quiet()) { put(slot); slot.hidden = true; return; }
    slot.hidden = false;
    const act = tip.command || tip.docs ? h("button", { class: "btn btn-ghost btn-sm cv-tip-show", type: "button", tabindex: "-1", onclick: showMe }, copied ? "Copied" : "Show me") : null;
    const close = h("button", { class: "ibtn cv-tip-x", type: "button", tabindex: "-1", "aria-label": "Dismiss tip", title: "Dismiss tip (right click: hide tips about this)",
      onclick: () => dismiss({ id: tip.id }), oncontextmenu: e => { e.preventDefault(); dismiss({ module: tip.module || MODULE }); } }, icon("close", 12));
    put(slot, h("div", { class: "cv-tip", role: "note", "aria-label": tip.text.replace(/`/g, "") },
      h("span", { class: "cv-tip-icon", "aria-hidden": "true" }, icon("ask", 12)),
      h("span", { class: "cv-tip-text", title: tip.text.replace(/`/g, "") },
        tipPieces(tip.text, tip.key).map(p => p.kind === "text" ? p.text : h(p.kind === "key" ? "span" : "code", { class: p.kind === "key" ? "kbd cv-tip-key" : "cv-tip-code" }, p.text))),
      act, close));
  }

  async function ask(idle) {
    if (asking || stopped || tip || !visible()) return;
    asking = true;
    const r = await attempt("tips.next", { surface: SURFACE, context: { module: MODULE, idle, busy: !quiet() } });
    asking = false;
    if (stopped) return;
    const t = r.data && (r.data.tip || (r.data.id ? r.data : null));
    if (!t || typeof t.text !== "string") return;
    tip = t;
    draw();
    if (!slot.hidden) attempt("tips.seen", { id: tip.id, surface: SURFACE });
  }
  async function showMe() {
    if (!tip) return;
    const t = tip;
    if (t.command) {
      try { await (o.copy || (s => navigator.clipboard.writeText(s)))(t.command); copied = true; draw(); } catch {}
      setTimeout(() => { copied = false; tip = null; draw(); }, 2000);
    } else if (t.docs) {
      // A new tab, never away from the session.
      (o.open || (u => window.open(u, "_blank", "noopener,noreferrer")))(docsUrl(t.docs));
      tip = null; draw();
    }
    attempt("tips.seen", { id: t.id, surface: SURFACE, acted: true });
  }
  function dismiss(what) {
    tip = null; draw();
    attempt("tips.dismiss", what);
  }
  /** Idle: a minute with nothing typed and nothing running asks once more. */
  function rearm() {
    if (timer) clearTimeout(timer);
    timer = stopped ? null : setTimeout(() => { timer = null; if (quiet()) ask(true); rearm(); }, IDLE_MS);
  }
  const onInput = () => { draw(); rearm(); };
  o.input?.addEventListener("input", onInput);

  // Nothing shows until a tip arrives: no empty slot, no reserved height.
  draw();
  attempt("tips.used", { module: MODULE });
  ask(false);
  rearm();
  return {
    /** Busy or not, empty or not: hide or show again in this frame. */
    sync: draw,
    get tip() { return tip; },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; o.input?.removeEventListener("input", onInput); },
  };
}
