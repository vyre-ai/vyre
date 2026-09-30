// @ts-check
// extension-driver: drives the REAL extension through the module's bridge, translating the bench's
// neutral op vocabulary (the one direct-driver.mjs speaks, with CSS selectors and bare tab ids)
// into the real ops (page.act with a role/name/identifier selector, tabs.use returning {id}, ...).
// The bridge object is anything with call(op, args) -> result (bridge.js's createBridge().call
// fits directly), so the same adapter runs on a runner with real Chrome and in a unit test with a
// fake.

/**
 * A CSS selector from the fixtures to a real selector. The fixtures use #id and [data-testid="x"],
 * both of which the snapshot reports as `identifier`.
 * @param {string} css
 */
export function toSelector(css) {
  const s = String(css).trim();
  let m = /^#([A-Za-z][\w-]*)$/.exec(s);
  if (m) return { identifier: m[1] };
  m = /^\[data-test-?id="([^"]+)"\]$/.exec(s);
  if (m) return { identifier: m[1] };
  return { name: s };
}

/** Neutral bench steps to batch.run steps. @param {Array<{op:string,selector:string,value?:string}>} steps @param {number} [tabId] */
export function toProtoSteps(steps, tabId) {
  const tab = tabId === undefined ? {} : { tabId };
  return steps.map(s => s.op === "click"
    ? { op: "page.act", args: { ...tab, selector: toSelector(s.selector), kind: "click" } }
    : { op: "page.fill", args: { ...tab, fields: [{ selector: toSelector(s.selector), value: s.value }] } });
}

export class ExtensionDriver {
  /** @param {{call:(op:string,args?:any)=>Promise<any>, close?:()=>Promise<any>|any}} bridge */
  constructor(bridge) { this.bridge = bridge; this.version = "extension"; /** @type {Set<number>} */ this.capturing = new Set(); }

  /** @param {{bridge?:string, opts?:any}} o */
  static async start({ bridge, opts = {} }) {
    if (!bridge) throw new Error("--extension needs --bridge <module exporting connect(opts)>; spike/harness/real.mjs builds one for you on a runner");
    const { pathToFileURL } = await import("node:url");
    const path = await import("node:path");
    const mod = await import(pathToFileURL(path.resolve(bridge)).href);
    if (typeof mod.connect !== "function") throw new Error("bridge module must export connect(opts)");
    return new ExtensionDriver(await mod.connect(opts));
  }

  /** Start capturing a tab's network the first time it is used, so traffic the bench causes is there to list. @param {number} id */
  async capture(id) {
    if (this.capturing.has(id)) return;
    this.capturing.add(id);
    await this.bridge.call("net.start", { tabId: id });
  }

  /** @param {string} op @param {any} a */
  async call(op, a = {}) {
    try { return await this.callOp(op, a); }
    catch (e) { const x = /** @type {any} */ (e); x.message = `${op}: ${x.message}`; throw x; }
  }

  /** @param {string} op @param {any} a */
  async callOp(op, a) {
    const b = this.bridge;
    const { tabId, ...rest } = a;
    switch (op) {
      case "tabs.use": {
        const r = await b.call("tabs.use", { url: rest.url, openIfMissing: rest.openIfMissing });
        await this.capture(r.id);
        return { tabId: r.id, reused: r.reused };
      }
      case "tabs.open": { const r = await b.call("tabs.open", { url: rest.url }); await this.capture(r.id); return { tabId: r.id }; }
      case "tabs.close": return b.call("tabs.close", { tabId });
      case "tabs.attach": return b.call("tabs.attach", { tabId });
      case "tabs.detach": return b.call("tabs.detach", { tabId });
      case "page.eval": { const r = await b.call("page.eval", { tabId, expression: rest.expression }); if (r && r.ok === false) throw new Error(r.error || "eval failed"); return r.value; }
      case "page.snapshot": { const r = await b.call("page.snapshot", { tabId }); return { ...r, count: Array.isArray(r.controls) ? r.controls.length : 0 }; }
      case "page.fill": return okOrThrow(await b.call("page.fill", { tabId, fields: rest.fields.map((/** @type {any} */ f) => ({ selector: toSelector(f.selector), value: f.value })) }));
      case "page.act": return okOrThrow(await b.call("page.act", { tabId, selector: toSelector(rest.selector), kind: "click", asked: true }));
      case "batch.run": return okOrThrow(await b.call("batch.run", { tabId, asked: true, steps: toProtoSteps(rest.steps, tabId) }));
      case "net.list": { const r = await b.call("net.list", { tabId, filter: { url: rest.filter && rest.filter.urlIncludes }, limit: 500 }); return r.requests; }
      case "api.learn": {
        const r = await b.call("api.learn", { tabId });
        return { ...r, entries: (r.entries || []).map((/** @type {any} */ e) => ({ ...e, key: `${e.method} ${e.pathTemplate}`, auth: { kind: e.authKind } })) };
      }
      case "api.call": {
        const cat = await b.call("api.catalog", { tabId });
        const [method, ...p] = String(rest.key).split(" ");
        const entry = (cat.entries || []).find((/** @type {any} */ e) => e.method === method && e.pathTemplate === p.join(" "));
        if (!entry) throw new Error(`no catalog entry ${rest.key}`);
        const r = await b.call("api.call", { tabId, entryId: entry.id, params: { query: rest.query } });
        return { ...r, status: r.status };
      }
      default: return b.call(op, a);
    }
  }

  async close() { await this.bridge.close?.(); }
}

/** @param {any} r */
function okOrThrow(r) { if (r && r.ok === false) throw new Error(String(r.why || (r.error && r.error.message) || "the step did not succeed")); return r; }
