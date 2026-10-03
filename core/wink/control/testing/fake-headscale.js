#!/usr/bin/env node
// A fake `headscale` for unit tests (VYRE_HEADSCALE_BIN points at it). It honours the small CLI
// surface the supervisor uses: `-c CONFIG serve | health | users create|list | nodes list|delete |
// preauthkeys create`, plus `-o json`. State is one JSON file next to the config, so the separate
// CLI processes and the server share it, as the real binary's database does. Test-only extras:
// `fake-add-node NAME IP [TAG]` registers a node, `fake-log LINE` makes the running server print a
// line, `fake-crash` makes it exit. It never prints a key anywhere but the create answer.

import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
let config = "", output = "";
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-c" || argv[i] === "--config") config = argv[++i];
  else if (argv[i] === "-o" || argv[i] === "--output") output = argv[++i];
  else if (argv[i] === "--force") continue;
  else rest.push(argv[i]);
}
const flag = (names) => { for (const n of names) { const i = rest.indexOf(n); if (i >= 0) return rest[i + 1]; } return undefined; };
const text = config ? fs.readFileSync(config, "utf8") : "";
const get = (re) => { const v = (re.exec(text) || [])[1]; return v && v.replace(/^"|"$/g, ""); };
const dir = path.dirname(config);
const statePath = path.join(dir, "fake-state.json");
const sock = get(/^unix_socket: (.*)$/m);
const listen = get(/^listen_addr: (.*)$/m);
const policyFile = get(/^policy:\s*\n\s+mode: .*\n\s+path: (.*)$/m);

const load = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { users: [], nodes: [], keys: [], next: 1 }; } };
const save = (s) => fs.writeFileSync(statePath, JSON.stringify(s), { mode: 0o600 });
const out = (v) => process.stdout.write(output === "json" ? JSON.stringify(v, null, 2) + "\n" : String(typeof v === "string" ? v : JSON.stringify(v)) + "\n");
const die = (m, code = 1) => { process.stderr.write(JSON.stringify({ error: m }) + "\n"); process.exit(code); };
const log = (l) => process.stdout.write(l + "\n");

function reachServer() {
  return new Promise(resolve => {
    const c = net.connect(sock);
    c.on("connect", () => { c.destroy(); resolve(true); });
    c.on("error", () => resolve(false));
  });
}

async function main() {
  const [a, b] = rest;
  if (process.env.FAKE_HS_ARGV_LOG) fs.appendFileSync(process.env.FAKE_HS_ARGV_LOG, JSON.stringify(argv) + "\n");
  if (a === "version") return out("headscale version fake");
  if (a === "serve") return serve();
  if (a === "configtest") return;
  if (!(await reachServer())) die(`connecting to headscale: connecting to ${sock}: context deadline exceeded`);
  const s = load();
  if (a === "health") return out({ ok: true });
  if (a === "users" && b === "create") {
    const name = rest[2];
    if (s.users.find(u => u.name === name)) die("user exists");
    const u = { id: s.next++, name };
    s.users.push(u); save(s); return out(u);
  }
  if (a === "users" && b === "list") return out(s.users);
  if (a === "nodes" && b === "list") return out(s.nodes);
  if (a === "nodes" && b === "delete") {
    const id = Number(flag(["-i", "--identifier"]));
    if (!s.nodes.find(n => n.id === id)) die("node not found");
    s.nodes = s.nodes.filter(n => n.id !== id); save(s); return out({});
  }
  if (a === "preauthkeys" && b === "create") {
    const user = Number(flag(["-u", "--user"]));
    if (!s.users.find(u => u.id === user)) die("user not found");
    const exp = flag(["-e", "--expiration"]) || "1h";
    const tags = (flag(["--tags"]) || "").split(",").filter(Boolean);
    let owners = {};
    try { owners = JSON.parse(fs.readFileSync(policyFile, "utf8")).tagOwners || {}; } catch { /* none */ }
    for (const t of tags) if (!owners[t]) die(`tag ${t} is not defined in tagOwners`);
    const key = "hskey-auth-fake-" + crypto.randomBytes(12).toString("hex");
    const rec = { id: s.next++, user: { id: user }, key, reusable: rest.includes("--reusable"), ephemeral: rest.includes("--ephemeral"), used: false, expiration: exp, acl_tags: tags };
    s.keys.push({ ...rec, key: undefined }); save(s); return out(rec);
  }
  if (a === "fake-add-node") {
    const node = { id: s.next++, name: b, ip_addresses: [rest[2]], tags: rest[3] ? [rest[3]] : [], node_key: "nodekey:" + crypto.randomBytes(8).toString("hex"), online: true };
    s.nodes.push(node); save(s); return out(node);
  }
  if (a === "fake-log" || a === "fake-crash") {
    const c = net.connect(sock); c.end(JSON.stringify({ cmd: a, line: rest.slice(1).join(" ") })); return;
  }
  die("unknown command " + rest.join(" "), 2);
}

function serve() {
  try { fs.rmSync(sock, { force: true }); } catch { /* none */ }
  const [host, port] = [listen.slice(0, listen.lastIndexOf(":")), Number(listen.slice(listen.lastIndexOf(":") + 1))];
  const web = http.createServer((req, res) => {
    log(`INF http request method=${req.method} path=${req.url} remote=${req.socket.remoteAddress}:${req.socket.remotePort} xff=${req.headers["x-forwarded-for"] || ""}`);
    if (req.url === "/health") { res.end("{}"); return; }
    res.statusCode = 200; res.end("fake");
  });
  web.listen(port, host, () => log("INF listening " + listen));
  const ctl = net.createServer(c => {
    let buf = "";
    c.on("data", d => {
      buf += d;
      try {
        const m = JSON.parse(buf);
        if (m.cmd === "fake-log") log(m.line);
        if (m.cmd === "fake-crash") process.exit(3);
      } catch { /* a bare connect check */ }
    });
  });
  ctl.listen(sock, () => { fs.chmodSync(sock, 0o600); log("INF admin socket " + sock); });
  process.on("SIGHUP", () => log("INF policy reloaded"));
  process.on("SIGTERM", () => { try { fs.rmSync(sock, { force: true }); } catch { /* gone */ } process.exit(0); });
}

main().catch(e => die(String(e && e.message)));
