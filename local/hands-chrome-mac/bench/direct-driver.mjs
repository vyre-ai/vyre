// @ts-check
// direct-driver: the baseline. Drives Chrome over the DevTools protocol from node, with the
// SAME op vocabulary the real module will expose (tabs.use, page.snapshot, page.fill, page.act,
// batch.run, net.list, api.learn, api.call), so chrome-bench.mjs runs the same scenarios against
// either driver. It follows the design's speed rules: one attach per tab, kept; snapshot and fill
// are one evaluate each; a batch is one evaluate; net.list reads an in-process ring buffer.
// Throwaway runner only: it launches its own Chrome with a remote debugging port.

// Chrome here is always launched through launchChrome (spike/harness/lib.mjs), which spreads CHROME_SAFE (lib/chrome-flags).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cdp, launchChrome, readDevToolsPort, stopProcess } from "../spike/harness/lib.mjs";
import { learn, fillTemplate } from "./api-learn.mjs";
import { expr, snapshotFn, fillFn, centerFn, runStepsFn, fetchFn } from "./page-scripts.mjs";

const RING = 1000;

export class DirectDriver {
  /** @param {Cdp} cdp @param {{child:any, dir:string, version:string}} proc */
  constructor(cdp, proc) {
    this.cdp = cdp; this.proc = proc;
    /** @type {Map<string, {sessionId:string, recs:any[], byId:Map<string,any>}>} */ this.tabs = new Map();
    /** @type {Map<string, string>} */ this.bySession = new Map();
    /** @type {Map<string, any>} */ this.catalogs = new Map();
    /** @type {Map<string, string>} */ this.secrets = new Map();
    cdp.on((method, params, sessionId) => this.onEvent(method, params, sessionId));
  }

