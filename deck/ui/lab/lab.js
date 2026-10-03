// @ts-check
// The UI lab's router: lab/index.html#/<scenario>?theme=paper&density=compact&accent=amber&font=serif&corners=round. A scenario is a function that returns
// the element to draw; each team's scenarios live in their own file (lab-components.js, lab-fields.js, lab-now.js, lab-project.js) and register themselves
// by exporting `scenarios`. The same theme.js the Deck uses applies the query, so what the lab shows is what a space and a person would get.
import { put } from "../../js/dom.js";
import { resolveTheme, applyTheme } from "../theme.js";

/** @type {Record<string, (ctx: { q: URLSearchParams }) => Node | Promise<Node>>} */
const all = {};
for (const f of ["./lab-components.js", "./lab-fields.js", "./lab-now.js", "./lab-project.js"]) {
  try { Object.assign(all, (await import(f)).scenarios || {}); } catch (e) { if (!/Failed to fetch|Cannot find|404|error loading/i.test(String(/** @type {any} */ (e)?.message))) console.error(f, e); }
}

async function draw() {
  const [path, query = ""] = location.hash.replace(/^#\//, "").split("?");
  const q = new URLSearchParams(query);
  const space = { accent: q.get("accent") || undefined, hex: q.get("hex") || undefined, tint: q.get("tint") || undefined, density: q.get("density") || undefined,
    font: q.get("font") || undefined, corners: q.get("corners") || undefined };
  const person = { theme: /** @type {any} */ (q.get("theme") || "dark"), density: q.get("mydensity") || null, font: q.get("myfont") || null, reducedMotion: q.get("motion") === "reduced" };
  applyTheme(document.documentElement, resolveTheme({ space, person }));
  const host = /** @type {HTMLElement} */ (document.getElementById("lab"));
  const make = all[path];
  if (!make) { put(host, `No scenario "${path}". Known: ${Object.keys(all).join(", ") || "none yet"}`); document.title = "missing"; return; }
  put(host, await make({ q }));
  await document.fonts?.ready;
  document.title = "ready";
}
addEventListener("hashchange", draw);
draw();
