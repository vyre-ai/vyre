// @ts-check
// `vyre hooks`: webhooks from the internet through Funnel (core/hooks). Lists what is open, reads
// what Funnel publishes, and opens or closes one route at a time, each of which needs a person
// (ADR 0004). Vyre never runs the Funnel command; this prints it.

import { call } from "../../daemon/client.js";
import { callAsPerson } from "../presence.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, failTool, usage } from "../kit.js";

const USAGE = "vyre hooks [list|status|on|off|open <name> --scheme hmac-sha256|github|stripe --secret <vault item> [--header <name>]|close <name>]";

/** Every verb run() handles, for `vyre commands --json`; run() refuses any other word. */
export const VERBS = [
  { verb: "list", summary: "the listener and each open route, with its recent deliveries", usage: "[--json]", read: true },
  { verb: "status", summary: "what Funnel publishes, next to what is open, and what to fix", usage: "[--json]", read: true },
  { verb: "on", summary: "start the webhook listener", usage: "[--json]", person: true },
  { verb: "off", summary: "stop the webhook listener", usage: "[--json]", person: true },
  { verb: "open", summary: "open one route, checked with a secret from the vault", usage: "<name> --scheme hmac-sha256|github|stripe --secret <item> [--header <name>] [--json]", person: true },
  { verb: "close", summary: "close one route; vyred answers 404 there", usage: "<name> [--json]", person: true },
];
const fail = r => {
  if (json()) return failTool(r.error);
  const down = ["unreachable", "timeout"].includes(r.error.code);
  out(down ? `  Vyre is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message);
  return 1;
};
/** The usage line, as a usage mistake: exit 2, a JSON error under --json. */
const bad = () => usage(USAGE, "vyre help hooks");
/** --key value pairs after the positional name. */
const flags = args => {
  const o = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) o[args[i].slice(2)] = args[++i];
  return o;
};

async function list() {
  const r = await call("hooks.list");
  if (r.error) return fail(r);
  if (json()) return emit(r.data);
  const d = r.data;
  out(`  listener ${d.listening ? signal(`on ${d.host}:${d.port}`) : d.enabled ? beacon("not listening") : dim("off")}${d.error ? beacon("  " + d.error) : ""}`);
  if (!d.routes.length) { out(dim("  no routes open · vyre hooks open <name> --scheme <scheme> --secret <vault item>")); return 0; }
  for (const x of d.routes) {
    out(`  ${bold(x.path)}  ${dim(`${x.verify.scheme} · ${x.verify.header} · secret ${x.verify.secret} · ${x.deliveries} kept`)}`);
    for (const e of x.recent.slice(0, 3)) out(dim(`      ${e.at} ${e.id} ${e.bytes} bytes`));
  }
  return 0;
}

async function status() {
  const r = await call("hooks.status");
  if (r.error) return fail(r);
  if (json()) return emit(r.data);
  const d = r.data;
  out(`  listener ${d.listening ? signal(`on ${d.host}:${d.port}`) : dim("off")} · funnel attribute ${d.node.funnel ? signal("yes") : beacon("no")} · https ${d.node.https ? signal("yes") : beacon("no")}`);
  if (!d.funnel.read) out(beacon(`  could not read Funnel: ${d.funnel.why}`));
  for (const n of d.routes) out(`  ${bold(n)}  ${d.urls[n] || dim("no public address yet")}`);
  for (const m of d.mismatches) {
    out(`  ${m.harmless ? dim("note") : beacon("fix")} ${m.message}`);
    if (m.fix) out(dim(`      ${m.fix}`));
  }
  if (!d.mismatches.length && d.routes.length) out(signal("  Funnel publishes every open route, and nothing else"));
  out(dim(`  ${d.docker}`));
  return 0;
}

export default {
  name: "hooks", order: 45, usage: "vyre hooks [list|status|on|off|open <name>|close <name>] [--json]", summary: "webhooks from the internet through Funnel, one route at a time",
  verbs: VERBS,
  async run(args) {
    const [verb = "list", ...rest] = args.filter(a => a !== "--json");
    if (verb === "list") return list();
    if (verb === "status") return status();
    if (verb === "on" || verb === "off") {
      const r = await callAsPerson("hooks.enable", { on: verb === "on" });
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      out(`  listener ${r.data.listening ? signal(`on ${r.data.host}:${r.data.port}`) : dim("off")}${r.data.error ? beacon("  " + r.data.error) : ""}`);
      return 0;
    }
    const name = rest[0] && !rest[0].startsWith("--") ? rest[0] : "";
    if ((verb === "open" || verb === "close") && !name) return bad();
    if (verb === "open") {
      const f = flags(rest.slice(1));
      const r = await callAsPerson("hooks.open", { name, verify: { scheme: f.scheme, secret: f.secret, ...(f.header ? { header: f.header } : {}) } });
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      out(`  ${bold(r.data.path)} open ${dim(`· ${r.data.verify.scheme} · ${r.data.verify.header}`)}`);
      for (const s of r.data.next) out(dim(`  · ${s}`));
      return 0;
    }
    if (verb === "close") {
      const r = await callAsPerson("hooks.close", { name });
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      out(`  /hooks/${name} closed ${dim("· vyred answers 404 there now")}`);
      out(dim(`  stop publishing it: ${r.data.funnel.close}`));
      if (r.data.funnel.off) out(dim(`  no routes left; turn the Funnel port off: ${r.data.funnel.off}`));
      return 0;
    }
    return bad();
  },
};
