// The chaos suite for a lent computer (R031-95, DESIGN-run-on-my-computer.md section 5): a real runner module with the real sandbox and encrypted workspace on a lender, a real home (kernel, sealing process, Offers,
// the lent home with its placement book and heartbeat watch), the Wink peer wire between them over TCP, and a fake agent that takes a turn on its own. The orchestrator breaks things and asserts what the person
// would care about: no turn lost, none repeated, the server resumes from the last whole turn, a computer that woke up writes nothing, a workspace is closed before "locked" is said.
// Scenarios: kill -9, sleep (SIGSTOP), a short and a long network outage, lease expiry, clock skew both ways, the Mac's sleep notice, a chat's pipe and door, and the lid shutting in the middle of a chat's turn. Runs only on a hosted runner or a test box, never on a person's Mac (hosted-guard).
//   node scripts/runner-chaos.mjs [scenario ...]        roles home and lender are this same file, started by the orchestrator
import "../core/runner/testing/hosted-guard.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", NK = "nodekey:" + "44".repeat(32);
const DEVICE = "dev_lender";
const LAPSE_MS = 4000, BEAT_MS = 400;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now(), log = (...x) => console.log(String(Math.round((Date.now() - t0) / 100) / 10).padStart(7) + "s", ...x);
const seedOf = d => crypto.createHash("sha256").update("vyre-chaos:" + d).digest();
const privOf = d => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seedOf(d)]), format: "der", type: "pkcs8" });
const pubOf = d => crypto.createPublicKey(privOf(d)).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const [role, ...args] = process.argv.slice(2);

