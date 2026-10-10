import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
const gen = (s) => { if (!s || typeof s !== "object") return {}; const o = {}; for (const [k, p] of Object.entries(s.properties || {})) { if (!(s.required || []).includes(k)) continue; o[k] = p.enum ? p.enum[0] : p.type === "number" || p.type === "integer" ? 1 : p.type === "boolean" ? false : p.type === "array" ? [] : p.type === "object" ? {} : "probe"; } return o; };
test("probe", { timeout: 600_000 }, async t => {
  const d = await start({ root: tempHome(t), presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const names = [...d.registry.tools.entries()].filter(([, x]) => x.effect === "write" && !x.internal && !x.hook).map(([n]) => n);
  console.log("WRITE TOOLS", names.length); const t0 = Date.now();
  const token = (await d.kernel.surfaces.open(admin, {})).token;
  const out = { ok_event: 0, ok_none: [], err: 0 };
  for (const n of names) {
    const def = d.registry.tools.get(n);
    if (/stop|uninstall|restart|update|upgrade|reset|wipe|shutdown|kill|spawn|exec|run$|send|publish|deploy|pair|login|install/.test(n)) continue;
    const before = d.kernel.log.read({}).length;
    let r; try { r = await Promise.race([d.registry.call(n, gen(def.input), "cli", { token }), new Promise(res => setTimeout(() => res({ error: { code: "timeout" } }), 3000))]); } catch (e) { r = { error: { code: "threw" } }; }
    console.log("T", n, r && r.error ? "err:" + r.error.code : "ok", Date.now() - t0);
    if (r && r.error) { out.err++; continue; }
    const after = d.kernel.log.read({}).length;
    if (after > before) out.ok_event++; else out.ok_none.push(n);
  }
  console.log("RESULT", JSON.stringify({ ok_event: out.ok_event, err: out.err, none: out.ok_none }));
});
