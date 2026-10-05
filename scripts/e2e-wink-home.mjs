// e2e-wink-home.mjs: one home pulls from another home through the relay (the home door of a project move), between TWO real machines (testbox only, never the Mac).
//
//   node scripts/e2e-wink-home.mjs            (the orchestrator: run from anywhere with ssh to both boxes; prints one JSON line per step and PASS/FAIL)
//   node scripts/e2e-wink-home.mjs run --config F     (internal: one real vyred and a control socket on one machine)
//
// SOURCE home (E2E_SOURCE, default testbox2): a real vyred with the relay on. TARGET home (E2E_TARGET, default testbox6): a real vyred with the relay on, and a stand-in relay (relay/node/server.js)
// both use. The source's spaces.moves.pull is a stub (the daemon's registry answers it; the spaces module is off), so what is proven is the DOOR: wink.home-move.open/close on the source and
// wink.home.call on the target, across real daemons and a real relay. Checked: no move open = refused; an open move = a pull crosses and the stub's answer comes back; another space of an
// open move and any other tool = refused at the door (a hand-built stream, not only the caller's own check); a closed move refuses at once, including on a stream already open; an expired move refuses; a
// pull of a full 1 MiB of base64 text crosses and one over the cap is too_large; one request at a time; the per-move rate limit; the box-wide cap on new strange channels.
// What it does NOT prove: a NAT between the boxes, the hosted Cloudflare relay (only the Node relay), the spaces module's own protocol (lib/spaces/move-pull.js is windows').
// Run it from the boxes' persistent clone (E2E_DIR/repo): it never rsyncs. Firewall: comment-tagged ufw rules for the other box's address only, removed at the end. Pids are recorded; nothing is killed by pattern.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const out = (ev, o = {}) => console.log(JSON.stringify({ ev, ...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 30_000, what = "condition") => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(250); } };

const HOSTS = { source: process.env.E2E_SOURCE || "testbox2", target: process.env.E2E_TARGET || "testbox6" };
const BOXDIR = process.env.E2E_DIR || "net-r";               // under the login user's home on both boxes: a directory only this team uses
const CLONE = `${BOXDIR}/repo`;                              // the persistent clone, already at the commit under test
const RUN = `${BOXDIR}/e2e-home`;
const BASE = Number(process.env.E2E_PORT_BASE || 43900);
const P = { relay: BASE, ctlSource: BASE + 1, ctlTarget: BASE + 2 };
const TAG = "wink-home-e2e";

