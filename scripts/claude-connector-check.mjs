#!/usr/bin/env node
// A real Claude Code, started with the exact flags Vyre's runner builds (core/switchboard/runner.js argsFor), must list no claude.ai connector and no MCP server but
// Vyre's own in its init message. Run it on a machine where Claude Code is signed in with connectors (the test box), never a person's Mac. Exit 0: clean; 1: a connector
// or another server is loaded; 2: could not run. Prints the server names it saw, never anything else.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argsFor } from "../core/switchboard/runner.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const id = crypto.randomUUID();
const args = argsFor({ id, plugin: path.join(root, "harness"), model: "haiku", budgetUsd: 0.05 });
const child = spawn(process.env.CLAUDE_BIN || "claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"] });
let buf = "", done = false;
const finish = (code, msg) => { if (done) return; done = true; if (msg) console.log(msg); try { child.kill("SIGKILL"); } catch { /* gone */ } process.exit(code); };
setTimeout(() => finish(2, "no init message in 90 s"), 90_000).unref();
child.on("error", () => finish(2, "could not start claude"));
child.stdout.setEncoding("utf8");
child.stdout.on("data", d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "system" && m.subtype === "init") {
      const names = (m.mcp_servers || []).map(s => String(s.name));
      console.log("mcp servers:", JSON.stringify(names));
      const tools = (m.tools || []).filter(t => /^mcp__/.test(t) && !/^mcp__vyre/.test(String(t)));
      finish(names.every(n => n === "vyre") && !tools.length ? 0 : 1, names.every(n => n === "vyre") && !tools.length ? "clean: only Vyre's own server" : `loaded more than Vyre's own: ${names.filter(n => n !== "vyre").join(", ") || tools.slice(0, 3).join(", ")}`);
    }
  }
});
child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
