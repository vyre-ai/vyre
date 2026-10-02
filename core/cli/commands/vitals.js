// @ts-check
// `vyre vitals`: how this device (or the server) is doing — CPU, RAM, disk, network, GPU and
// battery (core/vitals). Read only, never pushes: run it when you want to know, or add a watcher
// on vitals.trouble to hear about sustained trouble.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, failTool, usage } from "../kit.js";

const USAGE = "vyre vitals [status|explain|advice] [--device <name>] [--json]";

/** Every verb run() handles, for `vyre commands --json`. All read only, no presence needed. */
export const VERBS = [
  { verb: "status", summary: "this device's latest sample, 24h minute history, and (on the server) each computer's own", usage: "[--device <name>] [--json]", read: true },
  { verb: "explain", summary: "a compact digest: the top consumer over 15 minutes, open trouble, the trend", usage: "[--device <name>] [--json]", read: true },
  { verb: "advice", summary: "sizing suggestions from the last 30 days of hourly rollups", usage: "[--device <name>] [--json]", read: true },
];

const fail = r => {
  if (json()) return failTool(r.error);
  const down = ["unreachable", "timeout"].includes(r.error.code);
  out(down ? `  Vyre is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message);
  return 1;
};
const bad = () => usage(USAGE, "vyre help vitals");
const pct = v => (typeof v === "number" ? `${Math.round(v)}%` : dim("—"));
/** --key value pairs, so --device works before or after the verb. */
const flags = args => {
  const o = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) o[args[i].slice(2)] = args[++i];
  return o;
};

async function status(device) {
  const r = await call("vitals.status", device ? { device } : {});
  if (r.error) return fail(r);
  if (json()) return emit(r.data);
  const d = r.data;
  if (!d.latest) { out(dim(`  no sample yet for ${d.device} · try again in a moment`)); return 0; }
  const l = d.latest;
  out(`  ${bold(d.device)}  cpu ${pct(l.cpu)} · ram ${pct(l.ram)} · disk ${pct(l.disk)}${typeof l.gpu === "number" ? ` · gpu ${pct(l.gpu)}` : ""}${typeof l.battery === "number" ? ` · battery ${pct(l.battery)}` : ""}`);
  out(dim(`  ${d.history.length} minutes kept in the last 24h`));
  for (const c of d.computers) { const cl = c.latest; out(dim(`      ${c.scope}  cpu ${pct(cl && cl.cpu)} · ram ${pct(cl && cl.ram)}`)); }
  return 0;
}

async function explain(device) {
  const r = await call("vitals.explain", device ? { device } : {});
  if (r.error) return fail(r);
  if (json()) return emit(r.data);
  const d = r.data;
  out(`  ${bold(d.device)}  ${d.top ? `top: ${d.top.metric} at ${pct(d.top.max)}` : dim("nothing stands out")} · cpu ${d.trend.cpu} · ram ${d.trend.ram}`);
  if (!d.trouble.length) out(signal("  no open trouble"));
  for (const t of d.trouble) out(beacon(`  trouble: ${t.metric}${t.scope ? ` (${t.scope})` : ""}`));
  return 0;
}

async function advice(device) {
  const r = await call("vitals.advice", device ? { device } : {});
  if (r.error) return fail(r);
  if (json()) return emit(r.data);
  const d = r.data;
  if (!d.advice.length) { out(dim(`  nothing to size up for ${d.device}`)); return 0; }
  for (const line of d.advice) out(`  ${line}`);
  return 0;
}

export default {
  name: "vitals", order: 46, usage: USAGE, summary: "CPU, RAM, disk, network, GPU and battery, for this device or the server",
  verbs: VERBS,
  async run(args) {
    const rest = args.filter(a => a !== "--json");
    const known = ["status", "explain", "advice"];
    const verb = known.includes(rest[0]) ? rest.shift() : rest[0] && rest[0].startsWith("--") ? "status" : rest[0] ? null : "status";
    if (verb === null) return bad();
    const f = flags(rest);
    if (verb === "status") return status(f.device);
    if (verb === "explain") return explain(f.device);
    return advice(f.device);
  },
};