const sh = (host, cmd, o = {}) => execFileSync("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, cmd], { encoding: "utf8", input: o.input, maxBuffer: 64 << 20, stdio: ["pipe", "pipe", o.quiet ? "ignore" : "inherit"], timeout: o.timeout || 180_000 });
const addr = host => execFileSync("ssh", ["-G", host], { encoding: "utf8" }).split("\n").find(l => l.startsWith("hostname ")).slice(9).trim();

function ctl(host, port, body) {
  const s = sh(host, `curl -s --max-time ${body.timeoutS || 120} -X POST http://127.0.0.1:${port}/ctl -H "x-token: $(cat ${RUN}/${port}/ctl.token)" --data-binary @-`, { input: JSON.stringify(body), timeout: ((body.timeoutS || 120) + 20) * 1000 });
  let j; try { j = JSON.parse(s); } catch { throw new Error(`control ${host}:${port} said: ${String(s).slice(0, 300)}`); }
  return j;
}
const leftoverRules = host => { try { return sh(host, `sudo -n ufw status | grep -c ${TAG} || true`, { quiet: true }).trim(); } catch { return "unknown (ssh failed)"; } };

function startRunner(role, cfg) {
  const host = HOSTS[role], dir = `${RUN}/${cfg.ctlPort}`;
  sh(host, `mkdir -p ${dir}`);
  sh(host, `cat > ${dir}/config.json`, { input: JSON.stringify(cfg) });
  const abs = `$HOME/${dir}`;
  sh(host, `cd ${CLONE} && : > ${abs}/runner.log && (setsid nohup nice -n 10 env VYRE_KERNEL=1 VYRE_KERNEL_FILE_KEY=1 VYRE_SEAL_DEV=1 VYRE_SEAL_SOFTWARE=1 VYRE_KERNEL_PATH_RULE=1 node scripts/e2e-wink-home.mjs run --config ${abs}/config.json >> ${abs}/runner.log 2>&1 < /dev/null & echo $! > ${abs}/runner.pid)`);
  return until(() => { try { return sh(host, `test -s ${dir}/ctl.token && curl -s --max-time 3 http://127.0.0.1:${cfg.ctlPort}/health`, { quiet: true }).includes("ok"); } catch { return false; } }, 240_000, `${role} runner`)
    .catch(e => { throw new Error(`${e.message}\n${sh(host, `tail -20 ${dir}/runner.log`, { quiet: true })}`); });
}
function stopRunners() {
  for (const [role, port] of [["source", P.ctlSource], ["target", P.ctlTarget]]) {
    // only the pid this test recorded; the runner closes its own relay and daemon on SIGTERM
    try { sh(HOSTS[role], `p=$(cat ${RUN}/${port}/runner.pid 2>/dev/null); [ -n "$p" ] && kill $p 2>/dev/null; true`, { quiet: true }); } catch { /* gone */ }
  }
}

async function main() {
  const ips = { source: addr(HOSTS.source), target: addr(HOSTS.target) };
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); out(ok ? "pass" : "FAIL", { name, ...(detail ? { detail } : {}) }); return ok; };
  const coded = (r, ...codes) => Boolean(r && r.error && (codes.length === 0 || codes.includes(r.error.code)));
  try {
    stopRunners(); await sleep(1500);
    for (const [r, port] of [["source", P.ctlSource], ["target", P.ctlTarget]]) sh(HOSTS[r], `rm -rf ${RUN}/${port}`);   // every run starts from fresh homes
    // the target hosts the relay; the source reaches it from outside (its address only)
    sh(HOSTS.target, `sudo -n ufw allow from ${ips.source} to any port ${P.relay} proto tcp comment ${TAG} >/dev/null`);
    const common = { relayUrl: `ws://${ips.target}:${P.relay}` };
    await startRunner("target", { ...common, role: "target", ctlPort: P.ctlTarget, startsRelay: true, relayPort: P.relay });
    await startRunner("source", { ...common, role: "source", ctlPort: P.ctlSource });
    out("up", ips);

    const info = await until(() => { const r = ctl(HOSTS.source, P.ctlSource, { cmd: "info" }); return r.route && r.box ? r : null; }, 60_000, "the source's relay route");
    const dial = { route: info.route, box: info.box, relay: common.relayUrl };

    // 1. no move open: nothing is admitted
    let r = ctl(HOSTS.target, P.ctlTarget, { cmd: "call", ...dial, space: "spc_a", request: { t: "hello" }, timeoutS: 40 });
    check("no move open: a pull is refused (the relay does not admit a stranger home)", coded(r), r);

    // 2. open a move: a pull crosses and the stub's answer comes back
    ctl(HOSTS.source, P.ctlSource, { cmd: "open", space: "spc_a", move_id: "mv_a", ttlMs: 3_600_000 });
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "call", ...dial, space: "spc_a", request: { t: "hello" } });
    check("an open move: a pull crosses and the answer comes back", r.data && r.data.stub === true && r.data.echo && r.data.echo.t === "hello", r);
    const seen = ctl(HOSTS.source, P.ctlSource, { cmd: "served" });
    check("the source ran it as the daemon on the stranger's behalf (home:<id>), once", seen.calls.length === 1 && seen.calls[0].caller === "module:vyred" && /^home:/.test(seen.calls[0].onBehalfOf || ""), seen.calls);

    // 3. another space of an open move, and any other tool, are refused AT THE DOOR (a hand-built stream)
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "raw", ...dial, headSpace: "spc_a", tool: "spaces.moves.pull", input: { space: "spc_other", request: {} } });
    check("a pull naming another space than the stream's is refused", coded(r, "bad_input"), r);
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "raw", ...dial, headSpace: "spc_b", tool: "spaces.moves.pull", input: { space: "spc_b", request: {} } });
    check("a space with no move open is refused even while another move is open", coded(r, "denied"), r);
    for (const tool of ["spaces.list", "about.text", "wink.access", "relay.status"]) {
      r = ctl(HOSTS.target, P.ctlTarget, { cmd: "raw", ...dial, headSpace: "spc_a", tool, input: {} });
      check(`any other tool (${tool}) is refused by the door`, coded(r, "denied"), r);
    }
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "call", ...dial, space: "spc_a", request: {}, tool: "spaces.list" });
    check("wink.home.call itself refuses any other tool before dialing", coded(r, "denied"), r);
    const calls = ctl(HOSTS.source, P.ctlSource, { cmd: "served" }).calls;
    check("nothing but the one stub pull ever reached the source's registry", calls.length === 1, calls);

    // 4. the answer cap: a full 1 MiB of base64 text crosses, more is too_large
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "call", ...dial, space: "spc_a", request: { t: "file", chars: 1_048_576 }, timeoutS: 90 });
    check("a full 1 MiB of base64 text crosses", r.data && r.data.chunk && r.data.chunk.length === 1_048_576, r.error || { len: r.data && r.data.chunk && r.data.chunk.length });
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "call", ...dial, space: "spc_a", request: { t: "file", chars: 1_048_576 + 40_000 }, timeoutS: 90 });
    check("an answer over the cap is refused with too_large", coded(r, "too_large"), r.error || "it crossed");
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "call", ...dial, space: "spc_a", request: { t: "fail" } });
    check("the tool's own error code (plan_changed) comes back unchanged", coded(r, "plan_changed"), r);

    // 5. one request at a time, and the per-move rate limit, on one open stream
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "parallel", ...dial, space: "spc_a", n: 4, request: { t: "slow", ms: 1500 } });
    check("two requests at once on a move: one runs, the others are refused (one at a time)", r.ok >= 1 && r.refused >= 1 && r.codes.every(c => c === "rate_limited"), r);
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "many", ...dial, space: "spc_a", n: 260, timeoutS: 170 });
    check("the per-move rate limit refuses after its minute's requests (rate_limited)", r.refusedAt !== null && r.codes.every(c => c === "rate_limited"), r);

    // 6. close revokes: at once, and on a stream that is already open
    const held = ctl(HOSTS.target, P.ctlTarget, { cmd: "hold", ...dial, space: "spc_a", name: "h1" });
    await sleep(61_000);   // the per-move minute passes, so only the close can refuse
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "holdcall", name: "h1", request: { t: "hello" } });
    check("an open stream can pull while the move is open", Boolean(r.data) && held.held === true, r);
    ctl(HOSTS.source, P.ctlSource, { cmd: "close", move_id: "mv_a" });
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "holdcall", name: "h1", request: { t: "hello" } });
    check("wink.home-move.close: the open stream's next request is refused", coded(r), r);
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "call", ...dial, space: "spc_a", request: { t: "hello" }, timeoutS: 40 });
    check("wink.home-move.close: a new pull is refused", coded(r), r);

    // 7. expiry
    ctl(HOSTS.source, P.ctlSource, { cmd: "open", space: "spc_c", move_id: "mv_c", ttlMs: 6000 });
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "call", ...dial, space: "spc_c", request: { t: "hello" } });
    check("a move with a short expiry pulls while it is open", Boolean(r.data), r);
    await sleep(7500);
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "call", ...dial, space: "spc_c", request: { t: "hello" }, timeoutS: 40 });
    check("an expired move is refused", coded(r), r);

    // 8. the box-wide cap on new strange channels
    ctl(HOSTS.source, P.ctlSource, { cmd: "open", space: "spc_d", move_id: "mv_d", ttlMs: 3_600_000 });
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "burst", ...dial, space: "spc_d", n: 16, timeoutS: 170 });
    check("a burst of new channels is capped box-wide per minute", r.failed >= 1 && r.passed >= 1, r);
    await sleep(62_000);
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "call", ...dial, space: "spc_d", request: { t: "hello" } });
    check("after the minute a pull crosses again", Boolean(r.data), r);
  } catch (e) {
    check("the run completed", false, String(e.message).slice(0, 600));
  } finally {
    stopRunners();
    try { sh(HOSTS.target, `sudo -n ufw delete allow from ${ips.source} to any port ${P.relay} proto tcp >/dev/null 2>&1 || true`, { quiet: true }); } catch { /* reported below */ }
    out("cleanup", { ufwRulesLeft: { source: leftoverRules(HOSTS.source), target: leftoverRules(HOSTS.target) } });
  }
  const bad = results.filter(r => !r.ok).length;
  out(bad ? "FAIL" : "PASS", { checks: results.length, failed: bad });
  process.exit(bad ? 1 : 0);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// the runner: one real vyred and a control socket
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
async function runner(args) {
  const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
  const root = path.dirname(args[args.indexOf("--config") + 1]);
  const log = m => { try { fs.appendFileSync(path.join(root, "daemon.log"), `${new Date().toISOString()} ${m}\n`); } catch { /* convenience */ } };
  const imp = f => import(pathToFileURL(path.join(REPO, f)).href);
  const stops = [];
  const stopAll = async () => { for (const f of stops.reverse()) { try { await Promise.race([f(), sleep(5000)]); } catch { /* going down */ } } process.exit(0); };
  process.on("SIGTERM", stopAll); process.on("SIGINT", stopAll);

  if (cfg.startsRelay) {
    const { createRelay } = await imp("relay/node/server.js");
    const relay = createRelay(); await relay.listen(cfg.relayPort, "0.0.0.0"); stops.push(() => relay.close()); out("relay", { port: cfg.relayPort });
  }
  const { start } = await imp("core/daemon/index.js");
  const { HUMAN_ONLY } = await imp("core/presence/index.js");
  const lenient = {
    required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
    verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
    challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }), summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }), enrolled: [], enroll(k) { return { id: "kh", kind: k.kind, name: k.name }; },
  };
  const dRoot = path.join(root, "vyre"); fs.mkdirSync(dRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dRoot, "config.json"), JSON.stringify({ role: "box", name: `e2e-${cfg.role}`, transcripts: [], network: { name: `e2e-${cfg.role}` }, relay: { enabled: true, url: cfg.relayUrl }, wink: { network: false }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root: dRoot, log });
  stops.push(() => d.stop());
  await until(() => { const w = d.registry.modules.get("wink"); return w && w.state === "running" && w.handle && w.handle.homeMoves; }, 60_000, "the wink module");

  // the source's spaces.moves.pull is a stub: the daemon's registry answers it (the spaces module is not part of this proof). Recorded, so the run can say what reached it.
  const served = [];
  const orig = d.registry.call.bind(d.registry);
  d.registry.call = async (tool, input, caller, meta) => {
    if (tool !== "spaces.moves.pull") return orig(tool, input, caller, meta);
    served.push({ tool, caller, onBehalfOf: meta && meta.onBehalfOf });
    const q = (input && input.request) || {};
    if (q.t === "fail") return { error: { code: "plan_changed", message: "the plan moved" } };
    if (q.t === "slow") { await sleep(Number(q.ms) || 1000); return { data: { stub: true, echo: q } }; }
    if (q.t === "file") return { data: { stub: true, chunk: "A".repeat(Number(q.chars) || 10) } };
    return { data: { stub: true, echo: q } };
  };
  const asSpaces = (tool, input) => orig(tool, input, "module:spaces", {});

  const { connect } = await imp("relay/client/client.js");
  const { nodeCrypto } = await imp("relay/client/nodecrypto.js");
  const { peerSession, streamPipe } = await imp("core/wink/node/peer-wire.js");
  /** A hand-built stranger-home stream: the head names a space, the calls are whatever the test sends (the door must refuse what it must). */
  const dialRaw = async ({ relay, route, box }, space) => {
    let k = null;
    const conn = connect({ relay, route, box, name: "a home", crypto: nodeCrypto(), keyStore: { get: async () => k, set: async v => { k = v; } }, homeMove: true, backoff: { min: 300, max: 1000 } });
    const chan = await Promise.race([conn.ready(), sleep(15_000).then(() => { throw Object.assign(new Error("the relay did not admit this home"), { code: "unavailable" }); })]);
    const s = chan.open({ peer: "wink", space: "home", pull: { space } });
    await new Promise((res, rej) => { const t = setTimeout(() => rej(Object.assign(new Error("no head"), { code: "unavailable" })), 10_000); s.onhead = x => { clearTimeout(t); x && x.status === 200 ? res() : rej(Object.assign(new Error(`status ${x && x.status}`), { code: x && x.status === 429 ? "rate_limited" : "denied" })); }; s.onreset = w => { clearTimeout(t); rej(Object.assign(new Error(String(w)), { code: "unavailable" })); }; });
    const session = peerSession(streamPipe(s));
    return { session, close() { try { session.close("done"); } catch { /* closed */ } try { conn.close(); } catch { /* closed */ } } };
  };
  const err = e => ({ error: { code: e.code || "failed", message: String(e.message).slice(0, 300) } });
  const holds = new Map();
  const H = {
    info: async () => { const r = await orig("relay.route.id", {}, "module:vyred", {}); return r.data || {}; },
    open: async b => (await asSpaces("wink.home-move.open", { space: b.space, move_id: b.move_id, to: "spc_target", expires: Date.now() + Number(b.ttlMs) })),
    close: async b => (await asSpaces("wink.home-move.close", { move_id: b.move_id })),
    served: async () => ({ calls: served }),
    call: async b => {
      const r = await asSpaces("wink.home.call", { route: b.route, box: b.box, relay: b.relay, tool: b.tool || "spaces.moves.pull", input: { space: b.space, request: b.request } });
      return r.error ? { error: { code: r.error.code, message: String(r.error.message).slice(0, 300) } } : { data: r.data };
    },
    raw: async b => {
      let c; try { c = await dialRaw(b, b.headSpace); } catch (e) { return err(e); }
      try { return { data: await c.session.call(b.tool, b.input, { timeoutMs: 15_000 }) }; } catch (e) { return err(e); } finally { c.close(); }
    },
    parallel: async b => {
      const c = await dialRaw(b, b.space);
      try {
        const rs = await Promise.allSettled(Array.from({ length: b.n }, () => c.session.call("spaces.moves.pull", { space: b.space, request: b.request }, { timeoutMs: 20_000 })));
        const codes = rs.filter(x => x.status === "rejected").map(x => x.reason.code);
        return { ok: rs.filter(x => x.status === "fulfilled").length, refused: codes.length, codes };
      } finally { c.close(); }
    },
    many: async b => {
      const c = await dialRaw(b, b.space);
      const codes = []; let refusedAt = null;
      try {
        for (let i = 1; i <= b.n; i++) { try { await c.session.call("spaces.moves.pull", { space: b.space, request: { t: "hello" } }, { timeoutMs: 20_000 }); } catch (e) { codes.push(e.code); if (refusedAt === null) refusedAt = i; if (codes.length >= 3) break; } }
        return { refusedAt, codes: [...new Set(codes)] };
      } finally { c.close(); }
    },
    hold: async b => { const c = await dialRaw(b, b.space); holds.set(b.name, c); return { held: true }; },
    holdcall: async b => { const c = holds.get(b.name); if (!c) return err({ code: "no_such_hold", message: b.name }); try { return { data: await c.session.call("spaces.moves.pull", { space: "spc_a", request: b.request }, { timeoutMs: 15_000 }) }; } catch (e) { return err(e); } },
    burst: async b => {
      let passed = 0, failed = 0;
      for (let i = 0; i < b.n; i++) { const r = await H.call({ ...b, request: { t: "hello" } }); if (r.data) passed++; else failed++; }
      return { passed, failed };
    },
  };
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(path.join(root, "ctl.token"), token, { mode: 0o600 });
  const srv = http.createServer((req, res) => {
    if (req.url === "/health") { res.end("ok"); return; }
    if (req.method !== "POST" || req.url !== "/ctl" || req.headers["x-token"] !== token) { res.statusCode = 403; res.end("{}"); return; }
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      let b; try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.statusCode = 400; res.end("{}"); return; }
      const send = o => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? Number(v) : v))); };
      const h = H[b.cmd];
      if (!h) return send({ error: { code: "no_such_cmd", message: String(b.cmd) } });
      try { send(await h(b)); } catch (e) { send({ error: { code: e.code || "failed", message: String(e.message).slice(0, 400) } }); }
    });
  });
  await new Promise(r => srv.listen(cfg.ctlPort, "127.0.0.1", r));
  stops.push(() => srv.close());
  out("ready", { role: cfg.role });
  setInterval(() => {}, 1 << 30);
}

if (process.argv[2] === "run") runner(process.argv.slice(3)).catch(e => { console.error(`Error: ${e.stack || e}`); process.exit(1); });
else main();