// ---- the home -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
if (role === "home") {
  const [root, port, ctlPort, agentPath] = args;
  const { createKernel } = await import("../kernel/index.js");
  const { canonical, sha256 } = await import("../kernel/core/canonical.js");
  const { startSealer } = await import("../kernel/seal/client.js");
  const { createRemoteServer } = await import("../kernel/remote/server.js");
  const { withKernelCall } = await import("../kernel/remote/wink.js");
  const { admitPeer, socketPipe } = await import("../core/wink/node/peer-wire.js");
  const { createLentHome } = await import("../core/runner/lent-home.js");
  const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
  const used = new Set();
  const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
  fs.mkdirSync(root, { recursive: true });
  const sealer = startSealer({ dir: path.join(root, "seal"), timeoutMs: 8000, dev: true, unattested: true });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence, resolveCredential: async () => ({ secret: "v" }) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants, member = { person: BOB, role: "member" };
  await g.setRole(owner, member, { presence: proof("grants.role", member, `vyre://${SPACE}/member/${BOB}`) });
  const mk = (chain, o) => g.offers.offer(chain, o, { presence: proof("grants.offer", o, `vyre://${SPACE}/offer/new`) });
  await mk(owner, { side: "space_allows", member: BOB });
  await mk(k.chains.fromFacts({ kind: "device", device_key_id: DEVICE, person: BOB, path: "direct" }), { side: "member_accepts", member: BOB, device: DEVICE, device_key: DEVICE });
  const agentDir = path.dirname(agentPath);
  const resumes = path.join(root, "resumes.jsonl");
  const chats = new Map();
  const home = createLentHome({ space: SPACE, root: path.join(root, "lent"), offers: g.offers, leases: k.gateway.leases, lapseMs: LAPSE_MS,
    // a chat's session reaches Vyre's tools through the home (lent.http): here the home answers with what it was asked
    http: async (thread, method, p) => ({ status: 200, body: JSON.stringify({ data: { thread, method, path: p } }) }), chatHas: (chain, id) => { try { g.chats.read(chain, id); return true; } catch { return false; } },
    emit: (type, payload) => console.log(JSON.stringify({ ev: type, ...payload })),
    // the server's continuation of a session its lender gave up or lost: what the server would carry on from is recorded, whole
    resume: async i => {
      const cp = await i.view.checkpoint().catch(() => null), lines = cp ? await i.view.transcript(1, 10000).catch(() => []) : [];
      fs.appendFileSync(resumes, JSON.stringify({ session: i.session, epoch: i.epoch, reason: i.reason, turn: cp ? cp.turn : null, seq: cp ? cp.seq : null, lines: lines.length }) + "\n");
    },
    specFor: async () => ({ command: process.execPath, args: [agentPath], env: { VYRE_AUTO_TURN_MS: "1200" }, routes: [], readOnly: [agentDir, path.dirname(process.execPath)], labels: {}, network: "provider", credentialRoutes: [] }) });
  home.watch(500);
  const server = createRemoteServer({ space: SPACE, kernel: k, services: { lent: home } });
  const dispatch = withKernelCall(async () => { throw Object.assign(new Error("no such tool"), { code: "no_such_tool" }); }, { serverFor: s => (s === SPACE ? server : null), personOf: d => (d === DEVICE ? BOB : null), pathOf: () => "wink" });
  net.createServer(sock => { admitPeer(socketPipe(sock), { id: { nodeKey: NK }, box: "home", entry: eid => (eid === DEVICE ? { eid, kind: "device", pub: pubOf(eid) } : null), serve: (c, tool, input) => dispatch(c, tool, input) }).catch(() => {}); sock.on("error", () => {}); })
    .listen(Number(port), "127.0.0.1");
  // the orchestrator's window onto the home: one JSON line in, one out
  net.createServer(sock => {
    let buf = "";
    sock.on("data", async d => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let out;
        try {
          const c = JSON.parse(line);
          if (c.cmd === "book") out = home.book.get(c.session);
          else if (c.cmd === "checkpoint") { const v = home.view(c.session); out = await v.checkpoint().catch(() => null); }
          else if (c.cmd === "transcript") { const v = home.view(c.session); out = (await v.transcript(1, 100000).catch(() => [])).map(e => e.line); }
          else if (c.cmd === "resumes") out = fs.existsSync(resumes) ? fs.readFileSync(resumes, "utf8").split("\n").filter(Boolean).map(x => JSON.parse(x)) : [];
          else if (c.cmd === "forget") { home.book.forget(c.session); out = true; }
          // a chat's process on the lender (lent spawn): spawn it, write its stdin, read what it said, kill it
          else if (c.cmd === "spawn") {
            const proc = home.spawn({ session: c.session, person: BOB, args: ["--output-format", "stream-json"] });
            const rec = { proc, lines: [], buf: "", closed: null, error: null };
            proc.stdout.on("data", d => { rec.buf += d; let i; while ((i = rec.buf.indexOf("\n")) >= 0) { rec.lines.push(rec.buf.slice(0, i)); rec.buf = rec.buf.slice(i + 1); } });
            proc.on("close", (code, sig) => { rec.closed = [code, sig]; }); proc.on("error", e => { rec.error = e.code; });
            (globalThis.__procs ||= new Map()).set(c.session, rec); out = true;
          }
          else if (c.cmd === "write") { globalThis.__procs.get(c.session).proc.stdin.write(c.text); out = true; }
          else if (c.cmd === "read") { const r = globalThis.__procs.get(c.session); out = { lines: r.lines, up: Boolean(r.proc.lent), closed: r.closed, error: r.error, moved: r.proc.moved || null }; }
          else if (c.cmd === "kill") { out = globalThis.__procs.get(c.session).proc.kill(); }
          else out = { error: "unknown" };
        } catch (e) { out = { error: String(e.message || e) }; }
        sock.write(JSON.stringify({ out }) + "\n");
      }
    });
    sock.on("error", () => {});
  }).listen(Number(ctlPort), "127.0.0.1", () => console.log(JSON.stringify({ ev: "home.ready" })));
}

