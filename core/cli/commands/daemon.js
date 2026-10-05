// @ts-check
// Commands about vyred itself. `vyre up` lives in up.js. Each is one verb with no sub-verbs, so
// `vyre commands` lists their arguments and flags from the usage line.
//
// --json shapes: down {stopped, wasRunning, pid?} · status {running, version, commit, role, pid,
// uptime, modules:{running, failed}, note?, recall?, memory?} · modules [{name, version, state,
// error?}] · tools [{name, description}] · call: the tool's data (always JSON; one frame under --view).

import { progressLine } from "../../recall/progress.js";
import { label } from "../../daemon/build.js";
import { request, call } from "../../daemon/client.js";
import { stop } from "../daemonctl.js";
import { callAsPerson } from "../presence.js";
import { personIO } from "./presence.js";
import { out, dim, signal, beacon } from "../style.js";
import { readSpace } from "../space-pref.js";
import { EXIT, json, emit, fail, failTool, usage, viewing } from "../kit.js";

export default [
  {
    name: "down", order: 11, usage: "vyre down [--json]", summary: "stop it",
    async run() {
      const r = await stop();
      if (json()) {
        const d = { stopped: r.ok && r.wasRunning, wasRunning: r.wasRunning, ...(r.pid ? { pid: r.pid } : {}) };
        emit(d, { kind: "card", title: "vyred", state: r.ok ? "ok" : "failed",
          fields: [{ label: "vyred", value: !r.wasRunning ? "was not running" : r.ok ? "stopped" : `did not stop within 5 seconds (pid ${r.pid})` }] });
        return r.ok ? 0 : 1;
      }
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
      // A first index, or the first model download, is the one slow thing a fresh install does.
      const recall = progressLine((await call("recall.status")).data);
      // What memory knows about the user, and the model pass's spend; absent when memory is.
      const personal = (await call("memory.stats").catch(() => null))?.data?.personal;
      const mem = memoryLine(personal);
      if (json()) {
        return emit({ running: true, ...d, ...(recall ? { note: recall, recall } : {}), ...(mem ? { memory: personal } : {}), ...(readSpace() ? { space: readSpace() } : {}) }, { kind: "card", title: "vyred", state: d.modules.failed ? "failed" : "ok", fields: [
          { label: "vyred", value: `running · ${label(d)} · ${d.role}` }, { label: "Up", value: `${Math.round(d.uptime / 1000)} s · pid ${d.pid}` },
          { label: "Modules", value: `${d.modules.running} running${d.modules.failed ? `, ${d.modules.failed} failed (vyre modules)` : ""}` },
          ...(mem ? [{ label: "Memory", value: mem.replace(/^memory\s+/, "") }] : []), ...(recall ? [{ label: "Search", value: recall }] : [])] });
      }
      out(`  vyred ${signal("running")} ${dim(`· ${label(d)} · ${d.role} · pid ${d.pid} · up ${Math.round(d.uptime / 1000)}s`)}`);
      if (d.finishing === "waiting") out(`  ${beacon("Finishing the update")} ${dim("· the signed module list is on its way; the modules start by themselves")}`);
      else if (d.finishing === "gave_up") out(`  ${beacon("The update did not finish")} ${dim("· the signed module list never arrived, so no module is running. Run: vyre update")}`);
      out(`  ${d.modules.running} modules running${d.modules.failed ? beacon(` · ${d.modules.failed} failed (vyre modules)`) : ""}`);
      if (d.kernel_note) out(dim(`  ${d.kernel_note}`));
      if (readSpace()) out(`  acting in ${readSpace()} ${dim("· vyre space use --clear to go back to the home's own space")}`);
      if (d.records_store) { const rs = d.records_store; out(`  records: ${rs.store === "twenty" ? "Twenty" : rs.store === "builtin" ? "built-in store" : rs.store} ${dim(`· ${rs.from === "VYRE_STORE" ? "VYRE_STORE" : "default"}${rs.records === null || rs.records === undefined ? "" : ` · ${rs.records} records`}`)}${rs.note ? beacon(`  ${rs.note}`) : ""}`); }
      if (mem) out(`  ${mem}`);
      if (recall) out(dim(`  ${recall}`));
      return 0;
    },
  },
  {
    name: "modules", order: 90, usage: "vyre modules [--json]", summary: "every module and whether it started",
    async run() {
      const r = await request("GET", "/v1/modules");
      if (r.error) return failTool(r.error);
      if (json()) {
        return emit(r.data, { kind: "table", title: "Modules", rows: r.data,
          columns: [{ key: "name", label: "Module" }, { key: "version", label: "Version" }, { key: "state", label: "State" }, { key: "error", label: "Error" }] });
      }
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
      if (json()) return emit(r.data, { kind: "table", title: "Tools", rows: r.data, columns: [{ key: "name", label: "Tool" }, { key: "description", label: "What it does" }] });
      for (const t of r.data) out(`  ${t.name.padEnd(28)} ${dim(t.description)}`);
      return 0;
    },
  },
  {
    name: "call", order: 92, usage: "vyre call [--tty] [--space <name>] <tool> [json]", summary: "run any tool, e.g. vyre call system.echo '{\"text\":\"hi\"}'",
    help: "Prints the tool's data as JSON. A tool that needs you (approving a draft, answering an ask)\nasks you to prove you are here first: Touch ID, or with --tty a code typed back.",
    async run(args) {
      const tty = args.includes("--tty");
      const sAt = args.indexOf("--space");
      if (sAt >= 0 && !args[sAt + 1]) return usage("vyre call: --space needs a space name", "vyre call --space harlow records.me");
      const spaceFlag = sAt >= 0 ? args[sAt + 1] : null;
      // Its output is always JSON, so --json changes nothing and is not the tool's name.
      const [name, input0] = args.filter((a, i) => a !== "--tty" && a !== "--json" && a !== "--space" && !(sAt >= 0 && i === sAt + 1));
      if (!name) return usage("vyre call needs a tool", "vyre tools lists them · vyre call system.echo '{\"text\":\"hi\"}'");
      let input = /** @type {any} */ ({});
      if (input0) { try { input = JSON.parse(input0); } catch { return usage("vyre call: the input must be JSON", `vyre call ${name} '{"key":"value"}'`); } }
      // A space named on the call, or the one `vyre space use` remembered, goes in as `space` for a tool that takes one and was not already given one.
      const wanted = spaceFlag || readSpace();
      if (wanted && input && typeof input === "object" && input.space === undefined) {
        const tl = await request("GET", "/v1/tools");
        const def = !tl.error && Array.isArray(tl.data) ? tl.data.find((/** @type {any} */ t) => t.name === name) : null;
        if (def && def.input && def.input.properties && def.input.properties.space) input = { ...input, space: wanted };
      }
      // A kernel presence proof the owner made on their own device (base64url JSON, 4 KB at most), for a tool the kernel gates (the box wrapper's rollback passes one for modules.list.reset).
      const kp = String(process.env.VYRE_KERNEL_PROOF || "");
      const r = await callAsPerson(name, input, { tty, io: personIO(), ...(/^[A-Za-z0-9_-]{1,5600}$/.test(kp) ? { headers: { "x-vyre-kernel-proof": kp } } : {}) });
      // Under --view it is one frame of the tool's data, or an error frame.
      if (viewing()) return r.error ? failTool(r.error) : emit(r.data);
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
 * you, reading 40% of today's plan share". In plan terms, never dollars: nothing here is a charge
 * (the reads run on the person's Claude plan). null when memory said nothing usable.
 * @param {any} p
 */
export function memoryLine(p) {
  if (!p || typeof p !== "object") return null;
  const n = Number(p.current ?? p.facts);
  if (!Number.isFinite(n)) return null;
  let line = `memory   ${n} ${n === 1 ? "fact" : "facts"} about you`;
  const m = p.model;
  const pct = (a, b) => `${Math.min(100, Math.round((Number(a) / Math.max(1e-9, Number(b))) * 100))}%`;
  if (m && typeof m === "object") {
    if (m.on === false) line += ", reading off";
    else if (Number.isFinite(Number(m.today_usd)) && Number(m.cap_usd) > 0) {
      line += `, reading ${pct(m.today_usd, m.cap_usd)} of today's plan share`;
      // The one-time read of the history that was there before, while it lasts.
      if (Number(m.backfill_usd) > 0 && Number(m.backfill_cap_usd) > 0) line += `, first read ${pct(m.backfill_usd, m.backfill_cap_usd)} of its share`;
      if (Number(m.waiting_turns) > 0) line += `, ${m.waiting_turns} turns to read`;
    }
  }
  return line;
}

/** Exit code for a call's error. bad_input is still 1 here: vyre call has always exited 1 on a tool's error. */
function failCode(error) {
  if (["unreachable", "timeout"].includes(error.code)) return EXIT.UNREACHABLE;
  if (["presence_required", "presence_refused", "presence_denied", "no_terminal"].includes(error.code)) return EXIT.PRESENCE;
  return EXIT.FAILED;
}
