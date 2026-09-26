// @ts-check
// Glass: an agent's screen, live, with take-over. The computers workstream builds it in
// deck/glass/ (boards GlassWatch, GlassTakeover, PhoneGlass); this route only loads it, and
// says plainly when it is not here yet.

import { h, put, link } from "../js/dom.js";

/** @param {any} ctx */
export default async function glass(ctx) {
  let mod = null;
  try { mod = await import("../glass/index.js"); } catch {}
  if (!ctx.alive()) return;
  if (mod?.default) return mod.default(ctx);
  const name = ctx.params.name;
  put(ctx.root, h("div", { style: { maxWidth: "560px", margin: "0 auto", padding: "48px 24px" } },
    h("div", { class: "lbl" }, "Glass"),
    h("h1", { class: "h2", style: { marginTop: "10px" } }, `${name}'s screen is not here yet.`),
    h("p", { class: "muted", style: { marginTop: "8px" } },
      "Glass arrives with the computers module: you will watch the agent's desktop live and take the wheel. ",
      link(`/agents/${encodeURIComponent(name)}`, { class: "link" }, `Back to ${name}`))));
}