// ---- the lender -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
else if (role === "lender") {
  const [proxyPort, base, session] = args;
  const { createRemoteKernel } = await import("../kernel/remote/client.js");
  const { winkTransport } = await import("../kernel/remote/wink.js");
  const { joinPeer, socketPipe } = await import("../core/wink/node/peer-wire.js");
  const { default: mod, seams } = await import("../core/runner/index.js");
  const emit = o => console.log(JSON.stringify(o));
  const agentDir = path.join(base, "agent"); fs.mkdirSync(agentDir, { recursive: true });
  fs.copyFileSync(path.join(HERE, "..", "core", "runner", "testing", "fake-agent.js"), path.join(agentDir, "agent.js"));
  const faults = { skew: 0, renewFails: false, shortLeaseMs: Number(process.env.SHORT_LEASE_MS || 0) };
  /** @type {any} */ let wink = null;
  const sessionFor = async () => {
    if (wink && !wink.closed) return wink;
    const sock = net.connect(Number(proxyPort), "127.0.0.1");
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    sock.on("error", () => {});
    wink = await joinPeer(socketPipe(sock), { device: DEVICE, nodeKey: NK, timeoutMs: 1500, sign: m => crypto.sign(null, m, privOf(DEVICE)).toString("base64url") });
    return wink;
  };
  const remote = createRemoteKernel({ space: SPACE, transport: winkTransport({ sessionFor }) });
  const call = async (name, a) => {
    if (name === "leases.renew" && faults.renewFails) throw Object.assign(new Error("the home did not answer"), { code: "unavailable" });
    const r = await remote.call(name, a);
    if (faults.shortLeaseMs && (name === "leases.issue" || name === "leases.renew") && r && r.ttlMs) return { ...r, ttlMs: faults.shortLeaseMs };
    return r;
  };
  const tools = new Map(), handlers = new Map();
  const ctx = {
    paths: { root: base }, config: { role: "local", name: "Chaos Mac" },
    events: { emit: (type, p) => { if (/^runner\./.test(type)) emit({ ev: type, ...p }); for (const f of handlers.get(type) || []) f({ type, payload: p }); }, on: (type, f) => { handlers.set(type, [...(handlers.get(type) || []), f]); return () => handlers.set(type, (handlers.get(type) || []).filter(x => x !== f)); } },
    tool: (n, d) => tools.set(n, d),
    call: async (name, input) => (name === "settings.get" ? { data: { value: { "runner.enabled": true, "runner.plugged_in_only": false, "runner.cpu_percent": 90, "runner.memory_mb": 8192 }[input.key] } } : { data: { devices: [] } }),
    kernel: { owner: BOB, chain: async () => ({ hops: [{ actor: { kind: "person", id: BOB } }] }), for: () => ({ call }), runnerHost: () => ({ identity: async () => ({ deviceId: DEVICE, deviceKey: DEVICE }) }) },
  };
  seams.set(base, { heartbeatMs: BEAT_MS, now: () => Date.now() + faults.skew, state: () => ({ onPower: true, awake: true, cpuPct: 5, memPct: 5 }) });
  process.env.VYRE_CLAUDE_BIN = path.join(agentDir, "agent.js");   // a chat's process the home spawns here runs the fake agent ("claude" resolves to it)
  const h = await mod.start(ctx);
  const run = (tool, input) => tools.get(tool).run(input, { caller: "cli" });
  const r = await run("runner.start", { space: SPACE, session });
  emit({ ev: "lender.started", pid: process.pid, session, resumed: r.resumed });
  let buf = "";
  process.stdin.on("data", d => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try {
        const c = JSON.parse(line);
        if (c.cmd === "emit") ctx.events.emit(c.type, {});
        else if (c.cmd === "skew") { faults.skew = c.ms; emit({ ev: "lender.skewed", ms: c.ms }); }
        else if (c.cmd === "renew") { faults.renewFails = Boolean(c.fail); }
        else if (c.cmd === "here") run("runner.here", {}).then(x => emit({ ev: "lender.here", sessions: x.sessions.length }));
        else if (c.cmd === "exit") { h.stop().finally(() => process.exit(0)); }
      } catch { /* a bad control line */ }
    }
  });
  await sleep(24 * 3600 * 1000);
}

