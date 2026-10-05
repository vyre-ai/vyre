// @ts-check
// The command bar (design-system.md section 4): Ctrl or Cmd K from anywhere, a glass panel over the page with one box. Nothing typed shows what you
// chose last and a few places; typing narrows projects, people and agents, threads and actions; `p `, `t ` and `u ` restrict to one kind; the arrows
// move, Enter goes (or acts), Esc leaves. Threads are also searched through what was said (recall.search) once two letters are typed. What it can
// go to is read when it opens and kept for the page's life; nothing polls. The choices and the order are js/cmdbar-core.js.

import { h, put, go as goTo } from "./dom.js";
import { icon } from "./icons.js";
import { attempt as liveAttempt } from "./api.js";
import { projectAvatar, whoAvatar } from "./avatars.js";
import { choices, actionEntries } from "./cmdbar-core.js";
import { threadHref } from "../chat/lib/routes.js";

const RECENT_KEY = "vyre.cmd.recent";

/**
 * @param {{ attempt?: typeof liveAttempt, go?: (href: string) => void, doc?: Document, storage?: { getItem: (k: string) => string|null, setItem: (k: string, v: string) => void } | null }} [deps]
 */
export function createCmdBar(deps = {}) {
  const attempt = deps.attempt || liveAttempt;
  const go = deps.go || goTo;
  const doc = deps.doc || document;
  const storage = deps.storage !== undefined ? deps.storage : (() => { try { return localStorage; } catch { return null; } })();

  /** @type {import("./cmdbar-core.js").Entry[]} */ let known = [];
  /** @type {import("./cmdbar-core.js").Entry[]} */ let said = [];
  /** @type {import("./cmdbar-core.js").Shown[]} */ let shown = [];
  let loaded = false, open_ = false, sel = 0, seq = 0;
  /** @type {any} */ let timer = null, root = null, input = null, list = null, back = null;

  const recents = () => { try { return JSON.parse(storage?.getItem(RECENT_KEY) || "[]").filter((/** @type {any} */ x) => typeof x === "string"); } catch { return []; } };
  const remember = (/** @type {string} */ id) => { try { storage?.setItem(RECENT_KEY, JSON.stringify([id, ...recents().filter((/** @type {string} */ x) => x !== id)].slice(0, 8))); } catch { /* private window */ } };

  async function load() {
    const [pl, ag, th] = await Promise.all([attempt("projects.list", {}, { share: true }), attempt("agents.list", {}, { share: true }), attempt("threads.list", {}, { share: true })]);
    const assistant = (Array.isArray(ag.data) ? ag.data : []).find((/** @type {any} */ a) => a?.kind === "assistant")?.name || null;
    /** @type {import("./cmdbar-core.js").Entry[]} */ const out = [...actionEntries({ assistant })];
    for (const p of (pl.data?.projects || [])) if (p && p.slug && !p.archived_at) out.push({ id: "p:" + p.slug, group: "Projects", title: String(p.name || p.slug), href: `/projects/${encodeURIComponent(p.slug)}`, kind: "project", ref: p.slug });
    for (const a of (Array.isArray(ag.data) ? ag.data : [])) if (a?.name) out.push({ id: "a:" + a.name, group: "People and agents", title: String(a.name), meta: a.kind === "assistant" ? "Assistant" : "Agent", href: `/agents/${encodeURIComponent(a.name)}`, kind: "agent", ref: a.name });
    for (const t of (Array.isArray(th.data) ? th.data : []).slice(0, 30)) if (t?.id) out.push({ id: "t:" + t.id, group: "Threads", title: String(t.name || t.label || "New chat"), meta: t.project ? String(t.project) : undefined, href: threadHref({ id: t.id, project: t.project }), kind: "thread", ref: t.id });
    known = out; loaded = true;
    draw();
  }

  function entries() { const seen = new Set(known.map(e => e.id)); return [...known, ...said.filter(e => !seen.has(e.id))]; }

  function draw() {
    if (!open_ || !list) return;
    shown = choices(entries(), input.value, recents());
    sel = Math.max(0, Math.min(sel, shown.length - 1));
    let last = "";
    const rows = [];
    shown.forEach((e, i) => {
      if (e.group !== last) { rows.push(h("div", { class: "cmd-grp", role: "presentation" }, e.group)); last = e.group; }
      rows.push(h("div", { class: "cmd-row" + (i === sel ? " on" : ""), role: "option", id: "cmd-" + i, "aria-selected": String(i === sel), "data-id": e.id, onclick: () => choose(i), onpointermove: () => { if (sel !== i) { sel = i; mark(); } } },
        h("span", { class: "cmd-ic", "aria-hidden": "true" }, e.kind === "project" && e.ref ? projectAvatar(e.ref, { size: 28 }) : e.kind === "agent" && e.ref ? whoAvatar(e.ref, { size: 28 }) : icon(e.kind === "thread" ? "chat" : "right", 16)),
        h("span", { class: "cmd-t" }, h("b", null, e.title), e.meta ? h("span", { class: "cmd-m" }, e.meta) : null),
        i === sel ? h("span", { class: "kbd" }, "Enter") : null));
    });
    put(list, rows.length ? rows : h("div", { class: "empty state" }, h("b", { class: "state-title" }, loaded ? "Nothing found" : "Looking"), loaded ? h("p", { class: "state-text" }, "Try another word.") : null));
    input.setAttribute("aria-activedescendant", shown.length ? "cmd-" + sel : "");
  }
  function mark() {
    if (!list) return;
    shown.forEach((_e, i) => { const r = list.querySelector("#cmd-" + i); if (r) { r.classList.toggle("on", i === sel); r.setAttribute("aria-selected", String(i === sel)); } });
    input.setAttribute("aria-activedescendant", shown.length ? "cmd-" + sel : "");
    list.querySelector("#cmd-" + sel)?.scrollIntoView?.({ block: "nearest" });
  }
  function choose(/** @type {number} */ i) {
    const e = shown[i];
    if (!e) return;
    remember(e.id);
    close();
    go(e.href);
  }

  /** Words said in a thread, found by recall.search, join the Threads group while typing. */
  function search() {
    clearTimeout(timer);
    const q = String(input.value || "").trim();
    const n = ++seq;
    if (q.length < 2 || /^[ptu]\s/i.test(q) && !/^t\s/i.test(q)) { said = []; draw(); return; }
    timer = setTimeout(async () => {
      const r = await attempt("recall.search", { q: q.replace(/^t\s+/i, ""), limit: 6 });
      if (n !== seq || !open_) return;
      said = (Array.isArray(r.data) ? r.data : []).filter((/** @type {any} */ t) => t?.session).map((/** @type {any} */ t) => ({ id: "s:" + t.session, group: /** @type {"Threads"} */ ("Threads"), title: String(t.name || t.title || "A conversation").slice(0, 80),
        meta: String(t.snippet || t.text || "").replace(/[«»]/g, "").slice(0, 80), href: threadHref({ id: t.session }), kind: /** @type {"thread"} */ ("thread"), ref: t.session }));
      draw();
    }, 180);
  }

  function onKey(/** @type {KeyboardEvent} */ e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (shown.length) { sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length; mark(); } return; }
    if (e.key === "Enter") { e.preventDefault(); choose(sel); return; }
    if (e.key === "Tab") { e.preventDefault(); } // the box is the only stop while it is open
  }

  let returnTo = /** @type {any} */ (null);
  function open() {
    if (open_) { input?.focus(); input?.select?.(); return; }
    open_ = true; sel = 0; said = [];
    returnTo = doc.activeElement;
    input = h("input", { class: "cmd-in", type: "text", autocomplete: "off", spellcheck: "false", role: "combobox", "aria-expanded": "true", "aria-controls": "cmd-list", "aria-label": "Search Vyre",
      placeholder: "Search, or type p for projects, t for threads, u for people", oninput: () => { sel = 0; draw(); search(); }, onkeydown: onKey });
    list = h("div", { class: "cmd-res", id: "cmd-list", role: "listbox", "aria-label": "Results" });
    back = h("div", { class: "cmd-scrim", onclick: () => close() });
    root = h("div", { class: "cmd", role: "dialog", "aria-modal": "true", "aria-label": "Search" }, back,
      h("div", { class: "cmd-panel" }, h("div", { class: "cmd-q" }, icon("search", 16), input, h("span", { class: "kbd" }, "Esc")), list));
    doc.body.append(root);
    draw();
    input.focus();
    void load(); // read again each time it opens: cheap, and what exists changes
  }
  function close() {
    if (!open_) return;
    open_ = false; clearTimeout(timer);
    root?.remove(); root = input = list = back = null;
    try { returnTo?.focus?.(); } catch { /* gone */ }
  }
  /** Ctrl or Cmd K, anywhere: opens, or closes when it is already open. @param {KeyboardEvent} e */
  function onGlobalKey(e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "k") { e.preventDefault(); open_ ? close() : open(); }
  }
  return { open, close, isOpen: () => open_, onGlobalKey, choose };
}

