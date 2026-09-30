// @ts-check
// recipe: replay a flow that worked, as one batch (lib/recipes.js). Kept per origin in chrome.storage.session (gone when the browser closes) and,
// only when learning is on, in the site record too. batch.run saves one when it is given a `saveAs` name and every step succeeded.

import { err } from "../lib/err.js";
import { toRecipe, fill } from "../lib/recipes.js";
import { originOf } from "../lib/observe.js";

const KEY = "recipes";
const MAX_PER_ORIGIN = 40;
/** @type {Record<string, Record<string, any>>} */ const memory = {};

/** @param {any} ctx */
const area = ctx => ctx.storage && ctx.storage.session ? ctx.storage : null;
/** @param {any} ctx */
async function load(ctx) {
  try { const s = ctx.storage; if (s && typeof s.get === "function") return (await s.get("session", KEY)) || {}; } catch { /* no storage */ }
  return memory;
}
/** @param {any} ctx @param {Record<string, any>} all */
async function save(ctx, all) {
  Object.assign(memory, all);
  try { if (ctx.storage && typeof ctx.storage.set === "function") await ctx.storage.set("session", { [KEY]: all }); } catch { /* memory only */ }
}
/** @param {any} ctx @param {any} args */
async function originFor(ctx, args) {
  // The tab's own origin, never one a caller names.
  if (typeof args.tabId === "number") { const t = await ctx.tabs.get(args.tabId); return originOf(String(t && (t.pendingUrl || t.url) || "")); }
  return "";
}

/** Remember a recipe (called by batch.run). @param {any} ctx @param {string} origin @param {any} recipe */
export async function remember(ctx, origin, recipe) {
  if (!origin) return null;
  const all = await load(ctx);
  const mine = all[origin] || {};
  const old = mine[recipe.name];
  mine[recipe.name] = { ...recipe, runs: old ? old.runs : 0, fails: old ? old.fails : 0, conf: old ? old.conf : 0.5, savedAt: Date.now() };
  const names = Object.keys(mine);
  if (names.length > MAX_PER_ORIGIN) delete mine[names.sort((a, b) => mine[a].savedAt - mine[b].savedAt)[0]];
  all[origin] = mine;
  await save(ctx, all);
  return mine[recipe.name];
}

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "recipe",
  ops: {
    "recipe.list": async (args, ctx) => {
      const origin = await originFor(ctx, args);
      const all = await load(ctx);
      const mine = origin ? all[origin] || {} : {};
      return { origin, recipes: Object.values(mine).map((/** @type {any} */ r) => ({ name: r.name, steps: r.steps.length, params: r.params, runs: r.runs, fails: r.fails, conf: r.conf, writes: r.steps.filter((/** @type {any} */ s) => s.write).map((/** @type {any} */ s) => s.write) })) };
    },
    /** Replay: the model names the recipe and gives the parameters; everything else is one batch. */
    "recipe.run": async (args, ctx, trust = {}) => {
      const origin = await originFor(ctx, args);
      const all = await load(ctx);
      const r = origin && all[origin] ? all[origin][String(args.name)] : null;
      if (!r) throw err("not_found", `no recipe named ${JSON.stringify(args.name)} for this site; chrome_recipe list shows them`);
      let steps;
      try { steps = fill(r, args.params && typeof args.params === "object" ? args.params : {}); } catch (e) { throw err("bad_request", String(/** @type {any} */ (e).message)); }
      const t0 = Date.now();
      const res = await ctx.call("batch.run", { steps, stopOnError: true, ...(typeof args.tabId === "number" ? { tabId: args.tabId } : {}) }, trust);
      const ok = res && res.ok !== false;
      r.runs++; if (!ok) r.fails++;
      r.conf = ok ? Math.min(1, r.conf + 0.1) : r.conf * 0.6;
      r.p50ms = Math.round(((r.p50ms || Date.now() - t0) + (Date.now() - t0)) / 2);
      await save(ctx, all);
      return { recipe: r.name, ...res, ms: Date.now() - t0, steps: steps.length, conf: Math.round(r.conf * 100) / 100 };
    },
    "recipe.forget": async (args, ctx) => {
      const origin = await originFor(ctx, args);
      const all = await load(ctx);
      const had = !!(origin && all[origin] && all[origin][String(args.name)]);
      if (had) { delete all[origin][String(args.name)]; await save(ctx, all); }
      return { forgotten: had };
    },
  },
};
void area;
