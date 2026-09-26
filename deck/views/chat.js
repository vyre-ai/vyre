// @ts-check
// Vyre Chat: projects, sessions and the terminal, mirrored. The gate-chat workstream builds it in
// deck/chat/ (Mattermost is dropped); this route only loads it, and says plainly when it is not
// here yet.

import { h, put } from "../js/dom.js";

/** @param {any} ctx */
export default async function chat(ctx) {
  let mod = null;
  try { mod = await import("../chat/index.js"); } catch {}
  if (!ctx.alive()) return;
  if (mod?.default) return mod.default(ctx);
  put(ctx.root, h("div", { style: { maxWidth: "560px", margin: "0 auto", padding: "48px 24px" } },
    h("div", { class: "lbl" }, "Chat"),
    h("h1", { class: "h2", style: { marginTop: "10px" } }, "Vyre Chat is not here yet."),
    h("p", { class: "muted", style: { marginTop: "8px" } }, "Projects, sessions and the terminal, mirrored.")));
}
