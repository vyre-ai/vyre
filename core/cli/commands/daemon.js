// @ts-check
// Commands about vyred itself.

import fs from "node:fs";
import { request, call } from "../../daemon/client.js";
import { ensureUp, stop } from "../daemonctl.js";
import { callAsPerson } from "../presence.js";
import { out, dim, signal, beacon } from "../style.js";
import * as config from "../../config/index.js";

export default [
  {
    name: "up", order: 10, summary: "start vyred on this machine",
    async run() {
      const r = await ensureUp();
      if (r.ok && !r.started) { out(`  vyred is already running ${dim("· " + config.paths().socket)}`); return 0; }
      if (r.ok) { out(`  vyred ${signal("running")} ${dim("· pid " + r.pid)}`); return 0; }
      out(`  vyred did not start. Its output is in ${r.log}:`);
      try { out(dim(fs.readFileSync(/** @type {string} */ (r.log), "utf8").split("\n").slice(-8).join("\n"))); } catch {}
      return 1;
    },
  },
  {
    name: "down", order: 11, summary: "stop it",
    async run() {
      const r = await stop();
      if (!r.wasRunning) { out("  vyred is not running"); return 0; }
      if (r.ok) { out("  vyred stopped"); return 0; }
      out(beacon("  vyred did not stop within 5 seconds") + dim(` · pid ${r.pid}`));
      return 1;
    },
  },
  {
    name: "status", order: 12, summary: "is it running, and what is it running",
    async run() {
      const h = await request("GET", "/v1/health");
      if (h.error) { out(`  vyred ${beacon("not running")} ${dim("· vyre up to start it")}`); return 1; }
      const d = h.data;
      out(`  vyred ${signal("running")} ${dim(`· ${d.version} · ${d.role} · pid ${d.pid} · up ${Math.round(d.uptime / 1000)}s`)}`);
      out(`  ${d.modules.running} modules running${d.modules.failed ? beacon(` · ${d.modules.failed} failed (vyre modules)`) : ""}`);
      // The first model download is the one slow thing a fresh install does; say so once.
      const why = (await call("recall.status")).data?.vectors?.why;
      if (typeof why === "string" && why.startsWith("downloading")) out(dim(`  ${why}`));
      return 0;
    },
  },
  {
    name: "modules", order: 90, summary: "every module and whether it started",
    async run() {
      const r = await request("GET", "/v1/modules");
      if (r.error) { out("  " + r.error.message); return 1; }
      for (const m of r.data) {
        const state = m.state === "running" ? signal(m.state) : ["failed", "invalid"].includes(m.state) ? beacon(m.state) : dim(m.state);
        out(`  ${String(m.name).padEnd(20)} ${String(m.version || "").padEnd(8)} ${state}${m.error ? dim("  " + m.error) : ""}`);
      }
      return 0;
    },
  },
  {
    name: "tools", order: 91, summary: "every tool Claude and the surfaces can call",
    async run() {
      const r = await request("GET", "/v1/tools");
      if (r.error) { out("  " + r.error.message); return 1; }
      for (const t of r.data) out(`  ${t.name.padEnd(28)} ${dim(t.description)}`);
      return 0;
    },
  },
  {
    name: "call", order: 92, usage: "vyre call [--tty] <tool> [json]", summary: "run any tool, e.g. vyre call system.echo '{\"text\":\"hi\"}'",
    async run(args) {
      const tty = args.includes("--tty");
      const [name, json] = args.filter(a => a !== "--tty");
      if (!name) { out("  vyre call [--tty] <tool> [json]"); return 1; }
      let input = {};
      if (json) { try { input = JSON.parse(json); } catch { out("  the input must be JSON"); return 1; } }
      const r = await callAsPerson(name, input, { tty });
      if (r.error) { out(beacon(`  ${r.error.code}: `) + r.error.message); return 1; }
      out(JSON.stringify(r.data, null, 2));
      return 0;
    },
  },
];