  /** @param {{chrome:string, headless?:string|false}} o */
  static async start({ chrome, headless = "new" }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-bench-"));
    const udd = path.join(dir, "profile");
    fs.mkdirSync(udd);
    const { child, logFile } = launchChrome({ chrome, userDataDir: udd, headless, extraArgs: ["--remote-debugging-port=0"], logFile: path.join(dir, "chrome.log") });
    try {
      const { port, wsPath } = await readDevToolsPort(udd);
      const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${wsPath}`);
      return new DirectDriver(cdp, { child, dir, version: String(ver.Browser || "") });
    } catch (e) {
      stopProcess(child);
      let tail = ""; try { tail = fs.readFileSync(logFile, "utf8").slice(-600); } catch { /* none */ }
      throw new Error(`${/** @type {Error} */ (e).message}; chrome log: ${tail}`);
    }
  }

  get version() { return this.proc.version; }

  async close() {
    this.cdp.close();
    stopProcess(this.proc.child);
    setTimeout(() => { try { fs.rmSync(this.proc.dir, { recursive: true, force: true }); } catch { /* best effort */ } }, 1500).unref();
  }

  /** @param {string} method @param {any} params @param {string} [sessionId] */
  onEvent(method, params, sessionId) {
    const id = sessionId && this.bySession.get(sessionId);
    const tab = id && this.tabs.get(id);
    if (!tab) return;
    if (method === "Network.requestWillBeSent") {
      const rec = { id: params.requestId, method: params.request.method, url: params.request.url, requestHeaders: { ...params.request.headers }, postData: params.request.postData, resourceType: params.type, status: undefined, cookie: undefined };
      tab.byId.set(rec.id, rec); tab.recs.push(rec);
      if (tab.recs.length > RING) { const old = tab.recs.shift(); if (old) tab.byId.delete(old.id); }
    } else if (method === "Network.requestWillBeSentExtraInfo") {
      const rec = tab.byId.get(params.requestId);
      if (rec) { const h = params.headers || {}; rec.cookie = h.Cookie || h.cookie || rec.cookie; Object.assign(rec.requestHeaders, h); }
    } else if (method === "Network.responseReceived") {
      const rec = tab.byId.get(params.requestId);
      if (rec) rec.status = params.response.status;
    }
  }

  /** @param {string} targetId */
  async attach(targetId) {
    const have = this.tabs.get(targetId);
    if (have) return have;
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = { sessionId, recs: [], byId: new Map() };
    this.tabs.set(targetId, tab); this.bySession.set(sessionId, targetId);
    await Promise.all([this.cdp.send("Runtime.enable", {}, sessionId), this.cdp.send("Page.enable", {}, sessionId), this.cdp.send("Network.enable", {}, sessionId)]);
    return tab;
  }

  /** @param {string} tabId @param {string} expression */
  async evaluate(tabId, expression) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("tab not attached: " + tabId);
    const r = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, tab.sessionId);
    if (r.exceptionDetails) throw new Error("evaluate: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }

  /** @param {string} tabId @param {string} url */
  async navigate(tabId, url) {
    const tab = /** @type {any} */ (this.tabs.get(tabId));
    const loaded = new Promise(resolve => { const fn = (/** @type {string} */ m, /** @type {any} */ _p, /** @type {string} */ s) => { if (m === "Page.loadEventFired" && s === tab.sessionId) { this.cdp.listeners = this.cdp.listeners.filter(l => l !== fn); resolve(undefined); } }; this.cdp.on(fn); });
    await this.cdp.send("Page.navigate", { url }, tab.sessionId);
    await loaded;
  }

  /** The op vocabulary. @param {string} op @param {any} a */
  async call(op, a = {}) {
    switch (op) {
      case "tabs.use": {
        const { targetInfos } = await this.cdp.send("Target.getTargets");
        const pages = targetInfos.filter((/** @type {any} */ t) => t.type === "page");
        const want = a.url ? new URL(a.url) : null;
        const exact = want && pages.find((/** @type {any} */ t) => t.url === a.url);
        const prefix = want && pages.find((/** @type {any} */ t) => { try { const u = new URL(t.url); return u.origin === want.origin && u.pathname.startsWith(want.pathname); } catch { return false; } });
        const origin = want && pages.find((/** @type {any} */ t) => { try { return new URL(t.url).origin === want.origin; } catch { return false; } });
        const hit = exact || prefix || origin;
        if (hit) { await this.attach(hit.targetId); return { tabId: hit.targetId, reused: true }; }
        if (!a.openIfMissing || !a.url) throw new Error("no tab matches");
        return this.call("tabs.open", a);
      }
      case "tabs.open": {
        const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
        await this.attach(targetId);
        await this.navigate(targetId, a.url);
        return { tabId: targetId, reused: false };
      }
      case "tabs.close": {
        this.tabs.delete(a.tabId);
        await this.cdp.send("Target.closeTarget", { targetId: a.tabId });
        return { closed: true };
      }
      case "tabs.detach": {
        const tab = this.tabs.get(a.tabId);
        if (tab) { this.bySession.delete(tab.sessionId); this.tabs.delete(a.tabId); await this.cdp.send("Target.detachFromTarget", { sessionId: tab.sessionId }); }
        return { detached: true };
      }
      case "tabs.attach": await this.attach(a.tabId); return { attached: true };
      case "page.snapshot": return this.evaluate(a.tabId, expr(snapshotFn));
      case "page.fill": return this.evaluate(a.tabId, expr(fillFn, a.fields));
      case "page.eval": return this.evaluate(a.tabId, a.expression);
      case "page.act": {
        const c = await this.evaluate(a.tabId, expr(centerFn, a.selector));
        if (!c) throw new Error("not found: " + a.selector);
        const tab = /** @type {any} */ (this.tabs.get(a.tabId));
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 }, tab.sessionId);
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 }, tab.sessionId);
        return { clicked: true };
      }
      case "batch.run": {
        const r = await this.evaluate(a.tabId, expr(runStepsFn, a.steps));
        if (r.failed) throw new Error(`batch halted at step ${r.failed.step}: ${r.failed.reason}`);
        return r;
      }
      case "net.list": {
        const tab = this.tabs.get(a.tabId);
        if (!tab) throw new Error("tab not attached");
        const inc = a.filter?.urlIncludes;
        const out = [];
        for (let i = tab.recs.length - 1; i >= 0 && out.length < (a.limit || 200); i--) {
          const r = tab.recs[i];
          if (inc && !r.url.includes(inc)) continue;
          out.push({ id: r.id, method: r.method, url: r.url, status: r.status ?? null, type: r.resourceType, authorization: r.requestHeaders.Authorization || r.requestHeaders.authorization ? "present" : "none" });
        }
        return out;
      }
      case "api.learn": {
        const tab = this.tabs.get(a.tabId);
        if (!tab) throw new Error("tab not attached");
        const cat = learn(tab.recs, { origin: a.origin });
        for (const r of tab.recs) {
          const auth = r.requestHeaders.Authorization || r.requestHeaders.authorization;
          if (auth) { try { this.secrets.set(`${r.method.toUpperCase()} ${new URL(r.url).pathname}`, auth); } catch { /* skip */ } }
        }
        this.catalogs.set(a.tabId, cat);
        return cat;
      }
      case "api.call": {
        const cat = this.catalogs.get(a.tabId);
        const e = cat?.entries.find((/** @type {any} */ x) => x.key === a.key);
        if (!e) throw new Error("not in catalog: " + a.key);
        const origin = new URL(await this.evaluate(a.tabId, "location.href")).origin;
        const p = fillTemplate(e.path, a.ids);
        const qs = a.query ? "?" + new URLSearchParams(a.query).toString() : "";
        /** @type {Record<string,string>} */
        const headers = { Accept: "application/json" };
        if (a.body) headers["Content-Type"] = "application/json";
        const secret = this.secrets.get(`${e.method} ${p}`) || this.secrets.get(`${e.method} ${e.path}`);
        if (e.auth.kind.includes("bearer") && secret) headers.Authorization = secret;
        return this.evaluate(a.tabId, expr(fetchFn, e.method, origin + p + qs, headers, a.body ? JSON.stringify(a.body) : null));
      }
      default: throw new Error("unknown op " + op);
    }
  }
}
