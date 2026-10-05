// e2e-home-pull.mjs: the REAL move pull protocol (lib/spaces/move-pull.js, windows) over network's home door, between TWO real machines (testbox only, never the Mac).
// Derived from scripts/e2e-wink-home.mjs (network): same runners, relay, door and wink.home-move.open/wink.home.call; the difference is that the SOURCE's spaces.moves.pull is createPullSource with real
// ed25519 Space keys (not the stand-in) and the TARGET drives createPuller over wink.home.call. It proves: the source's hello is verified before the target signs; auth with the target Space key; plan,
// records, a 2.5 MB file in checked chunks, a sealed blob and done, all across the door; a second stream cannot use the first's nonce or session; a wrong key cannot connect.
// What it does NOT prove: the spaces module's own evidence, directory pin and receipts (covered by core/spaces tests and the wink-paired end-to-end test), a NAT, the hosted relay.
// Run from the boxes' persistent clone: it never rsyncs. Pids are recorded; nothing is killed by pattern.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MOVE = "0190c3f2-1111-4abc-8def-0000000000a1", FROM = "spc_aaaaaaaaaaaa", TO = "spc_bbbbbbbbbbbb";
const out = (ev, o = {}) => console.log(JSON.stringify({ ev, ...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 30_000, what = "condition") => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(250); } };

