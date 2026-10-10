// @ts-check
// The Kits this build ships, for the Kits page to list and a person to install. A Kit lives in records/kits/<id>/kit.json (the language's stored form, kept in
// step with kit.ts by a test). `kitLibrary()` gives what the page shows before anything is installed: a name, a plain summary and what it adds. `kitFromLibrary(id)`
// gives the Kit in the kernel's form, ready to hand to `kits.card` and then `kits.propose` (a person approves the install card; nothing is installed here).
import fs from "node:fs";
import { toKernelKit } from "../kit-adapter.js";

const ROOT = new URL("./", import.meta.url);

/** Kits that restate the base Kit's types and so need it installed first (`vyre kit deploy` proposes the base Kit before them). */
const REQUIRES = Object.freeze(/** @type {Record<string, string[]>} */ ({ "law-firm": ["base"] }));

/** @returns {string[]} the folder names that hold a kit.json, sorted */
function ids() {
  return fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(new URL(`${d.name}/kit.json`, ROOT))).map((d) => d.name).sort();
}

/** @param {string} id @returns {any} */
function stored(id) {
  if (!/^[a-z][a-z0-9-]*$/.test(id) || !ids().includes(id)) throw Object.assign(new Error(`no Kit ${id} in the library (flows.kit.library lists them)`), { code: "not_found" });
  return JSON.parse(fs.readFileSync(new URL(`${id}/kit.json`, ROOT), "utf8"));
}

/** What a Kit adds, counted in words a person reads. @param {any} k */
function adds(k) {
  const n = (/** @type {any[] | undefined} */ a) => (Array.isArray(a) ? a.length : 0);
  const sealed = (k.types || []).flatMap((/** @type {any} */ t) => (t.fields || []).filter((/** @type {any} */ f) => f.kind === "sealed").map((/** @type {any} */ f) => `${t.name}.${f.name}`));
  return { types: (k.types || []).map((/** @type {any} */ t) => t.name), templates: n(k.templates), roles: n(k.roles), flows: n(k.flows), views: n(k.views), sealed_fields: sealed };
}

/** The Kits on offer. @returns {{ id: string, name: string, version: number, description: string, requires: string[], adds: ReturnType<typeof adds> }[]} */
export function kitLibrary() {
  return ids().map((id) => { const k = stored(id); return { id, name: k.label || id, version: k.version, description: k.description || "", requires: REQUIRES[id] || [], adds: adds(k) }; });
}

/** One Kit in the kernel's form (what `kits.card` and `kits.propose` take). @param {string} id */
export function kitFromLibrary(id) { return toKernelKit(stored(id)); }
