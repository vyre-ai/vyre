// @ts-check
// extension-driver: the later mode. Drives the REAL extension through the module bridge, using the
// same neutral op vocabulary as direct-driver.mjs. The bridge module is given with --bridge <file>
// and must export `async function connect(opts) -> { call(op, args), close() }`, where call() is
// the module's tool call (the same ops as proto.js: tabs.use, page.snapshot, ...). Until that
// module lands this fails fast with a clear message. Step shapes below are the bench's guess at
// batch.run's arguments and should be aligned with the real extension when it exists.

import { pathToFileURL } from "node:url";
import path from "node:path";

/** Neutral bench steps to batch.run steps. @param {Array<{op:string,selector:string,value?:string}>} steps */
export function toProtoSteps(steps) {
  return steps.map(s => s.op === "click"
    ? { op: "page.act", args: { selector: s.selector, action: "click" } }
    : { op: "page.fill", args: { fields: [{ selector: s.selector, value: s.value }] } });
}

export class ExtensionDriver {
  /** @param {{call:(op:string,args:any)=>Promise<any>, close?:()=>Promise<any>|any}} bridge */
  constructor(bridge) { this.bridge = bridge; this.version = "extension"; }

  /** @param {{bridge?:string, opts?:any}} o */
  static async start({ bridge, opts = {} }) {
    if (!bridge) throw new Error("--extension needs --bridge <module exporting connect(opts)>; the module bridge has not landed yet, use --direct-cdp for the baseline");
    const mod = await import(pathToFileURL(path.resolve(bridge)).href);
    if (typeof mod.connect !== "function") throw new Error("bridge module must export connect(opts)");
    return new ExtensionDriver(await mod.connect(opts));
  }

  /** @param {string} op @param {any} a */
  call(op, a = {}) {
    if (op === "batch.run") return this.bridge.call(op, { ...a, steps: toProtoSteps(a.steps) });
    return this.bridge.call(op, a);
  }

  async close() { await this.bridge.close?.(); }
}
