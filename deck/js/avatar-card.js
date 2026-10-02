// @ts-check
// The avatar card and the nod (design-system.md section 4, ux-research.md section 5.2). Tapping an avatar nods it (scale 0.86 to 1.1 to 1 with a tilt and an
// accent ring, 460 ms) and 170 ms in the card opens: a popover on a desk, a sheet on a phone. One card for every kind of entity; only its rows and its
// actions change. Avatars inside a link or a button (a row, a tab) keep their row's job and never nod; an avatar beside a message opens that message's
// details instead (js/message-details.js). The kinds that have a card: person, assistant, agent, teammate, project. Esc, an outside tap or the close
// button leaves it. Styles: css/avatar-card.css.

import { h, put, go as goTo, isPhone } from "./dom.js";
import { attempt as liveAttempt } from "./api.js";
import { avatar, personAvatar, whoIs, projectAvatar, whoAvatar, RING_AT } from "./avatars.js";
import { openSheet } from "./sheet.js";
import { plural } from "./fmt.js";

export const NOD_MS = 460, CARD_AT_MS = 170;

/**
 * What a card says and offers for one avatar: its name, a kind line, up to five rows, up to three actions. Pure (the reads are done by the caller and handed in).
 * @param {{ family: string, ref: string|null, seed: string }} a
 * @param {{ owner?: { name: string|null }, assistant?: { name: string|null }, agents?: any[], projects?: any[], threads?: any[] }} d
 * @returns {{ name: string, kind: string, rows: [string, string][], actions: { label: string, href: string, primary?: boolean }[] }}
 */
export function cardModel(a, d) {
  const ref = a.ref || a.seed;
  if (a.family === "person") return { name: d.owner?.name || "You", kind: "You, owner", rows: [["Role", "Owner"]], actions: [{ label: "Settings", href: "/settings" }] };
  if (a.family === "assistant") {
    const name = d.assistant?.name || "Your assistant";
    return { name, kind: "Your assistant", rows: [["Role", "Answers across your projects"]], actions: [{ label: "Ask " + name, href: "/chat?new", primary: true }, { label: "Settings", href: "/settings" }] };
  }
  if (a.family === "project") {
    const p = (d.projects || []).find(x => x.slug === ref);
    const chats = (d.threads || []).filter(t => t.project === ref);
    const needs = chats.reduce((n, t) => n + (t.asks || 0), 0);
    return { name: p?.name || ref, kind: "Project", rows: [["Chats", String(chats.length)], ["Needs you", needs ? String(needs) : "Nothing"]],
      actions: [{ label: "Open chats", href: `/projects/${encodeURIComponent(ref)}`, primary: true }] };
  }
  if (a.family === "teammate") {
    const m = /^(.+?)-(.+)$/.exec(ref);
    return { name: m ? m[1] : ref, kind: "Teammate", rows: m ? [["Project", m[2]]] : [], actions: m ? [{ label: "Open project", href: `/projects/${encodeURIComponent(m[2])}`, primary: true }] : [] };
  }
  const ag = (d.agents || []).find(x => x.name === ref);
  const rows = /** @type {[string, string][]} */ ([]);
  if (ag?.provider || ag?.engine) rows.push(["Engine", String(ag.provider || ag.engine)]);
  if (ag?.status) rows.push(["Now", String(ag.status)]);
  const chats = (d.threads || []).filter(t => t.agent === ref);
  rows.push(["Chats", String(chats.length)]);
  return { name: ref, kind: "Agent", rows, actions: [{ label: "Open its work", href: `/agents/${encodeURIComponent(ref)}`, primary: true }] };
}

/** The element that was tapped, if it is an avatar that should nod: not inside a link, a button or a message. @param {any} t */
export function nodTarget(t) {
  for (let n = t; n && n.tagName; n = n.parentNode) {
    const tag = String(n.tagName).toUpperCase();
    const cl = typeof n.classList?.contains === "function" ? n.classList : null;
    if (cl && cl.contains("vy-av")) {
      if (n.getAttribute("data-no-nod") !== null && n.getAttribute("data-no-nod") !== undefined) return null;
      // Walk up: a link or a button around it is the row's own job.
      for (let m = n.parentNode; m && m.tagName; m = m.parentNode) { const mt = String(m.tagName).toUpperCase(); if (mt === "A" || mt === "BUTTON" || (m.classList?.contains?.("cv-row"))) return null; }
      return n;
    }
    if (tag === "BODY") break;
  }
  return null;
}