// ---- the orchestrator -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
else {
  const { signalTree } = await import("../core/runner/proctree.js");
  const { driverFor } = await import("../core/runner/workspace.js");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-chaos-"));
  const homeRoot = path.join(work, "home"), agentHome = path.join(work, "agent-home");
  fs.mkdirSync(agentHome, { recursive: true });
  fs.copyFileSync(path.join(HERE, "..", "core", "runner", "testing", "fake-agent.js"), path.join(agentHome, "agent.js"));
  const free = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
  const [homePort, ctlPort, proxyPort] = [await free(), await free(), await free()];
  const children = new Set();
  const spawnLogged = (name, argv, env = {}) => {
    const c = spawn(process.execPath, argv, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], detached: false });
    const events = []; let buf = "";
    c.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { events.push(JSON.parse(l)); } catch { /* a log line */ } if (process.env.CHAOS_VERBOSE) log(name, l.slice(0, 200)); } });
    c.stderr.on("data", d => { if (process.env.CHAOS_VERBOSE || /rror/.test(String(d))) log(name, "stderr", String(d).trim().slice(0, 300)); });
    children.add(c); c.on("exit", () => children.delete(c));
    return { c, events, send: o => c.stdin.write(JSON.stringify(o) + "\n") };
  };
  const home = spawnLogged("home", [SELF, "home", homeRoot, String(homePort), String(ctlPort), path.join(agentHome, "agent.js")]);
  const until = async (what, fn, ms = 30_000) => { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > ms) throw new Error("timed out waiting for " + what); await sleep(100); } };
  await until("the home", () => home.events.some(e => e.ev === "home.ready"), 60_000);
  log("home ready");
  const ctl = cmd => new Promise((res, rej) => { const s = net.connect(ctlPort, "127.0.0.1"); let b = ""; s.on("data", d => { b += d; if (b.includes("\n")) { s.destroy(); res(JSON.parse(b).out); } }); s.on("error", rej); s.write(JSON.stringify(cmd) + "\n"); });
  // a proxy the orchestrator can cut: every connection is destroyed and new ones are refused until it heals
  const proxy = (() => {
    const socks = new Set(); let cut = false;
    const srv = net.createServer(c => {
      if (cut) { c.destroy(); return; }
      const u = net.connect(homePort, "127.0.0.1"); socks.add(c); socks.add(u);
      const end = () => { c.destroy(); u.destroy(); socks.delete(c); socks.delete(u); };
      c.pipe(u); u.pipe(c); for (const s of [c, u]) { s.on("error", end); s.on("close", end); }
    }).listen(proxyPort, "127.0.0.1");
    return { cut: () => { cut = true; for (const s of socks) s.destroy(); }, heal: () => { cut = false; }, close: () => srv.close() };
  })();
  const psList = () => { try { return execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" }).split("\n").map(l => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: Number(m[1]), args: m[2] })); } catch { return []; } };
  const stateOf = pid => { try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()[0] || ""; } catch { return ""; } };
  const sandboxOf = needle => psList().filter(p => p.args.includes(needle) && !/watchdog\.js|runner-chaos\.mjs/.test(p.args) && p.pid !== process.pid);
  const failures = [];
  const check = (cond, what) => { if (cond) log("  ok  ", what); else { log("  FAIL", what); failures.push(what); } };
  const lenderN = { n: 0 };
  /** Start a lender with a session; resolves once its session runs and has taken a first turn. */
  const lend = async (name, env = {}) => {
    const sess = `${name}${++lenderN.n}`, base = path.join(work, "lender-" + sess);
    const l = spawnLogged("lender", [SELF, "lender", String(proxyPort), base, sess], env);
    await until("the session to start", () => l.events.some(e => e.ev === "lender.started"), 90_000);
    await until("a checkpoint at the home", async () => (await ctl({ cmd: "checkpoint", session: sess }))?.turn >= 2, 60_000);
    return { ...l, sess, base, pid: l.c.pid };
  };
  /** The transcript the home holds must be whole: lines numbered from 1 with no gap, and every turn it says it has is a whole turn exactly once. */
  const whole = async (sess, what) => {
    const lines = await ctl({ cmd: "transcript", session: sess }), cp = await ctl({ cmd: "checkpoint", session: sess });
    const results = lines.filter(l => { try { return JSON.parse(l).type === "result"; } catch { return false; } }).length;
    const autos = lines.filter(l => /did auto\d+/.test(l)).map(l => Number(/did auto(\d+)/.exec(l)[1]));
    const dup = new Set(autos).size !== autos.length, gap = autos.some((n, i) => n !== i + 1);
    check(!dup, `${what}: no turn appears twice`);
    check(!gap, `${what}: no turn is missing (auto1..auto${autos.length} in order)`);
    check(cp && results >= cp.turn, `${what}: the checkpoint's turn ${cp && cp.turn} is within the ${results} whole turns held`);
    return { lines, cp };
  };
  const mountedIn = base => { const dir = path.join(base, "runner", "spaces", crypto.createHash("sha256").update(SPACE).digest("hex").slice(0, 16)); try { return driverFor(process.platform, { base: path.join(base, "runner") }).isMounted(dir); } catch { return false; } };
  const killAll = needle => { for (const p of sandboxOf(needle)) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } } };

  const scenarios = {
    async kill9() {
      const l = await lend("kill9");
      const before = await ctl({ cmd: "checkpoint", session: l.sess });
      check(mountedIn(l.base), "the workspace is open while the lender runs (the control: closing it later means something)");
      process.kill(l.pid, "SIGKILL");   // the runner only: what the sandbox does with its agent is part of the test (macOS keeps it alive, the watchdog must end it)
      log("lender killed at checkpoint", before.turn);
      await until("the server to take it", async () => (await ctl({ cmd: "book", session: l.sess }))?.where === "server", 30_000);
      const row = await ctl({ cmd: "book", session: l.sess });
      check(row.reason === "offline" && row.epoch === 2, `the server took the session (reason ${row.reason}, epoch ${row.epoch})`);
      const r = (await ctl({ cmd: "resumes" })).filter(x => x.session === l.sess);
      check(r.length === 1 && r[0].turn >= before.turn, `the server resumed once from the last whole turn (${r[0] && r[0].turn} >= ${before.turn})`);
      await whole(l.sess, "kill -9");
      await until("the workspace to close", () => !mountedIn(l.base), 40_000).then(() => check(true, "the workspace was closed by the watchdog"), () => check(false, "the workspace was closed by the watchdog"));
      await until("the agent to end", () => sandboxOf(path.join(agentHome, "agent.js")).length === 0, 40_000).then(() => check(true, "no process of the dead runner's session is left"), () => { check(false, "no process of the dead runner's session is left"); killAll(path.join(agentHome, "agent.js")); });
    },
    // A chat's process on the lender (lent spawn): turns go down and answers come up; a cut link in the middle loses nothing and repeats nothing.
    async pipe() {
      const l = await lend("pipe");
      const sess = "chatpipe1";
      await ctl({ cmd: "spawn", session: sess });
      await until("the chat's process to start on the lender", async () => (await ctl({ cmd: "read", session: sess })).up, 60_000);
      const said = async text => (await ctl({ cmd: "read", session: sess })).lines.filter(x => x.includes(text)).length;
      await ctl({ cmd: "write", session: sess, text: "turn alpha\n" });
      await until("the first answer", async () => (await said("did alpha")) >= 1, 30_000);
      proxy.cut(); log("link cut"); await ctl({ cmd: "write", session: sess, text: "turn beta\n" }); await sleep(2000); proxy.heal(); log("link healed");
      await until("the answer to the turn asked during the cut", async () => (await said("did beta")) >= 1, 60_000);
      await sleep(1500);
      check((await said("did alpha")) === 1 && (await said("did beta")) === 1, "each turn was answered once, none lost and none repeated");
      await ctl({ cmd: "kill", session: sess });
      await until("the chat's process to end", async () => (await ctl({ cmd: "read", session: sess })).closed, 30_000).then(() => check(true, "a kill from the SDK ended the process"), () => check(false, "a kill from the SDK ended the process"));
      l.send({ cmd: "exit" });
    },
    // A chat's session on the lender reaches Vyre's tools through the runner's door (a unix socket inside the sandbox: bound in on Linux, one seatbelt rule on macOS) and the home answers as that session.
    async door() {
      const l = await lend("door");
      const sess = "chatdoor1";
      await ctl({ cmd: "spawn", session: sess });
      await until("the chat's process to start on the lender", async () => (await ctl({ cmd: "read", session: sess })).up, 60_000);
      await ctl({ cmd: "write", session: sess, text: "vyre system.echo {\"text\":\"hi\"}\n" });
      const reply = await until("the home's answer through the door", async () => (await ctl({ cmd: "read", session: sess })).lines.find(x => x.includes("\"vyre\"")), 30_000).catch(() => null);
      const r = reply ? JSON.parse(reply).reply : null;
      check(r && r.status === 200 && JSON.parse(r.body).data.path === "/v1/tools/system.echo" && JSON.parse(r.body).data.thread === sess, "a tool call through the door reached the home as that session: " + JSON.stringify(r).slice(0, 160));
      await ctl({ cmd: "kill", session: sess });
      l.send({ cmd: "exit" });
    },
    async sleep() {
      const l = await lend("sleep");
      signalTree(l.pid, "SIGSTOP"); log("lender stopped (the lid is shut)");
      await until("the server to take it", async () => (await ctl({ cmd: "book", session: l.sess }))?.where === "server", 30_000);
      const held = (await ctl({ cmd: "transcript", session: l.sess })).length;
      signalTree(l.pid, "SIGCONT"); log("lender woke");
      await until("the lender to be told", () => l.events.some(e => e.ev === "runner.fenced"), 30_000).then(() => check(true, "the woken lender was told the server has the session, and ended it"), () => check(false, "the woken lender was told the server has the session, and ended it"));
      await sleep(2500);
      const after = (await ctl({ cmd: "transcript", session: l.sess })).length;
      check(after === held, `nothing the woken lender said was written (${held} lines before it woke, ${after} after)`);
      await whole(l.sess, "sleep");
      check((await ctl({ cmd: "resumes" })).filter(x => x.session === l.sess).length === 1, "the server resumed it once");
      l.send({ cmd: "exit" });
    },
    async outageShort() {
      const l = await lend("outs");
      proxy.cut(); log("network cut");
      await until("the sessions to freeze", () => { const a = sandboxOf(path.join(agentHome, "agent.js")); return a.length > 0 && a.every(p => stateOf(p.pid) === "T"); }, 15_000).then(() => check(true, "the agent froze after two missed beats"), () => { check(false, "the agent froze after two missed beats"); log("   processes:", JSON.stringify(sandboxOf(path.join(agentHome, "agent.js")).map(p => [p.pid, stateOf(p.pid), p.args.slice(0, 220)]))); });
      await sleep(600); proxy.heal(); log("network back");
      await until("the sessions to run again", () => { const a = sandboxOf(path.join(agentHome, "agent.js")); return a.length > 0 && a.every(p => stateOf(p.pid) !== "T"); }, 15_000).then(() => check(true, "the agent ran again"), () => check(false, "the agent ran again"));
      const row = await ctl({ cmd: "book", session: l.sess });
      check(row.where === "mac" && row.epoch === 1, `still this computer's, nothing moved (epoch ${row.epoch})`);
      const n1 = (await ctl({ cmd: "transcript", session: l.sess })).length; await sleep(2000);
      check((await ctl({ cmd: "transcript", session: l.sess })).length > n1, "turns carry on");
      await whole(l.sess, "short outage");
      l.send({ cmd: "exit" });
    },
    async outageLong() {
      const l = await lend("outl");
      proxy.cut(); log("network cut");
      await until("the server to take it", async () => (await ctl({ cmd: "book", session: l.sess }))?.where === "server", 30_000);
      const held = (await ctl({ cmd: "transcript", session: l.sess })).length;
      proxy.heal(); log("network back");
      await until("the lender to be told", () => l.events.some(e => e.ev === "runner.fenced"), 30_000).then(() => check(true, "the lender was told and ended the session"), () => check(false, "the lender was told and ended the session"));
      await sleep(2000);
      check((await ctl({ cmd: "transcript", session: l.sess })).length === held, "nothing was written after the server took it");
      await whole(l.sess, "long outage");
      l.send({ cmd: "exit" });
    },
    async leaseExpiry() {
      const l = await lend("lease", { SHORT_LEASE_MS: "9000" });
      check(mountedIn(l.base), "the workspace is open while the lease holds");
      l.send({ cmd: "renew", fail: true }); log("renewals fail");
      await until("the session to be handed over", async () => (await ctl({ cmd: "book", session: l.sess }))?.where === "server", 40_000);
      const row = await ctl({ cmd: "book", session: l.sess });
      check(row.reason === "lease-expired", `handed over by the lender with its reason (${row.reason})`);
      await whole(l.sess, "lease expiry");
      await until("the workspace to lock", () => !mountedIn(l.base), 30_000).then(() => check(true, "the workspace was locked and verified closed"), () => check(false, "the workspace was locked and verified closed"));
      l.send({ cmd: "exit" });
    },
    async clockForward() {
      const l = await lend("clockf");
      l.send({ cmd: "skew", ms: 2 * 3600 * 1000 }); log("the lender's clock jumps two hours forward");
      await until("the session to be handed over", async () => (await ctl({ cmd: "book", session: l.sess }))?.where === "server", 40_000);
      const row = await ctl({ cmd: "book", session: l.sess });
      check(["lease-expired", "asleep"].includes(row.reason), `a lease that ran out by the clock hands the session over (${row.reason})`);
      await whole(l.sess, "clock forward");
      l.send({ cmd: "exit" });
    },
    async clockBack() {
      const l = await lend("clockb");
      l.send({ cmd: "skew", ms: -2 * 3600 * 1000 }); log("the lender's clock jumps two hours back");
      await sleep(3000);
      const row = await ctl({ cmd: "book", session: l.sess });
      check(row.where === "mac" && row.epoch === 1, "a clock set back moves nothing");
      const n1 = (await ctl({ cmd: "transcript", session: l.sess })).length; await sleep(1500);
      check((await ctl({ cmd: "transcript", session: l.sess })).length > n1, "turns carry on");
      await whole(l.sess, "clock back");
      l.send({ cmd: "exit" });
    },
    // The lid shuts in the middle of a chat's turn: the computer hands the chat to the server, the SDK hears a move (not a crash), the server resumes from the last WHOLE turn once, and the cut turn is not in what it resumes from.
    async lidMidTurn() {
      const l = await lend("lidturn");
      const sess = "chatlid1";
      await ctl({ cmd: "spawn", session: sess });
      await until("the chat's process to start on the lender", async () => (await ctl({ cmd: "read", session: sess })).up, 60_000);
      const said = async text => (await ctl({ cmd: "read", session: sess })).lines.filter(x => x.includes(text)).length;
      await ctl({ cmd: "write", session: sess, text: "turn alpha\n" });
      await until("the first turn to be whole", async () => (await said("did alpha")) >= 1 && (await ctl({ cmd: "checkpoint", session: sess }))?.turn >= 1, 30_000);
      await ctl({ cmd: "write", session: sess, text: "slowturn 60000 beta\n" });
      await until("the second turn to be under way", async () => (await said("working beta")) >= 1, 30_000);
      l.send({ cmd: "emit", type: "link.sleeping" }); log("the lid shuts in the middle of the second turn");
      await until("the server to take it", async () => (await ctl({ cmd: "book", session: sess }))?.where === "server", 30_000);
      const row = await ctl({ cmd: "book", session: sess });
      check(row.reason === "asleep" || row.reason === "lid-closed", `handed over with its reason (${row.reason})`);
      await until("the chat's process to end for the SDK", async () => (await ctl({ cmd: "read", session: sess })).closed, 30_000);
      const end = await ctl({ cmd: "read", session: sess });
      check(end.moved && end.moved.to === "server" && end.closed[0] === null, `the SDK heard a move to the server, not a crash (${JSON.stringify(end.closed)}, moved ${JSON.stringify(end.moved)})`);
      await until("the server to resume it", async () => (await ctl({ cmd: "resumes" })).some(x => x.session === sess), 30_000);
      const r = (await ctl({ cmd: "resumes" })).filter(x => x.session === sess);
      check(r.length === 1 && r[0].turn === 1, `the server resumed it once, from the last whole turn (${JSON.stringify(r.map(x => x.turn))})`);
      const held = await ctl({ cmd: "transcript", session: sess });
      check(held.some(x => x.includes("did alpha")) && !held.some(x => x.includes("did beta")), "what it resumes from holds the whole turn and not the cut one");
      await sleep(1500);
      check((await ctl({ cmd: "transcript", session: sess })).length === held.length, "the lender wrote nothing after handing over");
      l.send({ cmd: "exit" });
    },
    async sleepNotice() {
      const l = await lend("notice");
      l.send({ cmd: "emit", type: "link.sleeping" });
      await until("the session to be handed over", async () => (await ctl({ cmd: "book", session: l.sess }))?.where === "server", 30_000);
      const row = await ctl({ cmd: "book", session: l.sess });
      check(row.reason === "asleep" || row.reason === "lid-closed", `handed over before the lid shut, with its reason (${row.reason})`);
      const r = (await ctl({ cmd: "resumes" })).filter(x => x.session === l.sess);
      check(r.length === 1, "the server resumed it once");
      const { lines } = await whole(l.sess, "sleep notice");
      const held = lines.length; await sleep(1500);
      check((await ctl({ cmd: "transcript", session: l.sess })).length === held, "the lender wrote nothing after handing over");
      l.send({ cmd: "exit" });
    },
  };

  const want = process.argv.slice(2).filter(x => scenarios[x]);
  let crashed = null;
  try {
    for (const name of want.length ? want : Object.keys(scenarios)) {
      log(`=== ${name}`);
      try { await scenarios[name](); } catch (e) { check(false, `${name}: ${e.message}`); }
      proxy.heal();
    }
  } catch (e) { crashed = e; }
  proxy.close();
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  killAll(work);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* a mount still closing */ }
  if (crashed) console.log("CRASH", crashed);
  console.log(failures.length ? `RESULT: ${failures.length} FAILED\n  ${failures.join("\n  ")}` : "RESULT: ALL PASS");
  process.exit(failures.length || crashed ? 1 : 0);
}
