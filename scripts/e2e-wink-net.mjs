// e2e-wink-net.mjs: the built-in network between TWO real machines, through the product path (testbox only, never the Mac).
//
//   node scripts/e2e-wink-net.mjs            (the orchestrator: run from anywhere with ssh to both boxes; prints one JSON line per step and PASS/FAIL)
//   node scripts/e2e-wink-net.mjs run --config F      (internal: one real vyred and a control socket, on one machine)
//
// HOME box (E2E_HOME, default testbox6): a real vyred whose Wink module runs netd (a real Headscale, the gate, the node) with `wink.controlUrl` naming the box's own address and a
// fixed `wink.gatePort`, plus a stand-in relay (relay/node/server.js). SERVER box (E2E_SERVER, default testbox2): a real vyred. The two pair with the real flow
// (wink.server.code, wink.pair.server, wink.server.confirm); the home's hand-over (controlUrl, one-time key, node name, door address) goes to the server inside adopt, and the
// server's netjoin joins the home's network and dials the door. Checked: the pairing is done; the server's link says "direct"; a call from the server crosses as device:<sid>;
// the device row is removed on the home and the server's next call cannot cross.
// Then the RELAY FALLBACK: the home drops the server's UDP and its TCP to the gate (iptables raw table, tagged, removed after), the server's link must fall back to the relay, a call must still cross over it
// (the home's server door, status read only), and when the block is lifted the link prefers the direct path again. The server's relay row (kind server) is checked to exist and to be hidden from the device list.
// What it does NOT prove: a NAT between the boxes (both are on public addresses), a name with a TLS gate (controlUrl is plain http to the box's address), IPv6.
// Firewall: comment-tagged ufw rules for the other box's address only, removed at the end (and on failure). Pids are recorded; nothing is killed by pattern.
import fs from "node:fs";
import os from "node:os";
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

const HOSTS = { home: process.env.E2E_HOME || "testbox6", server: process.env.E2E_SERVER || "testbox2" };
const DIR = process.env.E2E_DIR || "net-k/e2e";             // under the login user's home on both boxes: a directory only this test uses
const BASE = Number(process.env.E2E_PORT_BASE || 43800);
const P = { relay: BASE, gate: BASE + 1, ctlHome: BASE + 2, ctlServer: BASE + 3, dir: BASE + 4 };
const TAG = "wink-net-e2e";