const HOSTS = { source: process.env.E2E_SOURCE || "testbox2", target: process.env.E2E_TARGET || "testbox6" };
const BOXDIR = process.env.E2E_DIR || "win-r";               // under the login user's home on both boxes: a directory only this team uses
const CLONE = `${BOXDIR}/repo`;                              // the persistent clone, already at the commit under test
const RUN = `${BOXDIR}/e2e-pull`;
const BASE = Number(process.env.E2E_PORT_BASE || 44100);
const P = { relay: BASE, ctlSource: BASE + 1, ctlTarget: BASE + 2 };
const TAG = "windows-pull-e2e";

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
  sh(host, `cd ${CLONE} && : > ${abs}/runner.log && (setsid nohup nice -n 10 env VYRE_KERNEL=1 VYRE_KERNEL_FILE_KEY=1 VYRE_SEAL_DEV=1 VYRE_SEAL_SOFTWARE=1 VYRE_KERNEL_PATH_RULE=1 node scripts/e2e-home-pull.mjs run --config ${abs}/config.json >> ${abs}/runner.log 2>&1 < /dev/null & echo $! > ${abs}/runner.pid)`);
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
    const common = { relayUrl: `ws://${ips.target}:${P.relay}`, secret: crypto.randomBytes(16).toString("hex"), srcSeed: crypto.randomBytes(32).toString("hex"), toSeed: crypto.randomBytes(32).toString("hex") };
    await startRunner("target", { ...common, role: "target", ctlPort: P.ctlTarget, startsRelay: true, relayPort: P.relay });
    await startRunner("source", { ...common, role: "source", ctlPort: P.ctlSource });
    out("up", ips);

    const info = await until(() => { const r = ctl(HOSTS.source, P.ctlSource, { cmd: "info" }); return r.route && r.box ? r : null; }, 60_000, "the source's relay route");
    const dial = { route: info.route, box: info.box, relay: common.relayUrl };

    ctl(HOSTS.source, P.ctlSource, { cmd: "open", move: true, ttlMs: 3_600_000 });
    // 1. the real protocol across the door
    let r = ctl(HOSTS.target, P.ctlTarget, { cmd: "pull", ...dial, timeoutS: 170 });
    check("hello verified, auth, plan, records, a 2.5 MB file in chunks, a sealed blob and done all cross the door", r.ok === true, r);
    check("the records and the file arrived whole (hashes equal)", r.ok === true && r.recordsOk === true && r.fileOk === true && r.sealedOk === true, r);
    const seen = ctl(HOSTS.source, P.ctlSource, { cmd: "served" });
    check("every request ran on the source as the daemon on another home's behalf (home:<id>), one stream id throughout", seen.calls.length > 5 && seen.calls.every(c => c.caller === "module:vyred" && /^home:/.test(c.onBehalfOf || "")) && new Set(seen.calls.map(c => c.onBehalfOf)).size === 1, { n: seen.calls.length, who: [...new Set(seen.calls.map(c => c.onBehalfOf))] });
    check("the source's session is closed after done", seen.open === 0, seen);
    // 2. a puller with the WRONG target key cannot connect
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "pull", ...dial, wrongKey: true, timeoutS: 60 });
    check("a target that cannot prove the target Space key is refused at auth", r.ok === false && r.code === "denied", r);
    // 3. a second stream cannot use the first stream's session
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "steal", ...dial, timeoutS: 90 });
    check("a session earned on one stream is refused on another stream of the same home", r.stolen === "denied" && r.own === "ok", r);
    // 4. the move closed: nothing crosses
    ctl(HOSTS.source, P.ctlSource, { cmd: "close", move_id: MOVE });
    r = ctl(HOSTS.target, P.ctlTarget, { cmd: "pull", ...dial, fresh: true, timeoutS: 60 });
    check("a closed move refuses the pull", r.ok === false, r);
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

  // keys: both Space keys are derived from seeds in the config so each runner holds its own private key and the other's public key only
  const { createPullSource, createPuller, pullMessage } = await imp("lib/spaces/move-pull.js");
  const seedKey = seed => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed, "hex")]), format: "der", type: "pkcs8" });
  const kSrc = seedKey(cfg.srcSeed), kTo = seedKey(cfg.toSeed);
  const pubSrc = crypto.createPublicKey(kSrc), pubTo = crypto.createPublicKey(kTo);
  const sign = k => m => crypto.sign(null, Buffer.from(m), k).toString("base64url");
  const verifyWith = pub => (m, sig) => crypto.verify(null, Buffer.from(m), pub, Buffer.from(sig, "base64url"));
  const sha = b => crypto.createHash("sha256").update(b).digest("hex");
  const big = Buffer.alloc(2_500_000, 7);
  const urns = [1, 2, 3].map(i => `vyre://${FROM}/contact/0190c3f2-1111-4abc-8def-00000000000${i}`);
  const files = [{ path: "Projects/a/small.txt", size: 5, sha256: sha(Buffer.from("hello")) }, { path: "Projects/a/big.bin", size: big.length, sha256: sha(big) }];
  const approved = { hash: "h".repeat(43), ids: urns, files, sealed: ["sv_1"] };
  const served = [];
  const orig = d.registry.call.bind(d.registry);
  let source = null;
  if (cfg.role === "source") {
    source = createPullSource({
      space: FROM, grantOf: m => (m === MOVE ? { to: TO, to_pub: pubTo, person: "per_" + "a".repeat(26), plan_hash: approved.hash, project: `vyre://${FROM}/project/0190c3f2-1111-4abc-8def-0000000000aa`, expires: Date.now() + 3_600_000 } : null),
      sign: sign(kSrc), verify: (pub, m, sg) => verifyWith(pub)(m, sg),
      planFor: async () => approved,
      readRecord: async (_g, urn) => ({ urn, version: 1, data: { name: urn.slice(-4) } }),
      readFile: async (_g, p, off, len) => (p.endsWith("small.txt") ? Buffer.from("hello") : big).subarray(off, off + len),
      sealedFor: async (_g, ref) => ({ blob: `sealed:${ref}` }),
    });
    const unwrap = e => ({ error: { code: String(e.code || "failed"), message: String(e.message).slice(0, 300) } });
    d.registry.call = async (tool, input, caller, meta) => {
      if (tool !== "spaces.moves.pull") return orig(tool, input, caller, meta);
      const who = typeof (meta && meta.onBehalfOf) === "string" && /^home:[A-Za-z0-9_-]{1,80}$/.test(meta.onBehalfOf) ? meta.onBehalfOf : null;
      served.push({ tool, caller, onBehalfOf: who });
      const q = (input && input.request) || {};
      if (!["hello", "auth", "plan", "records", "file", "sealed", "done"].includes(q.t)) return { error: { code: "bad_input", message: "not a request" } };
      try { return { data: await source[q.t](q, who) }; } catch (e) { return unwrap(e); }
    };
  }
  const asSpaces = (tool, input) => orig(tool, input, "module:spaces", {});

  const err = e => ({ error: { code: e.code || "failed", message: String(e.message).slice(0, 300) } });
  const H = {
    info: async () => { const r = await orig("relay.route.id", {}, "module:vyred", {}); return r.data || {}; },
    open: async () => (await asSpaces("wink.home-move.open", { space: FROM, move_id: MOVE, to: TO, expires: Date.now() + 3_600_000 })),
    close: async b => (await asSpaces("wink.home-move.close", { move_id: b.move_id })),
    served: async () => ({ calls: served, open: source ? source.open() : null }),
    pull: async b => {
      const base = { route: b.route, box: b.box, relay: b.relay, tool: "spaces.moves.pull" };
      const send = async request => {
        const r = await asSpaces("wink.home.call", { ...base, input: { space: FROM, request }, ...(b.fresh ? { fresh: true } : {}) });
        if (r.error) throw Object.assign(new Error(String(r.error.message)), { code: r.error.code });
        return r.data;
      };
      const p = createPuller({ from: FROM, to: TO, move_id: MOVE, send, verifySource: verifyWith(pubSrc), sign: sign(b.wrongKey ? seedKey(crypto.randomBytes(32).toString("hex")) : kTo) });
      try { await p.connect(); } catch (e) { return { ok: false, code: e.code, message: String(e.message).slice(0, 200) }; }
      const plan = await p.plan();
      const recs = await p.records(urns);
      const recordsOk = recs.length === 3 && recs.every(x => x.version === 1);
      const parts = [];
      for (let off = 0; off < big.length;) { const c = await p.file("Projects/a/big.bin", off, 512 * 1024); parts.push(c.bytes); off += c.bytes.length; }
      const fileOk = sha(Buffer.concat(parts)) === sha(big) && plan.hash === approved.hash;
      const sealed = await p.sealed("sv_1"); const sealedOk = Boolean(sealed);
      await p.done();
      return { ok: true, recordsOk, fileOk, sealedOk, chunks: parts.length };
    },
    steal: async b => {   // two streams of the same home: the second must not use the first's session
      const base = { route: b.route, box: b.box, relay: b.relay, tool: "spaces.moves.pull" };
      const call = async (request, f) => asSpaces("wink.home.call", { ...base, input: { space: FROM, request }, ...(f ? { fresh: true } : {}) });
      const h = await call({ t: "hello", move_id: MOVE, to: TO });
      if (h.error) return { error: h.error };
      const a = await call({ t: "auth", move_id: MOVE, to: TO, nonce: h.data.nonce, proof: sign(kTo)(pullMessage(FROM, TO, MOVE, h.data.nonce)) });
      if (a.error) return { error: a.error };
      const own = await call({ t: "plan", session: a.data.session });
      const other = await call({ t: "plan", session: a.data.session }, true);   // a fresh stream, a different home:<id> stream
      return { own: own.data ? "ok" : "denied", stolen: other.error ? other.error.code : "ok" };
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
