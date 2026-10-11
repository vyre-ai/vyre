// The routes of the app, for the picture tests (G27): every screen file under app/ that is not the shell or a harness page, its address in the web build, and the slug its pictures live under in
// design-refs/routes/. A route with a parameter has an address only when scripts/route-samples.json gives an example. Read by scripts/design-pictures.mjs and test/route-pictures.test.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
/** The shell and the harness pages: not a screen a person uses. */
export const NOT_SCREENS = /(^|\/)_layout\.tsx$|^(gallery|chat-demo|glass-relay-proof|keycheck|notices-proof|terminal-demo)\.tsx$|^shots-[a-z-]+\.tsx$/;

const walk = (dir, rel = "") => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name), path.join(rel, e.name)) : e.name.endsWith(".tsx") ? [path.join(rel, e.name)] : []);
/** The picture folder for a route file: u/now.tsx -> u--now, u/chats/[id].tsx -> u--chats--id, index.tsx -> index. */
export const slugOf = (file) => file.replace(/\.tsx$/, "").replace(/\/index$/, "").replace(/[\[\]]/g, "").replace(/\//g, "--");
/** The address of a route in the web build, or null for one that needs a parameter nobody gave. */
export function urlOf(file, samples = {}) {
  if (/\[/.test(file)) return samples[file] ? `/app${samples[file]}` : null;
  const p = file.replace(/\.tsx$/, "").replace(/(^|\/)index$/, "");
  return `/app/${p}`;
}
/** @returns {{ file: string, slug: string, url: string | null }[]} */
export function routeList() {
  let samples = {};
  try { samples = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "route-samples.json"), "utf8")); } catch { samples = {}; }
  return walk(APP).filter((f) => !NOT_SCREENS.test(f)).sort().map((file) => ({ file, slug: slugOf(file), url: urlOf(file, samples) }));
}