const sh = (host, cmd, o = {}) => execFileSync("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, cmd], { encoding: "utf8", input: o.input, maxBuffer: 64 << 20, stdio: ["pipe", "pipe", o.quiet ? "ignore" : "inherit"], timeout: o.timeout || 180_000 });
const addr = host => execFileSync("ssh", ["-G", host], { encoding: "utf8" }).split("\n").find(l => l.startsWith("hostname ")).slice(9).trim();

function ctl(host, port, body) {
  const s = sh(host, `curl -s --max-time ${body.timeoutS || 120} -X POST http://127.0.0.1:${port}/ctl -H "x-token: $(cat ${DIR}/${port}/ctl.token)" --data-binary @-`, { input: JSON.stringify(body), timeout: ((body.timeoutS || 120) + 20) * 1000 });
  let j; try { j = JSON.parse(s); } catch { throw new Error(`control ${host}:${port} said: ${String(s).slice(0, 300)}`); }
  if (j && j.error) throw Object.assign(new Error(`${body.cmd}: ${j.error.message || j.error}`), { code: j.error.code, detail: j });
  return j;
}

function firewall(on, ips) {
  // each box lets only the OTHER box in: the relay and the gate (tcp) on the home; UDP (the nodes find a direct path) on both
  for (const [role, other] of [["home", "server"], ["server", "home"]]) {
    const o = ips[other], host = HOSTS[role];
    const rules = role === "home" ? [`from ${o} to any port ${P.relay} proto tcp`, `from ${o} to any port ${P.dir} proto tcp`, `from ${o} to any port ${P.gate} proto tcp`, `from ${o} proto udp`] : [`from ${o} proto udp`];
    for (const r of rules) {
      if (on) sh(host, `sudo -n ufw allow ${r} comment ${TAG} >/dev/null`);
      else sh(host, `sudo -n ufw delete allow ${r} >/dev/null 2>&1 || true`, { quiet: true });
    }
  }
}
/** Kill the direct path between the two boxes without touching the relay: on the HOME, drop (before connection tracking, so an established flow dies too) the server's UDP and its TCP to the gate port. Tagged and removed exactly. */
function blockDirect(on, ips) {
  for (const sp of [["-p", "udp"], ["-p", "tcp", "--dport", String(P.gate)]]) {
    const r = `PREROUTING -s ${ips.server} ${sp.join(" ")} -m comment --comment ${TAG}-block -j DROP`;
    if (on) sh(HOSTS.home, `sudo -n iptables -t raw -C ${r} 2>/dev/null || sudo -n iptables -t raw -I PREROUTING 1 ${r.slice("PREROUTING ".length)}`);
    else sh(HOSTS.home, `while sudo -n iptables -t raw -D ${r} 2>/dev/null; do :; done`, { quiet: true });
  }
}
const leftoverBlocks = () => { try { return sh(HOSTS.home, `sudo -n iptables -t raw -S PREROUTING | grep -c ${TAG}-block || true`, { quiet: true }).trim(); } catch { return "unknown (ssh failed)"; } };
const leftoverRules = host => { try { return sh(host, `sudo -n ufw status | grep -c ${TAG} || true`, { quiet: true }).trim(); } catch { return "unknown (ssh failed)"; } };

function stage(host) {
  // No rsync from the Mac (slow link): the commit under test is pushed, and each box fetches it into a persistent clone (E2E_REF, default this checkout's HEAD).
  const ref = process.env.E2E_REF || execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  const branch = process.env.E2E_BRANCH || "work/network";
  sh(host, `mkdir -p ${DIR}/bin; [ -d ${DIR}/vyre/.git ] || { rm -rf ${DIR}/vyre; git clone -q https://github.com/vyre-ai/vyre.git ${DIR}/vyre; }; cd ${DIR}/vyre && git fetch -q origin ${branch} && git checkout -qf ${ref} && { [ -d node_modules ] || npm ci --ignore-scripts --silent; }`, { timeout: 600_000 });
}
function ensureBins(host) {
  for (const n of ["headscale", "wink-forwarder"]) {
    if (sh(host, `test -x ${DIR}/bin/${n} && echo y || echo n`).trim() === "y") continue;
    const src = process.env[`E2E_BIN_${n === "headscale" ? "HS" : "FWD"}`] || `/tmp/e2e-${n}`;
    if (!fs.existsSync(src)) throw new Error(`missing ${n}: fetch it to ${src} (scp from a box that has it; see E2E_BIN_HS / E2E_BIN_FWD)`);
    execFileSync("scp", ["-q", src, `${host}:${DIR}/bin/${n}`]);
    sh(host, `chmod 755 ${DIR}/bin/${n}`);
  }
}
function startRunner(role, cfg) {
  const host = HOSTS[role], dir = `${DIR}/${cfg.ctlPort}`;
  sh(host, `mkdir -p ${dir}`);
  sh(host, `cat > ${dir}/config.json`, { input: JSON.stringify(cfg) });
  const abs = `$HOME/${dir}`;
  sh(host, `cd ${DIR}/vyre && : > ${abs}/runner.log && (setsid nohup nice -n 10 env VYRE_KERNEL=1 VYRE_KERNEL_FILE_KEY=1 VYRE_SEAL_DEV=1 VYRE_SEAL_SOFTWARE=1 VYRE_KERNEL_PATH_RULE=1 VYRE_HEADSCALE_BIN=$HOME/${DIR}/bin/headscale VYRE_WINK_FORWARDER_BIN=$HOME/${DIR}/bin/wink-forwarder node scripts/e2e-wink-net.mjs run --config ${abs}/config.json >> ${abs}/runner.log 2>&1 < /dev/null & echo $! > ${abs}/runner.pid)`);
  return until(() => { try { return sh(host, `test -s ${dir}/ctl.token && curl -s --max-time 3 http://127.0.0.1:${cfg.ctlPort}/health`, { quiet: true }).includes("ok"); } catch { return false; } }, 240_000, `${role} runner`)
    .catch(e => { throw new Error(`${e.message}\n${sh(host, `tail -20 ${dir}/runner.log`, { quiet: true })}`); });
}
function stopRunners() {
  for (const [role, port] of [["home", P.ctlHome], ["server", P.ctlServer]]) {
    // only the pids this test recorded; the runner kills its own children (headscale, node, relay) on SIGTERM
    try { sh(HOSTS[role], `p=$(cat ${DIR}/${port}/runner.pid 2>/dev/null); [ -n "$p" ] && kill $p 2>/dev/null; true`, { quiet: true }); } catch { /* gone */ }
  }
}

async function main() {
  const ips = { home: addr(HOSTS.home), server: addr(HOSTS.server) };
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); out(ok ? "pass" : "FAIL", { name, ...(detail ? { detail } : {}) }); return ok; };
  try {
    for (const r of ["home", "server"]) { stage(HOSTS[r]); ensureBins(HOSTS[r]); }
    stopRunners(); await sleep(1500);
    for (const [r, port] of [["home", P.ctlHome], ["server", P.ctlServer]]) sh(HOSTS[r], `rm -rf ${DIR}/${port}`);   // every run starts from fresh homes
    firewall(true, ips);
    const common = { relayUrl: `ws://${ips.home}:${P.relay}`, gatePort: P.gate, directory: `http://${ips.home}:${P.dir}` };
    await startRunner("home", { ...common, role: "home", ctlPort: P.ctlHome, startsRelay: true, relayPort: P.relay, dirPort: P.dir, controlUrl: `http://${ips.home}:${P.gate}` });
    await startRunner("server", { ...common, role: "server", ctlPort: P.ctlServer });
    out("up", { home: ips.home, server: ips.server });

    const hs = await until(() => { const s = ctl(HOSTS.home, P.ctlHome, { cmd: "netstatus" }); return s.netd && s.netd.state === "up" ? s : null; }, 120_000, "the home's network (netd) to come up");
    check("home: netd is up (real Headscale, gate, node)", true, { ips: hs.netd.ips });

    const idn = ctl(HOSTS.home, P.ctlHome, { cmd: "identity-create", name: `e2e${crypto.randomBytes(3).toString("hex")}` });
    check("home: claimed an identity at the stand-in directory", Boolean(idn.id), { name: idn.name });
    const code = ctl(HOSTS.server, P.ctlServer, { cmd: "server-code" });
    const typed = ctl(HOSTS.home, P.ctlHome, { cmd: "pair-server", payload: code.qr });
    const asked = await until(() => { const s = ctl(HOSTS.home, P.ctlHome, { cmd: "pair-status", pairing: typed.pairing }); return s.state === "confirm" && s.words ? s : (["failed", "expired"].includes(s.state) ? s : null); }, 60_000, "the three words");
    check("pairing: the home shows three words and waits for the server's yes", asked.state === "confirm", asked);
    const ans = await until(() => { const r = ctl(HOSTS.server, P.ctlServer, { cmd: "server-answer", words: asked.words }); return r.asking ? r : null; }, 30_000, "the server's question");
    check("pairing: the person at the server answers with the three words", ans.yes === true, ans);
    const st = await until(() => { const s = ctl(HOSTS.home, P.ctlHome, { cmd: "pair-status", pairing: typed.pairing }); return ["done", "failed", "expired"].includes(s.state) ? s : null; }, 90_000, "pairing to finish");
    check("pairing: done", st.state === "done", st);
    const sid = st.device;

    const joined = await until(() => { const s = ctl(HOSTS.server, P.ctlServer, { cmd: "joinstatus" }); return s.state === "up" || s.state === "failed" ? s : null; }, 120_000, "the server to join the home's network");
    check("server: joined the home's network from the hand-over", joined.state === "up", joined);
    const direct = await until(() => { const s = ctl(HOSTS.server, P.ctlServer, { cmd: "joinstatus" }); return s.link && s.link.path === "direct" ? s : null; }, 120_000, "a direct path").catch(() => null);
    check("server: its link to the home is DIRECT", Boolean(direct), direct || ctl(HOSTS.server, P.ctlServer, { cmd: "joinstatus" }));

    let lastErr = null;
    const call = await until(() => { try { const r = ctl(HOSTS.server, P.ctlServer, { cmd: "joincall", tool: "network.wink.status", timeoutS: 30 }); lastErr = r.error || null; return r.error ? null : r; } catch (e) { lastErr = String(e.message).slice(0, 300); return null; } }, 60_000, "a call to cross").catch(() => null);
    check("a call from the server crosses to the home", Boolean(call), call ? { ok: true } : lastErr);
    const seen = ctl(HOSTS.home, P.ctlHome, { cmd: "served" });
    check("the home served it as device:<sid>", seen.calls.some(c => c.caller === `device:${sid}`), seen.calls.slice(-3));
    const peers = ctl(HOSTS.home, P.ctlHome, { cmd: "netstatus" }).status;
    const viaOf = ((peers && peers.spaces) || []).flatMap(sp => sp.peerList || []).find(x => x.eid === sid);
    check("the home's node host admitted it on the DIRECT leg (not the relay)", viaOf && viaOf.via === "direct", viaOf);

    let other = "it was answered"; try { ctl(HOSTS.server, P.ctlServer, { cmd: "joincall", tool: "about.text", timeoutS: 30 }); } catch (e) { other = String(e.message); }
    check("a paired server may only read the network's status on its home (anything else is refused)", /only read the network's status/i.test(other), other);
    // THE RELAY FALLBACK: the direct path dies (the home drops the server's UDP and its TCP to the gate, before connection tracking), the relay is untouched. The link must move to the relay and a call must still
    // cross, run by the home's door as the same server and still limited to the status read; then the direct path comes back and the link prefers it again.
    blockDirect(true, ips);
    const viaRelay = await until(() => { try { ctl(HOSTS.server, P.ctlServer, { cmd: "joincall", tool: "network.wink.status", timeoutS: 20 }); } catch { /* a call that finds the direct path dead is what moves the link (probes run on demand, never on a timer) */ } const s = ctl(HOSTS.server, P.ctlServer, { cmd: "joinstatus" }); return s.link && s.link.path === "relay" ? s : null; }, 150_000, "the link to fall back to the relay").catch(() => null);
    check("direct path blocked: the server's link falls back to the RELAY", Boolean(viaRelay), viaRelay || ctl(HOSTS.server, P.ctlServer, { cmd: "joinstatus" }));
    let relayErr = null;
    const relayCall = await until(() => { try { const r = ctl(HOSTS.server, P.ctlServer, { cmd: "joincall", tool: "network.wink.status", timeoutS: 30 }); relayErr = r.error || null; return r.error ? null : r; } catch (e) { relayErr = String(e.message).slice(0, 300); return null; } }, 90_000, "a call over the relay").catch(() => null);
    check("with the direct path blocked, a call from the server still crosses (through the relay)", Boolean(relayCall), relayCall ? { ok: true } : relayErr);
    let relayOther = "it was answered"; try { ctl(HOSTS.server, P.ctlServer, { cmd: "joincall", tool: "about.text", timeoutS: 30 }); } catch (e) { relayOther = String(e.message); }
    check("over the relay a paired server may still only read the network's status", /only read the network's status|denied/i.test(relayOther), relayOther);
    const relayRow = ctl(HOSTS.home, P.ctlHome, { cmd: "relay-row", sid });
    check("the server's relay row is of kind server and hidden from the home's device list", relayRow.rowKind === "server" && relayRow.removed === false && !JSON.stringify(relayRow.listed).includes(sid), relayRow);
    blockDirect(false, ips);
    const back = await until(() => { const s = ctl(HOSTS.server, P.ctlServer, { cmd: "joinstatus" }); return s.link && s.link.path === "direct" ? s : null; }, 180_000, "the direct path to come back").catch(() => null);
    check("direct path unblocked: the link prefers the direct path again", Boolean(back), back || ctl(HOSTS.server, P.ctlServer, { cmd: "joinstatus" }));

    ctl(HOSTS.home, P.ctlHome, { cmd: "remove", device: sid });
    const refused = await until(() => { try { const r = ctl(HOSTS.server, P.ctlServer, { cmd: "joincall", tool: "network.wink.status", timeoutS: 20 }); return r.error ? r : null; } catch { return { error: "unreachable" }; } }, 90_000, "the removed server to be refused").catch(() => null);
    check("after the device row is removed, the server's next call cannot cross", Boolean(refused), refused);
  } catch (e) {
    check("the run completed", false, String(e.message).slice(0, 600));
  } finally {
    stopRunners();
    try { blockDirect(false, ips); } catch { /* reported below */ }
    try { firewall(false, ips); } catch { /* reported below */ }
    out("cleanup", { ufwRulesLeft: { home: leftoverRules(HOSTS.home), server: leftoverRules(HOSTS.server) }, rawBlocksLeft: leftoverBlocks() });
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
  if (cfg.dirPort) {
    // the names directory stand-in: names/worker's real code over plain http (a claim here is not a claim anywhere real; no DNS is published)
    const { createDirectoryServer } = await imp("relay/node/directory.js");
    const dir = await createDirectoryServer({ port: cfg.dirPort, host: "0.0.0.0", publicOrigin: cfg.directory, stateFile: path.join(root, "dir.state") });
    stops.push(() => dir.close()); out("directory", { port: cfg.dirPort });
  }
  const { start } = await imp("core/daemon/index.js");
  const { HUMAN_ONLY } = await imp("core/presence/index.js");
  const lenient = {
    required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
    verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
    challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }), summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }), enrolled: [], enroll(k) { return { id: "kh", kind: k.kind, name: k.name }; },
  };
  const dRoot = path.join(root, "vyre"); fs.mkdirSync(dRoot, { recursive: true, mode: 0o700 });
  const wink = cfg.role === "home" ? { controlUrl: cfg.controlUrl, gatePort: cfg.gatePort } : {};
  fs.writeFileSync(path.join(dRoot, "config.json"), JSON.stringify({ role: "box", name: `e2e-${cfg.role}`, transcripts: [], network: { name: `e2e-${cfg.role}` }, relay: { enabled: true, url: cfg.relayUrl }, wink, names: { directory: cfg.directory }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root: dRoot, log });
  stops.push(() => d.stop());
  const PROOF = { proof: { method: "passkey", id: "x" } };
  const SCREEN = "device:abcdefghijklmnop";
  const reg = (tool, input = {}, caller = SCREEN) => d.registry.call(tool, input, caller, { ...PROOF, peer: { stableId: "node", node: "n" }, person: { id: "ps1" } });
  const data = async (tool, input, caller) => { const r = await reg(tool, input, caller); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data; };
  await until(() => { const w = d.registry.modules.get("wink"); return w && w.state === "running" && w.handle; }, 60_000, "the wink module");
  const winkHandle = () => d.registry.modules.get("wink").handle;
  const served = [];
  if (cfg.role === "home") {
    // record who the door served, by wrapping the registry the daemon already exposes: the door's own dispatcher is the registry's call as that caller
    const orig = d.registry.call.bind(d.registry);
    d.registry.call = (tool, input, caller, meta) => { const who = meta && typeof meta.onBehalfOf === "string" ? meta.onBehalfOf : caller; if (String(who).startsWith("device:") && who !== SCREEN) served.push({ caller: who, tool }); return orig(tool, input, caller, meta); };
  }
  const H = {
    netstatus: async () => { const s = await data("network.wink.status", { ping: false }).catch(() => null); const w = winkHandle(); const nd = w.netd ? w.netd() : null; return { status: s, netd: nd ? nd.status() : null }; },
    "server-code": async () => data("wink.server.code"),
    // the person at the server answers the question with the three words the other screen shows (typed, so no pick is guessed)
    "server-answer": async b => { const q = await data("wink.server.pairing", {}, "cli"); if (!q.asking) return { asking: false }; return { asking: true, ...(await data("wink.server.pair.answer", { yes: true, words: String(b.words) }, "cli")) }; },
    "identity-create": async b => data("spaces.identity.create", { name: String(b.name) }),
    "pair-server": async b => { const targets = (await data("wink.pair.targets")).targets; return data("wink.pair.server", { payload: String(b.payload), target: { kind: "identity", id: targets[0].id }, name: "e2e-server" }); },
    "pair-status": async b => data("wink.pair.status", { pairing: b.pairing }),
    joinstatus: async () => { const j = winkHandle().join(); return j ? j.status() : { state: "none" }; },
    joincall: async b => { const j = winkHandle().join(); if (!j) throw Object.assign(new Error("no join"), { code: "unavailable" }); return { data: await j.call(String(b.tool), b.input || {}, { timeoutMs: 15_000 }) }; },
    served: async () => ({ calls: served }),
    // what the home's own device list shows, and the kind of the row its relay holds for the server (derived the way the server derives its relay key from the peer secret): a server's relay row exists and is not a device the person sees
    "relay-row": async b => {
      const l = await data("relay.devices.list", {}, "cli").catch(() => []); const rows = Array.isArray(l) ? l : (l && l.devices) || [];
      const { relayKeyPair } = await imp("core/wink/directkey.js"); const { deviceId } = await imp("core/relay/index.js");
      const rid = deviceId(Buffer.from(relayKeyPair(winkHandle().peers.secretFor(String(b.sid))).publicKey));
      const info = (await d.registry.call("relay.device.info", { id: rid }, "module:wink")).data;
      return { listed: rows, rowKind: info && info.kind, removed: info && info.removed };
    },
    remove: async b => data("wink.remove", { device: String(b.device) }),
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
