// @ts-check
// chrome-bench: p50/p95 of the operations the deep Chrome control design promises to make fast
// (ADR 0049): page.snapshot, page.fill of 12 fields, page.act click, tabs reuse (and the cost of
// opening instead), a 20-step batch against 20 separate calls, net.list, and the API-learning path
// (api.learn, api.call) on a GoHighLevel-shaped fixture with a bearer header plus a cookie.
//
//   node chrome-bench.mjs --direct-cdp [--iters 30] [--out result.json] [--chrome <path>]
//       baseline: Chrome for Testing with a remote debugging port, driven from node. Throwaway
//       runner only. Runs today, no extension needed.
//   node chrome-bench.mjs --extension --bridge <module>
//       later: the real extension through the module bridge (see extension-driver.mjs).
//
// Prints one JSON summary and one human line, and appends the line to the Actions step summary.
// The fixture pages are local (fixtures/server.mjs on 127.0.0.1); no external site is ever loaded.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, resolveChrome, stats, timeIt, sleep, stepSummary } from "../spike/harness/lib.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";
import { DirectDriver } from "./direct-driver.mjs";
import { ExtensionDriver } from "./extension-driver.mjs";
import { CHECKOUT_FIELDS, WORKFLOW_STEPS, CHECKOUT_PATH, GHL_PATH } from "./scenarios.mjs";

/** One line for humans. @param {any} r */
export function humanLine(r) {
  const o = r.ops || {};
  const f = (/** @type {string} */ k) => (o[k] && o[k].p50 !== undefined ? `${o[k].p50}/${o[k].p95}` : "n/a");
  return `chrome-bench ${r.mode} ${r.os} ${r.chrome}: p50/p95 ms snapshot ${f("page.snapshot")}, fill12 ${f("page.fill.12")}, act ${f("page.act.click")}, tabs.use ${f("tabs.use.reuse")} (open ${f("tabs.open")}), batch20 ${f("batch.20.single")} vs 20 calls ${f("batch.20.sequential")}, net.list ${f("net.list")}, api.learn ${f("api.learn")}, api.call ${f("api.call")}${r.errors && Object.keys(r.errors).length ? `; ERRORS in ${Object.keys(r.errors).join(",")}` : ""}`;
}

/**
 * @param {{call:(op:string,a?:any)=>Promise<any>}} d @param {{url:string, iters:number}} o
 * @returns {Promise<{ops:Record<string,any>, checks:Record<string,any>, errors:Record<string,string>}>}
 */
