// @ts-check
// `vyre kit`: the Kits this build ships, and `vyre kit deploy <kit>` to put one on the Space in one step.
//
//   vyre kit                 the Kits on offer, and which are installed or waiting
//   vyre kit deploy <kit>    propose the Kit (and the Kit it needs first, if any) for your yes; nothing installs until you say yes

import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, beacon, signal } from "../style.js";
import { json, emit, failTool, UsageError } from "../kit.js";

export default {
  name: "kit", order: 70, usage: "vyre kit [deploy <kit>] [--json]", summary: "the Kits Vyre ships, and putting one on this Space",
  help: "List them:\n  vyre kit                  the Kits on offer, with what each adds and whether it is installed\nPut one on this Space:\n  vyre kit deploy <kit>     propose the Kit, and the Kit it needs first, in one step. Each waits for your yes in Now; nothing installs until you say it (vyre needs).",
  /** @param {string[]} args */
  async run(args) {
    const words = args.filter(a => !a.startsWith("--"));
    const up = await ensureUp();
    if (!up.ok) { out(beacon("  vyred did not start") + dim(` · its output is in ${up.log}`)); return 1; }
    const lib = await call("flows.kit.library", {});
    if (lib.error) return failTool(lib.error);
    const kits = /** @type {any[]} */ (lib.data.kits);
    const have = await call("flows.kit.list", {});
    const installed = new Map((have.error ? [] : /** @type {any[]} */ (have.data.kits || have.data || [])).filter((/** @type {any} */ k) => !k.status || k.status === "installed").map((/** @type {any} */ k) => [k.id ?? k.kit_id, k]));
    if (words[0] !== "deploy") {
      if (json()) return emit({ kits: kits.map(k => ({ ...k, installed: installed.has(k.id) })) });
      for (const k of kits) out(`  ${k.id.padEnd(18)} ${installed.has(k.id) ? signal("installed") : dim("not installed")}  ${dim(k.description)}`);
      out(dim("\n  vyre kit deploy <kit> puts one on this Space"));
      return 0;
    }
    const id = words[1];
    if (!id) throw new UsageError("vyre kit deploy <kit>");
    const want = kits.find(k => k.id === id);
    if (!want) { out(beacon(`  no Kit ${id}`) + dim(` · ${kits.map(k => k.id).join(", ")}`)); return 1; }
    /** @type {{ kit: string, ok: boolean, said: string }[]} */ const rows = [];
    for (const k of [...want.requires.map((/** @type {string} */ r) => kits.find(x => x.id === r)).filter(Boolean), want]) {
      const have1 = installed.get(k.id);
      if (have1 && Number(have1.version) >= Number(k.version)) { rows.push({ kit: k.id, ok: true, said: `already installed (version ${have1.version})` }); continue; }
      const got = await call("flows.kit.library.get", { id: k.id });
      if (got.error) { rows.push({ kit: k.id, ok: false, said: String(got.error.message || got.error.code) }); break; }
      const r = await call("flows.kit.propose", { kit: got.data.kit });
      if (r.error) { rows.push({ kit: k.id, ok: false, said: String(r.error.message || r.error.code) }); break; }
      const d = r.data;
      rows.push(d && d.ok === false ? { kit: k.id, ok: false, said: `not proposed: ${(d.errors || []).map((/** @type {any} */ e) => e.message).join("; ")}` } : { kit: k.id, ok: true, said: "its card is waiting for your yes" });
      if (d && d.ok === false) break;
    }
    const failed = rows.some(r => !r.ok);
    if (json()) { emit({ kit: id, steps: rows }); return failed ? 1 : 0; }
    for (const r of rows) out(`  ${r.ok ? signal("waiting") : beacon("failed")} ${r.kit}: ${dim(r.said)}`);
    if (!failed && rows.some(r => /waiting/.test(r.said))) out(dim("  next: vyre needs"));
    return failed ? 1 : 0;
  },
};
