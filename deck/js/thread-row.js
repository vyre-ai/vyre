// @ts-check
// The one thread row (design-system.md section 4): the project's emblem (or the agent's mark), a title, the last line, and at the end a stack of up to three
// participants, the time, and what it needs from you. Chat, a project's chats, Now's run list and search results all draw it. State is a word as well as a
// mark: "Running", "2 need you". No ids, no mono data. js/rows.js gives it hover, focus and the context menu; css/thread-row.css draws it on the v2 tokens.

import { h, link } from "./dom.js";
import { threadAvatar, whoAvatar, personAvatar } from "./avatars.js";
import { when, plural } from "./fmt.js";

export const MAX_STACK = 3;

/**
 * The participants to stack, the person first, then each distinct agent, at most three.
 * @param {{ agent?: string|null, holder?: string|null, participants?: (string|null)[], human?: boolean }} row
 * @returns {{ kind: "person" | "who", id?: string }[]}
 */
export function participantsOf(row) {
  /** @type {{ kind: "person" | "who", id?: string }[]} */ const out = [];
  const seen = new Set();
  const add = (/** @type {{ kind: "person" | "who", id?: string }} */ p) => { const k = p.kind + ":" + (p.id ?? ""); if (!seen.has(k)) { seen.add(k); out.push(p); } };
  if (row.human !== false) add({ kind: "person" });
  for (const a of [row.agent, ...(row.participants || [])]) if (a) add({ kind: "who", id: String(a) });
  return out.slice(0, MAX_STACK);
}

/**
 * @param {{ href: string, title: string, last?: string|null, project?: string|null, agent?: string|null, thread?: string|null, at?: number|null,
 *   status?: string|null, asks?: number, turns?: number, where?: string|null, current?: boolean, participants?: (string|null)[], human?: boolean, extra?: (Node|null)[] }} r
 */
export function threadRow(r) {
  const stack = participantsOf(r);
  const line = r.last || (r.turns ? plural(r.turns, "message") : "No messages yet");
  const running = r.status === "running";
  return link(r.href, { class: "thread-row trow", ...(r.current ? { "aria-current": "page" } : {}) },
    h("span", { class: "trow-em" }, threadAvatar({ agent: r.agent, project: r.project, thread: r.thread }, { size: 32 })),
    h("span", { class: "trow-body" },
      h("span", { class: "trow-title ellipsis" }, r.title),
      h("span", { class: "trow-last ellipsis" }, r.where ? `${r.where} · ${line}` : line)),
    h("span", { class: "trow-end" },
      r.asks ? h("span", { class: "trow-needs" }, h("span", { class: "dot beacon" }), `${r.asks} need${r.asks === 1 ? "s" : ""} you`)
        : running ? h("span", { class: "trow-run" }, h("span", { class: "dot signal" }), "Running") : null,
      stack.length > 1 ? h("span", { class: "trow-stack", "aria-hidden": "true" }, stack.map(p => p.kind === "person" ? personAvatar({ size: 20 }) : whoAvatar(p.id, { size: 20 }))) : null,
      r.at ? h("span", { class: "trow-when" }, when(r.at)) : null),
    ...(r.extra || []));
}
