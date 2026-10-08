// @ts-check
// Where a module's screen opens (SPEC-0.3.0 interface 3, amended): on the module's OWN origin, https://<module>.<space host>/<path>, never under the app's own address. The sidebar entry stays
// { kind: "module", module, screen }; this turns it into the address, and says where to show it. Pure: the screen asks the box for a one-time ticket and calls openHow.

/** @typedef {{ module: string, origin?: string, screens: { id: string, label: string, path?: string }[] }} ModuleScreens */

/** The address of one screen, or null when its module has no known origin or the screen is gone. @param {ModuleScreens[]} modules @param {string} module @param {string} screen */
export function screenUrl(modules, module, screen) {
  const m = modules.find((x) => x.module === module);
  const s = m && m.screens.find((x) => x.id === screen);
  if (!m || !s || typeof m.origin !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(m.origin.replace(/\/+$/, ""))) return null;
  const path = String(s.path ?? s.id).replace(/^\/+/, "");
  if (path.split("/").includes("..")) return null;
  return `${m.origin.replace(/\/+$/, "")}/${path}`;
}

/** Where to show it: in the main pane where the platform can embed a page from another origin (a browser or the Mac and Windows windows), in a new window everywhere else. @param {string} os the platform: "web", "ios", "android" */
export const openHow = (os) => (os === "web" ? "pane" : "window");

/** The address to open once the box answered the ticket request: the ticketed address when it gave one on the same origin, else the plain address (a box without app modules gives none). @param {string} plain @param {any} answer */
export function withTicket(plain, answer) {
  const u = answer && typeof answer.url === "string" ? answer.url : "";
  try { return new URL(u).origin === new URL(plain).origin ? u : plain; } catch { return plain; }
}
