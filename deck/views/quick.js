// @ts-check
// /quick: the compact ask route for the hotkey panel (PLAN.md C22, the Windows app's global hotkey): one
// composer on the assistant's current thread, its recent answer above it, and "Open in full". It is the same
// chat session view, drawn small (css/views/quick.css), so nothing here is a second composer or a second
// way to send. Reaching it from a link never acts: it only opens the thread and waits for words.

import { h, put, link, empty } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { homePath } from "../js/home.js";
import { icon } from "../js/icons.js";

/** @param {any} ctx @param {{ mount?: (el: HTMLElement, o: any) => (() => void) }} [deps] */
export default async function quick(ctx, deps = {}) {
  const root = h("div", { class: "quick" });
  put(ctx.root, root);
  const href = await homePath(attempt);
  if (!ctx.alive()) return;
  const thread = href.startsWith("/chat/thread/") ? decodeURIComponent(href.slice("/chat/thread/".length)) : null;
  if (!thread) { put(root, empty("Ask needs the assistant, which is not on this box yet.")); return; }
  const body = h("div", { class: "quick-body" });
  put(root, h("div", { class: "quick-head" }, h("span", { class: "lbl" }, "Ask"), h("span", { class: "quick-grow" }),
    link(href, { class: "btn btn-ghost btn-sm quick-full" }, "Open in full", icon("right", 12))), body);
  let mount = deps.mount || null;
  if (!mount) {
    try { mount = (await import("../chat/session.js")).mountSession; } catch { /* the chat module is missing: say so below */ }
    if (!ctx.alive()) return;
  }
  if (!mount) { put(body, empty("Chat is not here yet.")); return; }
  ctx.cleanup(mount(body, /** @type {any} */ ({ thread, project: null, shown: () => ctx.alive(), onBack: () => {} })));
}