export async function runScenarios(d, { url, iters }) {
  /** @type {Record<string,any>} */ const ops = {};
  /** @type {Record<string,any>} */ const checks = {};
  /** @type {Record<string,string>} */ const errors = {};
  const scenario = async (/** @type {string} */ name, /** @type {()=>Promise<void>} */ fn) => {
    try { await fn(); } catch (e) { errors[name] = String(/** @type {Error} */ (e).message || e).slice(0, 300); }
  };
  const evalIn = (/** @type {string} */ tabId, /** @type {string} */ expression) => d.call("page.eval", { tabId, expression });

  const checkout = await d.call("tabs.use", { url: url + CHECKOUT_PATH, openIfMissing: true });
  const ghl = await d.call("tabs.open", { url: url + GHL_PATH }).catch(() => d.call("tabs.use", { url: url + GHL_PATH, openIfMissing: true }));
  await sleep(300); // let the ghl page finish its initial fetches
  const cT = checkout.tabId, gT = ghl.tabId;
  const reset = (/** @type {string} */ t) => evalIn(t, "window.__reset()");
  const warmup = 3;

  await scenario("page.snapshot", async () => {
    ops["page.snapshot"] = stats(await timeIt(iters, () => d.call("page.snapshot", { tabId: cT }), { warmup }));
    const s = await d.call("page.snapshot", { tabId: cT });
    checks.snapshotElements = s.count;
  });

  await scenario("page.fill.12", async () => {
    ops["page.fill.12"] = stats(await timeIt(iters, () => d.call("page.fill", { tabId: cT, fields: CHECKOUT_FIELDS }), { warmup, before: () => reset(cT) }));
    const filled = await evalIn(cT, `[${CHECKOUT_FIELDS.map(f => JSON.stringify(f.selector)).join(",")}].filter(s => document.querySelector(s).value !== '').length`);
    checks.fill12Filled = filled;
    if (filled !== 12) throw new Error(`only ${filled} of 12 fields hold a value`);
  });

  await scenario("page.act.click", async () => {
    await reset(cT);
    const before = await evalIn(cT, "window.__promo");
    ops["page.act.click"] = stats(await timeIt(iters, () => d.call("page.act", { tabId: cT, selector: "#apply-promo" }), { warmup }));
    const after = await evalIn(cT, "window.__promo");
    checks.actClicks = after - before;
    if (after - before !== iters + warmup) throw new Error(`expected ${iters + warmup} clicks, page saw ${after - before}`);
  });

  await scenario("tabs.use.reuse", async () => {
    ops["tabs.use.reuse"] = stats(await timeIt(iters, () => d.call("tabs.use", { url: url + CHECKOUT_PATH }), { warmup }));
  });

  await scenario("tabs.open", async () => {
    const n = Math.min(iters, 10);
    const opened = [];
    ops["tabs.open"] = stats(await timeIt(n, async i => { const r = await d.call("tabs.open", { url: `${url}${CHECKOUT_PATH}?n=${i}` }); opened.push(r.tabId); }));
    for (const t of opened) await d.call("tabs.close", { tabId: t }).catch(() => {});
  });

  await scenario("tabs.attach", async () => {
    const n = Math.min(iters, 10);
    const spare = await d.call("tabs.open", { url: `${url}${CHECKOUT_PATH}?spare=1` });
    ops["tabs.attach"] = stats(await timeIt(n, async () => { await d.call("tabs.attach", { tabId: spare.tabId }); }, { before: () => d.call("tabs.detach", { tabId: spare.tabId }) }));
    await d.call("tabs.close", { tabId: spare.tabId }).catch(() => {});
  });

  const waitSaved = async () => { for (let i = 0; i < 40; i++) { if (await evalIn(gT, "window.__state.saved")) return true; await sleep(50); } return false; };
  const workflowState = () => evalIn(gT, "({saved: window.__state.saved, steps: window.__state.steps.length, trigger: window.__state.trigger})");

  await scenario("batch.20.sequential", async () => {
    const n = Math.min(iters, 20);
    ops["batch.20.sequential"] = stats(await timeIt(n, async () => {
      for (const s of WORKFLOW_STEPS) {
        if (s.op === "click") await d.call("page.act", { tabId: gT, selector: s.selector });
        else await d.call("page.fill", { tabId: gT, fields: [{ selector: s.selector, value: s.value }] });
      }
    }, { warmup: 1, before: () => reset(gT) }));
    await waitSaved();
    checks.sequential = await workflowState();
    if (!checks.sequential.saved || checks.sequential.steps !== 3) throw new Error("workflow not built by 20 separate calls: " + JSON.stringify(checks.sequential));
  });

  await scenario("batch.20.single", async () => {
    const n = Math.min(iters, 20);
    ops["batch.20.single"] = stats(await timeIt(n, () => d.call("batch.run", { tabId: gT, steps: WORKFLOW_STEPS }), { warmup: 1, before: () => reset(gT) }));
    await waitSaved();
    checks.batch = await workflowState();
    if (!checks.batch.saved || checks.batch.steps !== 3) throw new Error("workflow not built by batch.run: " + JSON.stringify(checks.batch));
  });

  await scenario("net.list", async () => {
    await evalIn(gT, "Promise.all(Array.from({length:100},(_,i)=>window.__api('GET','/api/contacts?limit=5&page='+((i%12)+1)))).then(r=>r.length)");
    await sleep(200);
    const n = Math.max(iters, 50);
    ops["net.list"] = stats(await timeIt(n, () => d.call("net.list", { tabId: gT, filter: { urlIncludes: "/api/" } }), { warmup }));
    checks.netListed = (await d.call("net.list", { tabId: gT, filter: { urlIncludes: "/api/" } })).length;
  });

  await scenario("api.learn", async () => {
    ops["api.learn"] = stats(await timeIt(Math.min(iters, 20), () => d.call("api.learn", { tabId: gT, origin: url }), { warmup }));
    const cat = await d.call("api.learn", { tabId: gT, origin: url });
    checks.catalogEntries = cat.entries.map((/** @type {any} */ e) => `${e.key} [${e.auth.kind}]`);
    const contacts = cat.entries.find((/** @type {any} */ e) => e.key === "GET /api/contacts");
    if (!contacts || contacts.auth.kind !== "bearer+cookie") throw new Error("catalog missed GET /api/contacts with bearer+cookie: " + JSON.stringify(checks.catalogEntries));
  });

  await scenario("api.call", async () => {
    let last;
    ops["api.call"] = stats(await timeIt(Math.min(iters, 30), async () => { last = await d.call("api.call", { tabId: gT, key: "GET /api/contacts", query: { limit: 5, page: 1 } }); }, { warmup }));
    checks.apiCallStatus = last && /** @type {any} */ (last).status;
    if (checks.apiCallStatus !== 200) throw new Error("api.call did not return 200: " + JSON.stringify(last));
  });

  return { ops, checks, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.extension ? "extension" : "direct-cdp";
  if (!args["direct-cdp"] && !args.extension) { console.error("usage: chrome-bench.mjs --direct-cdp | --extension --bridge <module> [--iters N] [--out file] [--chrome path]"); process.exit(2); }
  const iters = Number(args.iters) || 30;
  const server = await startFixtureServer();
  /** @type {any} */ let driver;
  let chromeVersion = "";
  try {
    if (mode === "direct-cdp") {
      const c = resolveChrome({ chrome: typeof args.chrome === "string" ? args.chrome : undefined });
      driver = await DirectDriver.start({ chrome: c.path });
      chromeVersion = driver.version || c.version;
    } else {
      driver = await ExtensionDriver.start({ bridge: typeof args.bridge === "string" ? args.bridge : undefined, opts: { fixture: server.url } });
      chromeVersion = "extension";
    }
    const t0 = Date.now();
    const { ops, checks, errors } = await runScenarios(driver, { url: server.url, iters });
    const result = { tool: "chrome-bench", mode, os: `${process.platform}-${os.arch()}`, node: process.version, chrome: chromeVersion, iters, fixtureRequests: server.stats, totalMs: Date.now() - t0, ops, checks, errors, at: new Date().toISOString() };
    const line = humanLine(result);
    console.log(JSON.stringify(result, null, 2));
    console.log(line);
    stepSummary(`- ${line}`);
    if (typeof args.out === "string") { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(result, null, 2)); }
    process.exitCode = Object.keys(errors).length ? 1 : 0;
  } finally {
    await driver?.close();
    await server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => setTimeout(() => process.exit(process.exitCode || 0), 2000).unref(), e => { console.error(e); process.exit(1); });
}
