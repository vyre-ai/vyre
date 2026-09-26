// @ts-check
// Taildrop: files.send on the Mac and the inbox receiver on the box, inside a real Registry, with a
// fake tailscale binary. The fake records every call, answers `status --json` from a file the test
// writes, and for `file get --loop` drops one file in the inbox, prints the --verbose line, and
// waits until it is killed, like the real one blocking in tailscaled.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { unavailable, parseWrote } from "./drop.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOX_ID = "nBox000CNTRL";

const FAKE = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(args) + "\\n");
if (args[0] === "status") { process.stdout.write(fs.readFileSync(path.join(dir, "status.json"), "utf8")); process.exit(0); }
if (args[0] === "file" && args[1] === "cp") process.exit(0);
if (args[0] === "file" && args[1] === "get") {
  const inbox = args[args.length - 1];
  fs.writeFileSync(path.join(dir, "get.pid"), String(process.pid));
  fs.writeFileSync(path.join(inbox, "report (1).pdf"), "hello");
  process.stderr.write("wrote report.pdf as " + path.join(inbox, "report (1).pdf") + " (5 bytes)\\n");
  setInterval(() => {}, 1 << 30);
} else process.exit(1);
`;

/** A temp home with the fake tailscale in it, pointed to by VYRE_TAILSCALE_BIN until the test ends. */
function fake(t, status) {
  const home = tempHome(t);
  const bin = path.join(home, "ts");
  fs.mkdirSync(bin);
  const file = path.join(bin, "tailscale");
  fs.writeFileSync(file, FAKE, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  fs.writeFileSync(path.join(bin, "status.json"), JSON.stringify(status));
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = file;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });
  const calls = () => { try { return fs.readFileSync(path.join(bin, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const pid = () => { try { return Number(fs.readFileSync(path.join(bin, "get.pid"), "utf8")); } catch { return 0; } };
  return { home, calls, pid };
}

const peer = extra => ({ ID: BOX_ID, DNSName: "box.tail0000.ts.net.", HostName: "box", TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
  Online: true, Tags: [], TaildropTarget: 1, NoFileSharingReason: "", ...extra });
const running = peers => ({ BackendState: "Running", Self: { ID: "nMac", DNSName: "mac.tail0000.ts.net." }, Peer: Object.fromEntries(peers.map((p, i) => [`k${i}`, p])) });

/** A Registry with files (and, on the Mac, a stand-in link module answering link.status) running. */
async function registry(t, home, { role, files, link = null }) {
  const vh = path.join(home, "vh");
  const p = config.ensure(vh);
  const found = discover([CORE]).filter(f => f.manifest && f.manifest.name === "files");
  if (role === "local") {
    const mods = path.join(home, "mods");
    writeModule(mods, "link", { roles: ["local"], does: { tools: ["link.status"] } },
      `export default { async start(ctx) {
        ctx.tool("link.status", { run: async () => (${JSON.stringify(link)}) });
        return { async stop() {} };
      } };`);
    found.push(...discover([mods]));
  }
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role, files }, paths: p, log: () => {} });
  await reg.start(found, { role });
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await reg.stop(); db.close(); };
  t.after(stop);
  assert.equal(reg.modules.get("files").state, "running", reg.modules.get("files").error);
  return { reg, events, stop };
}

const LINKED = { linked: true, box: { address: "https://box.tail0000.ts.net", name: "box", node: "box.tail0000.ts.net", stableId: BOX_ID } };

/** A work folder with one ordinary file and one secret. */
function work(home) {
  const w = path.join(home, "work");
  fs.mkdirSync(w, { recursive: true });
  fs.writeFileSync(path.join(w, "report.pdf"), "hello");
  fs.writeFileSync(path.join(w, ".env"), "KEY=1\n");
  return w;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Generous: the fake tailscale is a node script, started once for status and once for file get, and that is slow on a loaded machine.
const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await new Promise(r => setTimeout(r, 20)); } return true; };

test("drop: unavailable() names why Taildrop cannot reach a peer, and says so for a tagged box", () => {
  assert.equal(unavailable(peer({})), null);
  assert.equal(unavailable(peer({ TaildropTarget: 0 })), null, "an older Tailscale that does not say is tried");
  assert.match(unavailable(peer({ TaildropTarget: 9, Tags: ["tag:box"] })) || "", /tagged device/);
  assert.match(unavailable(peer({ TaildropTarget: 5 })) || "", /offline/);
  assert.match(unavailable(peer({ TaildropTarget: 4, Tags: ["tag:box"] })) || "", /does not allow Taildrop.*tagged device/);
  assert.match(unavailable(peer({ TaildropTarget: 0, NoFileSharingReason: "file sharing not enabled by Tailscale admin" })) || "", /not enabled by Tailscale admin/);
});

test("drop: parseWrote finds the final path even when the name has ' as ' in it", () => {
  assert.deepEqual(parseWrote("wrote a as b.txt as /work/inbox/a as b (1).txt (12 bytes)", "/work/inbox"), { file: "/work/inbox/a as b (1).txt", bytes: 12 });
  assert.deepEqual(parseWrote("2026/09/27 10:00:00 wrote x.pdf as /work/inbox/x.pdf (3 bytes)", "/work/inbox"), { file: "/work/inbox/x.pdf", bytes: 3 });
  assert.equal(parseWrote("waiting for file...", "/work/inbox"), null);
  assert.equal(parseWrote("wrote x as /etc/x (3 bytes)", "/work/inbox"), null);
});

test("drop: files.send refuses what the guard refuses, before Tailscale is asked", async t => {
  const f = fake(t, running([peer({})]));
  const w = work(f.home);
  const { reg } = await registry(t, f.home, { role: "local", files: { roots: [w] }, link: LINKED });
  for (const p of [path.join(w, ".env"), path.join(f.home, "vh", "config.json"), "relative.txt"]) {
    const r = await reg.call("files.send", { path: p }, "cli");
    assert.ok(r.error, p);
  }
  assert.equal((await reg.call("files.send", { path: path.join(w, ".env") }, "cli")).error?.code, "not_available");
  assert.equal((await reg.call("files.send", { path: w }, "cli")).error?.message, "only a file can be sent, not a folder");
  assert.deepEqual(f.calls(), [], "tailscale was never run");
  // Claude, through MCP, is not offered it.
  assert.equal((await reg.call("files.send", { path: path.join(w, "report.pdf") }, "mcp")).error?.code, "denied");
});

test("drop: files.send without a paired box says no_link", async t => {
  const f = fake(t, running([peer({})]));
  const w = work(f.home);
  const { reg } = await registry(t, f.home, { role: "local", files: { roots: [w] }, link: { linked: false, box: null } });
  const r = await reg.call("files.send", { path: path.join(w, "report.pdf") }, "cli");
  assert.equal(r.error?.code, "no_link");
  assert.deepEqual(f.calls(), []);
});

test("drop: files.send answers taildrop_unavailable for a tagged box, a missing peer and a stopped Tailscale", async t => {
  const f = fake(t, running([peer({ TaildropTarget: 9, Tags: ["tag:box"] })]));
  const w = work(f.home);
  const { reg } = await registry(t, f.home, { role: "local", files: { roots: [w] }, link: LINKED });
  const file = path.join(w, "report.pdf");
  const r = await reg.call("files.send", { path: file }, "cli");
  assert.equal(r.error?.code, "taildrop_unavailable");
  assert.match(r.error?.message || "", /tagged device/);
  const statusFile = path.join(f.home, "ts", "status.json");
  fs.writeFileSync(statusFile, JSON.stringify(running([{ ...peer({}), ID: "nSomeoneElse" }])));
  assert.match((await reg.call("files.send", { path: file }, "cli")).error?.message || "", /not among this Mac's tailnet peers/);
  fs.writeFileSync(statusFile, JSON.stringify({ BackendState: "Stopped" }));
  const s = await reg.call("files.send", { path: file }, "cli");
  assert.equal(s.error?.code, "taildrop_unavailable");
  assert.match(s.error?.message || "", /Stopped/);
  assert.ok(f.calls().every(a => a[0] === "status"), "no file cp was tried");
});

test("drop: files.send hands the checked file to tailscale file cp at the box's address, and emits files.sent", async t => {
  const f = fake(t, running([peer({ ID: "nOther", DNSName: "other.tail0000.ts.net.", TailscaleIPs: ["100.64.0.9"] }), peer({})]));
  const w = work(f.home);
  const { reg, events } = await registry(t, f.home, { role: "local", files: { roots: [w] }, link: LINKED });
  const seen = [];
  events.on("files.sent", e => seen.push(e.payload));
  const r = await reg.call("files.send", { path: path.join(w, "report.pdf") }, "capsule");
  assert.deepEqual(r.data, { sent: "report.pdf", bytes: 5, to: "box.tail0000.ts.net" });
  const cp = f.calls().find(a => a[0] === "file");
  assert.deepEqual(cp, ["file", "cp", fs.realpathSync(path.join(w, "report.pdf")), "100.64.0.5:"]);
  assert.deepEqual(seen, [{ name: "report.pdf", bytes: 5, to: "box.tail0000.ts.net" }]);
});

test("drop: the box runs one tailscale file get into a 0700 inbox, announces what arrives, and leaves no process behind", async t => {
  const f = fake(t, running([]));
  const w = path.join(f.home, "work");
  fs.mkdirSync(w);
  const inbox = path.join(w, "inbox");
  const { reg, events, stop } = await registry(t, f.home, { role: "box", files: { roots: [w], inbox } });
  const got = [];
  events.on("files.received", e => got.push(e.payload));
  assert.ok(await until(() => got.length > 0), "files.received was emitted");
  const pid = f.pid();
  assert.ok(pid > 0 && alive(pid), "the receiver is running");
  assert.deepEqual(got, [{ name: "report (1).pdf", path: "report (1).pdf", bytes: 5 }]);
  assert.equal(fs.statSync(inbox).mode & 0o777, 0o700);
  const get = f.calls().filter(a => a[0] === "file");
  assert.deepEqual(get, [["file", "get", "--wait", "--loop", "--conflict=rename", "--verbose", fs.realpathSync(inbox)]]);
  // What arrives is in a files root, so search sees it.
  const s = await reg.call("files.search", { q: "report" }, "cli");
  assert.ok(s.data.results.some(x => x.name === "report (1).pdf"), JSON.stringify(s));
  await stop();
  assert.ok(!alive(pid), "the child is gone after stop");
});

test("drop: the box starts no receiver while Tailscale is not Running, or when the inbox is outside the roots", async t => {
  const f = fake(t, { BackendState: "NeedsLogin" });
  const w = path.join(f.home, "work");
  fs.mkdirSync(w);
  const { stop } = await registry(t, f.home, { role: "box", files: { roots: [w], inbox: path.join(w, "inbox") } });
  assert.ok(await until(() => f.calls().length > 0));
  await new Promise(r => setTimeout(r, 150));
  assert.deepEqual(f.calls(), [["status", "--json"]], "one look at the status, no file get");
  assert.equal(f.pid(), 0);
  assert.ok(!fs.existsSync(path.join(w, "inbox")), "no inbox is made while waiting");
  await stop();

  const g = fake(t, running([]));
  const w2 = path.join(g.home, "work");
  fs.mkdirSync(w2);
  const outside = path.join(g.home, "elsewhere", "inbox");
  const second = await registry(t, g.home, { role: "box", files: { roots: [w2], inbox: outside } });
  assert.ok(await until(() => g.calls().length > 0));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(g.pid(), 0);
  assert.ok(!fs.existsSync(outside), "no folder is made outside the roots");
  await second.stop();
});