/**
 * @param {{ attempt?: typeof liveAttempt, go?: (href: string) => void, doc?: Document, phone?: () => boolean, wait?: (fn: () => void, ms: number) => void }} [deps]
 */
export function createAvatarCards(deps = {}) {
  const attempt = deps.attempt || liveAttempt;
  const go = deps.go || goTo;
  const doc = deps.doc || document;
  const phone = deps.phone || isPhone;
  const wait = deps.wait || ((fn, ms) => { setTimeout(fn, ms); });
  /** @type {null | (() => void)} */ let closeCard = null;

  const reduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

  async function readData() {
    const [ag, pl, th] = await Promise.all([attempt("agents.list", {}, { share: true }), attempt("projects.list", {}, { share: true }), attempt("threads.list", { machines: "local" }, { share: true })]);
    const w = whoIs();
    return { owner: w.owner, assistant: w.assistant, agents: Array.isArray(ag.data) ? ag.data : [], projects: pl.data?.projects || [], threads: Array.isArray(th.data) ? th.data : [] };
  }

  /** The big mark: the person's at ring size, else the entity's own mark at 132. @param {any} spec */
  function bigMark(spec) {
    if (spec.family === "person") return personAvatar({ size: RING_AT + 114, ring: true, label: "You" });
    if (spec.family === "project") return projectAvatar(spec.ref || "", { size: 132 });
    if (spec.family === "assistant" || spec.family === "agent") return whoAvatar(spec.ref || null, { size: 132 });
    return avatar(spec.family, spec.seed, { size: 132, ref: spec.ref });
  }

  async function open(/** @type {any} */ from) {
    closeCard?.();
    const spec = from._av;
    if (!spec) return;
    const m = cardModel({ family: spec.family, ref: from.getAttribute("data-ref"), seed: spec.seed }, await readData());
    const body = (/** @type {HTMLElement} */ into) => put(into,
      h("div", { class: "ac-mark" }, bigMark({ ...spec, ref: from.getAttribute("data-ref") })),
      h("h2", { class: "ac-name" }, m.name),
      h("p", { class: "ac-kind" }, m.kind),
      m.rows.length ? h("dl", { class: "ac-rows" }, m.rows.map(([k, v]) => h("div", { class: "ac-row" }, h("dt", null, k), h("dd", null, v)))) : null,
      h("div", { class: "ac-acts" }, m.actions.slice(0, 3).map(a => h("a", { class: "btn btn-sm " + (a.primary ? "btn-primary" : ""), href: a.href, onclick: (/** @type {MouseEvent} */ e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); closeCard?.(); go(a.href); } }, a.label))));
    if (phone()) {
      const s = openSheet({ title: m.name, build: (b) => body(b) });
      closeCard = () => { s.close(); closeCard = null; };
      return;
    }
    const pop = h("div", { class: "ac", role: "dialog", "aria-label": `${m.name}, ${m.kind}` });
    body(pop);
    const r = from.getBoundingClientRect?.();
    if (r) { pop.style.left = Math.max(12, Math.min(r.left, (window.innerWidth || 1200) - 396)) + "px"; pop.style.top = Math.min(r.bottom + 8, (window.innerHeight || 800) - 420) + "px"; }
    const off = () => { pop.remove(); doc.removeEventListener("keydown", onKey, true); doc.removeEventListener("pointerdown", onOut, true); closeCard = null; };
    const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape") { e.preventDefault(); off(); } };
    const onOut = (/** @type {any} */ e) => { if (!pop.contains(e.target)) off(); };
    doc.addEventListener("keydown", onKey, true);
    wait(() => doc.addEventListener("pointerdown", onOut, true), 0);
    doc.body.append(pop);
    closeCard = off;
  }

  /** The click handler: nod, then the card. @param {any} e */
  function onClick(e) {
    const av = nodTarget(e.target);
    if (!av || !av._av) return false;
    if (!reduced()) { av.classList.add("nod"); wait(() => av.classList.remove("nod"), NOD_MS); }
    wait(() => { void open(av); }, reduced() ? 0 : CARD_AT_MS);
    return true;
  }
  return { onClick, open, close: () => closeCard?.(), isOpen: () => !!closeCard };
}
