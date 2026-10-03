// @ts-check
// /u/<screen>: the generated screens of the UI build, behind one route until they replace the old views. See ui/screens.js.
import { h, put } from "../js/dom.js";
import { screens } from "../ui/screens.js";

/** @param {any} ctx */
export default async function ui(ctx) {
  const load = screens[ctx.params.screen];
  if (!load) { put(ctx.root, h("div", { class: "ui-empty" }, h("b", null, "No such screen"), h("p", null, `Known: ${Object.keys(screens).join(", ")}.`))); return; }
  const mod = await load();
  await mod.default(ctx);
}
