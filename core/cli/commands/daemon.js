// @ts-check
// Commands about vyred itself. `vyre up` lives in up.js.

import { label } from "../../daemon/build.js";
import { request, call } from "../../daemon/client.js";
import { stop } from "../daemonctl.js";
import { callAsPerson } from "../presence.js";
import { out, dim, signal, beacon } from "../style.js";
import { EXIT, json, emit, fail, failTool, usage } from "../kit.js";

export default [
  {
    name: "down", order: 11, usage: "vyre down", summary: "stop it",
    async run() {
      const r = await stop();
      if (json()) { emit({ stopped: r.ok && r.wasRunning, wasRunning: r.wasRunning, ...(r.pid ? { pid: r.pid } : {}) }); return r.ok ? 0 : 1; }
      if (!r.wasRunning) { out("  vyred is not running"); return 0; }
      if (r.ok) { out("  vyred stopped"); return 0; }
      return fail(`vyred did not stop within 5 seconds (pid ${r.pid})`, { next: `kill ${r.pid}, then vyre up` });
    },
  },
  {
    name: "status", order: 12, usage: "vyre status [--json]", summary: "is it running, and what is it running",
    async run() {
      const h = await request("GET", "/v1/health");
      if (h.error) {
        if (json()) return failTool(h.error);
        out(`  vyred ${beacon("not running")} ${dim("· vyre up to start it")}`);
        return EXIT.UNREACHABLE;
      }
      const d = h.data;
      // The first model download is the one slow thing a fresh install does; say so once.
      const why = (await call("recall.status")).data?.vectors?.why;
      // What memory knows about the user, and the model pass's spend; absent when memory is.
      const personal = (await call("memory.stats").catch(() => null))?.data?.personal;
      const mem = memoryLine(personal);
      if (json()) return emit({ running: true, ...d, ...(typeof why === "string" && why.startsWith("downloading") ? { note: why } : {}), ...(mem ? { memory: personal } : {}) });
      out(`  vyred ${signal("running")} ${dim(`· ${label(d)} · ${d.role} · pid ${d.pid} · up ${Math.round(d.uptime / 1000)}s`)}`);
      out(`  ${d.modules.running} modules running${d.modules.failed ? beacon(` · ${d.modules.failed} failed (vyre modules)`) : ""}`);
      if (mem) out(`  ${mem}`);
      if (typeof why === "string" && why.startsWith("downloading")) out(dim(`  ${why}`));
      return 0;
    },
  },
  {
    name: "modules", order: 90, usage: "vyre modules [--json]", summary: "every module and whether it started",
    async run() {
      const r = await request("GET", "/v1/modules");
      if (r.error) return failTool(r.error);
      if (json()) return emit(r.data);
      for (const m of r.data) {
        const state = m.state === "running" ? signal(m.state) : ["failed", "invalid"].includes(m.state) ? beacon(m.state) : dim(m.state);
        out(`  ${String(m.name).padEnd(20)} ${String(m.version || "").padEnd(8)} ${state}${m.error ? dim("  " + m.error) : ""}`);
      }
      return 0;
    },
  },
  {
    name: "tools", order: 91, usage: "vyre tools [--json]", summary: "every tool Claude and the surfaces can call",
    async run() {
      const r = await request("GET", "/v1/tools");
      if (r.error) return failTool(r.error);
      if (json()) return emit(r.data);
      for (const t of r.data) out(`  ${t.name.padEnd(28)} ${dim(t.description)}`);
      return 0;
    },
  },
  {
    name: "call", order: 92, usage: "vyre call [--tty] <tool> [json]", summary: "run any tool, e.g. vyre call system.echo '{\"text\":\"hi\"}'",
    help: "Prints the tool's data as JSON. A tool that needs you (approving a draft, answering an ask)\nasks you to prove you are here first: Touch ID, or with --tty a code typed back.",
    async run(args) {
      const tty = args.includes("--tty");
      // Its output is always JSON, so --json changes nothing and is not the tool's name.
      const [name, input0] = args.filter(a => a !== "--tty" && a !== "--json");
      if (!name) return usage("vyre call needs a tool", "vyre tools lists them · vyre call system.echo '{\"text\":\"hi\"}'");
      let input = {};
      if (input0) { try { input = JSON.parse(input0); } catch { return usage("vyre call: the input must be JSON", `vyre call ${name} '{"key":"value"}'`); } }
      const r = await callAsPerson(name, input, { tty });
      if (r.error) {
        // The code word first, as before: scripts match on it.
        out(beacon(`  ${r.error.code}: `) + r.error.message);
        const code = r.error.code === "no_such_tool" ? "vyre tools lists what this vyred has" : r.error.code === "bad_input" ? `vyre tools shows what ${name} takes` : undefined;
        if (code) out(dim("  next: " + code));
        return failCode(r.error);
      }
      out(JSON.stringify(r.data, null, 2));
      return 0;
    },
  },
];

/**
 * The memory line of vyre status, from memory.stats' `personal` field: "memory   412 facts about
 * you, model pass $0.02 of $0.05 today". null when memory said nothing usable.
 * @param {any} p
 */
export function memoryLine(p) {
  if (!p || typeof p !== "object") return null;
  const n = Number(p.current ?? p.facts);
  if (!Number.isFinite(n)) return null;
  let line = `memory   ${n} ${n === 1 ? "fact" : "facts"} about you`;
  const m = p.model;
  const usd = x => `$${Number(x).toFixed(2)}`;
  if (m && typeof m === "object") {
    if (m.on === false) line += ", model pass off";
    else if (Number.isFinite(Number(m.today_usd)) && Number.isFinite(Number(m.cap_usd))) line += `, model pass ${usd(m.today_usd)} of ${usd(m.cap_usd)} today`;
  }
  return line;
}

/** Exit code for a call's error. bad_input is still 1 here: vyre call has always exited 1 on a tool's error. */
function failCode(error) {
  if (["unreachable", "timeout"].includes(error.code)) return EXIT.UNREACHABLE;
  if (["presence_required", "presence_refused", "presence_denied", "no_terminal"].includes(error.code)) return EXIT.PRESENCE;
  return EXIT.FAILED;
}
