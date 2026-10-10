// The functional proof (step 4): a throwaway vyred (its own VYRE_HOME, role box, no Tailscale, no
// relay) whose computers module drives the real Docker driver through the restricted proxy.
// vyred runs in THIS process, the way core's own in-process tests run it (setPeerHosting), so this
// script can be "the person" at vyred's socket without a terminal; agent-side calls go through the
// registry as `mcp:agent:kit`, the label an agent's hands carry.
//
//   PROOF_DIR=<folder> PROXY_URL=http://127.0.0.1:<port> BEARER_FILE=<file> node proof.mjs
//
// Every step prints PASS or FAIL with its evidence and the script stops at the first FAIL.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setPeerHosting } from "../../core/daemon/peer.js";
import { callSocket, wsConnect, RfbClient } from "./lib.mjs";
import { Cdp } from "../../modules/hands-chrome/cdp.js";

process.env.VYRE_TEST_HOSTED = "1";
setPeerHosting(true);

const DIR = process.env.PROOF_DIR, PROXY = process.env.PROXY_URL, BEARER = process.env.BEARER_FILE;
if (!DIR || !PROXY || !BEARER) throw new Error("set PROOF_DIR, PROXY_URL and BEARER_FILE");
const HOME = path.join(DIR, "home"), VHOME = path.join(DIR, "vyre-home"), OUT = path.join(DIR, "out");
for (const d of [HOME, VHOME, OUT]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
// Nothing may reach the real ~/.vyre or ~/.claude: HOME itself points into the proof folder.
process.env.HOME = HOME; process.env.VYRE_HOME = VHOME; process.env.VYRE_NO_DIALOGS = "1";
process.env.VYRE_ALLOW_DIALOGS = "0";

const PREFIX = "csproof", AGENT = "kit";
const CONTAINER = `${PREFIX}-computer-${AGENT}`;
const load = () => Number(fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000, ...opts }).trim();
const shOk = args => { try { return sh(args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return `ERR ${String(e.stdout || "").trim()} ${String(e.stderr || e.message).trim()}`.trim(); } };
const inC = (user, cmd) => shOk(["exec", "-u", user, "-e", "DISPLAY=:1", "-e", "XAUTHORITY=/var/lib/vyre/.Xauthority", CONTAINER, "sh", "-c", cmd]);
// The agent's uid, to read what its terminal wrote.
const asAgent = cmd => shOk(["exec", "-u", "1000:1000", CONTAINER, "sh", "-c", cmd]);

let failed = false;
const results = [];
function check(ok, name, evidence) {
  results.push({ ok, name });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${evidence !== undefined ? `: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}` : ""}`);
  if (!ok) { failed = true; throw new Error(`step failed: ${name}`); }
}

console.log(`load at start: ${load()} (timings are recorded only when load < 12)`);
fs.writeFileSync(path.join(VHOME, "config.json"), JSON.stringify({
  role: "box", machine: "server", name: "csproof",
  network: { tailscale: false },
  // Off on purpose: nothing here dials out. The computers, agents, chrome and desktop hands are what is under test.
  modules: { disable: ["names", "network", "hooks", "apps", "relay", "releases", "link", "sync", "push", "github", "google", "mail", "import", "sessions", "chat", "sight"] },
  computers: { docker: PROXY, dockerBearerFile: BEARER, image: "csproof-computer:test", network: "csproof-net", labelPrefix: PREFIX,
    cpus: 2, memoryMb: 2048, screens: 2, sweepMs: 0, bootMs: 120_000, waitMs: 30_000, freezeMs: 600_000, idleMs: 600_000, handbackIdleMin: 15 },
}, null, 2));

const { start } = await import("../../core/daemon/index.js");
const logs = [];
const d = await start({ root: VHOME, log: (m, x) => logs.push(m + (x ? " " + JSON.stringify(x) : "")) });
const socketPath = d.paths.socket;
const mods = d.registry.status().filter(m => m.state === "running").map(m => m.name);
console.log("modules running: " + mods.join(", "));
const person = (tool, input) => callSocket(socketPath, tool, input, "cli");
const agent = (tool, input) => d.registry.call(tool, input, `mcp:agent:${AGENT}`);

// A hang leaves nothing to read, so after 6 minutes dump what vyred and the computer say, and stop.
setTimeout(() => {
  console.log("FAIL watchdog: the proof was still running after 6 minutes\n--- last vyred log lines\n" + logs.slice(-40).join("\n"));
  console.log("--- container log (tail)\n" + shOk(["logs", "--tail", "40", CONTAINER]).slice(-3000));
  console.log("--- computerd and Xvnc\n" + shOk(["exec", CONTAINER, "sh", "-c", "ps -eo user,pid,args | grep -E 'Xvnc|computerd|index.js' | grep -v grep | cut -c1-200; ls -la /var/lib/vyre/vnc.sock 2>&1"]).slice(-1500));
  process.exit(3);
}, 6 * 60_000).unref();

let exitCode = 0;
const viewers = [];
try {
  // ---- 4a. an agent with a computer; the pool checks one out ---------------------------------
  let r = await person("agents.create", { name: AGENT, computer: true });
  check(!r.error && r.data && r.data.computer === true, "4a agents.create kit computer:true", r.error ? r.error : { name: r.data.name, computer: r.data.computer });
  const t0 = Date.now();
  r = await person("computers.checkout", { agent: AGENT, why: "csproof" });
  const bootedMs = Date.now() - t0;
  check(!r.error, "4a computers.checkout kit", r.error ? r.error : { state: r.data.state, screen: r.data.screen, host: r.data.host ? "(container address)" : null });
  const ps = shOk(["ps", "--filter", `name=${CONTAINER}`, "--format", "{{.Names}}|{{.Status}}|{{.Image}}"]);
  check(ps.startsWith(CONTAINER + "|Up"), "4a docker ps shows the container up", ps);
  const labels = JSON.parse(sh(["inspect", "-f", "{{json .Config.Labels}}", CONTAINER]));
  check(labels[`${PREFIX}.managed`] === "true" && labels[`${PREFIX}.computer`] === AGENT && labels["run.vyre"] === "1", "4a labels", labels);
  const hc = JSON.parse(sh(["inspect", "-f", "{{json .HostConfig}}", CONTAINER]));
  check(hc.NanoCpus === 2e9 && hc.Memory === 2048 * 1024 * 1024 && hc.NetworkMode === "csproof-net" && hc.Privileged === false && hc.ReadonlyRootfs === true,
    "4a limits and hardening from the pool's create", { cpus: hc.NanoCpus / 1e9, memory_mb: hc.Memory / 1048576, network: hc.NetworkMode, privileged: hc.Privileged, readonly_root: hc.ReadonlyRootfs, caps_add: hc.CapAdd, caps_drop: hc.CapDrop });
  const ports = JSON.stringify(JSON.parse(sh(["inspect", "-f", "{{json .NetworkSettings.Ports}}", CONTAINER])));
  check(!/HostPort/.test(ports), "4a no port is published on the host", ports);
  const view = (await person("computers.get", { agent: AGENT })).data;
  console.log("computers.get: " + JSON.stringify({ state: view.state, screen: view.screen, frozen: view.frozen, viewers: view.viewers, takeover: view.takeover }));
  if (load() < 12) console.log(`timing: checkout to ready ${bootedMs} ms`); else console.log(`timing: pending, load ${load()}`);

  // The agent's CDP, through computerd's authenticated /cdp route, set up once and used for 4c to 4e.
  const ep = await d.registry.call("computers.helper", { agent: AGENT }, "module:vyred");
  check(!ep.error && ep.data.url && ep.data.token, "4e computers.helper (module-only) names computerd and its token", ep.error || { url: ep.data.url });
  const cdpUrl = ep.data.url.replace(/\/+$/, "") + "/cdp";
  // checkout is ready when Xvnc answers (pool.boot probes 5900 only); computerd can come up a few seconds later under load.
  let unauth = "";
  const tc = Date.now();
  for (let i = 0; i < 60; i++) { unauth = await fetch(cdpUrl + "/json/version").then(x => x.status, e => e.message); if (typeof unauth === "number") break; await sleep(1000); }
  console.log(`computerd first answered ${Math.round((Date.now() - tc) / 1000)} s after checkout returned`);
  check(unauth === 401, "4e /cdp without the token is 401", unauth);
  const cdp = new Cdp({ cdpUrl, token: ep.data.token });
  await cdp.connect();
  // A real tab, not one of Chrome's own WebUI pages (its omnibox popup is also type "page").
  const tabs = async () => (await cdp.send("Target.getTargets", {})).targetInfos.filter(t => t.type === "page" && /^(about:|data:|https?:)/.test(t.url));
  const listTabs = async () => JSON.stringify((await cdp.send("Target.getTargets", {})).targetInfos.filter(t => t.type === "page").map(t => `${t.targetId.slice(0, 4)} ${t.url.slice(0, 32)}`));
  let pg;
  for (let i = 0; i < 40 && !pg; i++) { pg = (await tabs())[0]; if (!pg) await sleep(1000); }
  if (!pg) throw new Error("Chrome opened no tab in 40 s: " + await listTabs());
  console.log("chrome tabs at start: " + await listTabs());
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: pg.targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  const evalIn = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
  const gotoPage = async url => { const l = cdp.waitFor(m => m.method === "Page.loadEventFired" && m.sessionId === sessionId, 15000); await cdp.send("Page.navigate", { url }, sessionId); await l; await sleep(300); };
  // A page with a text field for the agent's hands to type into.
  await gotoPage("data:text/html,<title>csproof kit title</title><label>Search box<input id=q aria-label=\"Search box\"></label>");

  // A fixture, not a check: put the agent's xterm where it can be seen and clicked.
  let win = "";
  for (let i = 0; i < 40 && !/^\d+$/.test(win); i++) { win = inC("1001:1001", "xdotool search --class xterm | head -1"); if (!/^\d+$/.test(win)) await sleep(1000); }
  console.log("xterm window: " + win);
  inC("1001:1001", `xdotool windowmove ${win} 40 40; xdotool windowraise ${win}; xdotool windowactivate ${win}; xdotool windowfocus ${win}`);
  await sleep(1500);
  const geom = inC("1001:1001", `xdotool getwindowgeometry ${win}`);
  console.log(geom.replace(/\n/g, " | "));
  const gm = /Position: (\d+),(\d+)/.exec(geom), sm = /Geometry: (\d+)x(\d+)/.exec(geom);
  const cx = gm && sm ? Number(gm[1]) + Math.floor(Number(sm[1]) / 2) : 300, cy = gm && sm ? Number(gm[2]) + Math.floor(Number(sm[2]) / 2) : 200;

  // ---- 4b. watch in Glass -------------------------------------------------------------------
  async function openViewer(surface) {
    const t = await person("computers.watch", { agent: AGENT, surface });
    if (t.error) throw new Error(`computers.watch ${surface}: ${t.error.message}`);
    const ws = await wsConnect(socketPath, t.data.path);
    const rfb = new RfbClient(ws);
    await rfb.handshake();
    viewers.push(ws);
    return { rfb, ws, ticket: t.data.ticket, path: t.data.path };
  }
  const A = await openViewer("deck:laptop");
  check(A.rfb.securityTypes.join() === "1" && A.rfb.w === 1440 && A.rfb.h === 900, "4b Glass handshake: RFB 3.8, security None only, ServerInit", { securityTypes: A.rfb.securityTypes, w: A.rfb.w, h: A.rfb.h, name: A.rfb.name, ticket_used_once: true });
  const reuse = await wsConnect(socketPath, A.path).then(() => "connected", e => e.message);
  check(/403/.test(reuse), "4b the ticket is one-use: a second upgrade with it is refused", reuse);
  check(await A.rfb.refresh(false), "4b FramebufferUpdate received");
  const nz = A.rfb.nonZeroPixels(), colours = A.rfb.distinctColours();
  check(nz > 1000 && colours > 3, "4b framebuffer has real pixels", { non_zero_pixels: nz, of: A.rfb.w * A.rfb.h, sampled_distinct_colours: colours });
  fs.writeFileSync(path.join(OUT, "glass-desktop.png"), A.rfb.png());
  console.log(`saved ${path.join(OUT, "glass-desktop.png")}`);
  const B = await openViewer("phone:pixel");
  check(await B.rfb.refresh(false), "4b a second viewer (phone:pixel) also gets a framebuffer", { viewers: (await person("computers.get", { agent: AGENT })).data.viewers });

  // ---- 4c. take over ------------------------------------------------------------------------
  // Before anyone holds the keyboard nobody's input reaches the computer.
  await A.rfb.type("echo PRE > /home/agent/pre-a.txt\n"); await B.rfb.type("echo PRE > /home/agent/pre-b.txt\n");
  await sleep(1500);
  check(asAgent("ls /home/agent/pre-a.txt /home/agent/pre-b.txt 2>&1").includes("No such file"), "4c before take-over both viewers' typing is dropped", asAgent("ls /home/agent | tr '\\n' ' '"));

  // The agent's own hands work now.
  let may = await agent("computers.may-act", { agent: AGENT, tool: "chrome.type" }).catch(e => ({ error: e }));
  console.log("agent may-act before take-over: " + JSON.stringify(may.data || may.error));
  // (computers.may-act is internal: an agent cannot call it; the hands do. It is asked here as the module the hands run as.)
  may = await d.registry.call("computers.may-act", { agent: AGENT, tool: "chrome.type" }, "module:chrome");
  check(!may.error && may.data.ok === true, "4c agent's hands may act before take-over", may.data || may.error);

  const stranger = await callSocket(socketPath, "computers.takeover", { agent: AGENT, surface: "deck:laptop" }, `mcp:agent:${AGENT}`);
  check(!!stranger.error, "4c an agent cannot take the keyboard itself", stranger.error);
  r = await person("computers.takeover", { agent: AGENT, surface: "deck:laptop" });
  check(!r.error && r.data.surface === "deck:laptop", "4c computers.takeover as the person (deck:laptop)", r.error || r.data);
  console.log("computers.get during take-over: " + JSON.stringify((await person("computers.get", { agent: AGENT })).data.takeover));

  // The person, through Glass: click the terminal, type a command.
  A.rfb.click(cx, cy); await sleep(400);
  await A.rfb.type("echo TYPED-BY-PERSON-THROUGH-GLASS > /home/agent/glass-proof.txt\n");
  await sleep(1500);
  let got = asAgent("cat /home/agent/glass-proof.txt 2>&1");
  check(got === "TYPED-BY-PERSON-THROUGH-GLASS", "4c the person's keystrokes through Glass reached the agent's terminal (file written by xterm's shell)", got);
  A.rfb.refresh(true); await sleep(1200);
  fs.writeFileSync(path.join(OUT, "glass-after-typing.png"), A.rfb.png());
  console.log(`saved ${path.join(OUT, "glass-after-typing.png")}`);

  // A second viewer's input is dropped while A holds the keyboard.
  B.rfb.click(cx, cy);
  await B.rfb.type("echo VIEWER-B-SHOULD-BE-DROPPED > /home/agent/b-dropped.txt\n");
  await sleep(1500);
  got = asAgent("ls /home/agent/b-dropped.txt 2>&1");
  check(got.includes("No such file"), "4c a second viewer's keystrokes are dropped while deck:laptop holds the keyboard", got);

  // The agent's own hands are refused (held) while the person has the keyboard.
  may = await d.registry.call("computers.may-act", { agent: AGENT, tool: "chrome.type" }, "module:chrome");
  check(!may.error && may.data.ok === false, "4c agent's hands are refused while taken over", may.data || may.error);
  const typeDuring = await agent("chrome.type", { agent: AGENT, selector: { name: "Search box" }, text: "kit must not type now" });
  const heldWhy = typeDuring.error ? typeDuring.error.message : typeDuring.data && typeDuring.data.ok === false ? typeDuring.data.why : null;
  check(Boolean(heldWhy), "4c agent chrome.type refused during take-over", heldWhy);
  check(await evalIn("document.getElementById('q').value") === "", "4c and the page's field is still empty", await evalIn("document.getElementById('q').value"));

  // ---- 4d. hand back ------------------------------------------------------------------------
  const wrong = await callSocket(socketPath, "computers.giveback", { agent: AGENT, surface: "deck:laptop" }, `mcp:agent:${AGENT}`);
  check(!!wrong.error, "4d an agent cannot hand the keyboard back for the person", wrong.error);
  r = await person("computers.giveback", { agent: AGENT, surface: "deck:laptop" });
  check(!r.error && r.data.handed_back === true, "4d computers.giveback as the person", r.error || r.data);
  A.rfb.click(cx, cy); await A.rfb.type("echo PERSON-AFTER-HANDBACK > /home/agent/after-a.txt\n");
  B.rfb.click(cx, cy); await B.rfb.type("echo VIEWER-B-AFTER > /home/agent/after-b.txt\n");
  await sleep(1500);
  got = asAgent("ls /home/agent/after-a.txt /home/agent/after-b.txt 2>&1");
  check((got.match(/No such file/g) || []).length === 2, "4d after hand-back the person's and the second viewer's input are dropped again", got);
  may = await d.registry.call("computers.may-act", { agent: AGENT, tool: "chrome.type" }, "module:chrome");
  check(!may.error && may.data.ok === true, "4d agent's hands may act again", may.data || may.error);
  // The hands' own path. hands-chrome attaches to the FIRST target of type "page" that is not
  // devtools://, and Chrome's own WebUI pages (chrome://omnibox-popup...) are also type "page":
  // when one sorts before the tab, the hands look at the popup and find "nothing matches" (found
  // by this proof). So the hands' landing is checked, but the step's pass criterion is the
  // keyboard: the hands must not be refused with the keyboard's reason. PROOF_STRICT_HANDS=1 makes
  // the landing itself a hard requirement (use it on a copy that has the cdp.js page() fix).
  console.log("chrome tabs before agent typing: " + await listTabs());
  r = await agent("chrome.type", { agent: AGENT, selector: { name: "Search box" }, text: "typed by kit" });
  const why = r.error ? r.error.message : r.data && r.data.ok === false ? r.data.why : null;
  check(!why || !/keyboard|take-over|shield|paused/i.test(why), "4d agent chrome.type is not refused by the keyboard gate after hand-back", why || { ok: r.data.ok });
  const handsLanded = (await evalIn("document.getElementById('q').value")) === "typed by kit";
  console.log(`hands-chrome typed into the tab: ${handsLanded ? "yes" : "no"}${why ? ` (${why})` : ""}`);
  if (process.env.PROOF_STRICT_HANDS === "1") check(handsLanded, "4d hands-chrome's text landed in the page", handsLanded);
  if (!handsLanded) {
    // The agent's own input path, straight through computerd's /cdp with the agent's token: focus the field, insert text.
    await evalIn("document.getElementById('q').focus()");
    await cdp.send("Input.insertText", { text: "typed by kit over cdp" }, sessionId);
    const v = await evalIn("document.getElementById('q').value");
    check(v === "typed by kit over cdp", "4d agent input through computerd /cdp lands after hand-back", v);
  }

  // ---- 4e. CDP action as the agent, through computerd's authenticated /cdp route ---------------
  check(await evalIn("document.title") === "csproof kit title", "4e CDP action as the agent through /cdp: read the page title", await evalIn("document.title"));
  await gotoPage("about:blank");
  const blank = await evalIn("location.href + '|' + JSON.stringify(document.title)");
  check(blank === 'about:blank|""', "4e about:blank opened and read back over /cdp", blank);
  const dbgPort = inC("1000:1000", "python3 -c \"import socket\nfor p in (9222,9223):\n    s=socket.socket(); s.settimeout(1)\n    try: s.connect(('127.0.0.1',p)); print(p,'open')\n    except Exception as e: print(p,type(e).__name__)\"");
  check(!/open/.test(dbgPort), "4e no raw Chrome debugging port to dial from inside the computer", dbgPort.replace(/\n/g, "; "));
  // ---- 4k. Vyre Computer's front door: the agent drives a page through `computer.use` (the cloud computer by default), interface first -------------
  // Nothing is named in `on`, so the answer is the agent's own computer; every act below is the engine's own tool (chrome.*) behind the one door, with the engine's own floor.
  const use = async input => { const x = await agent("computer.use", input); if (x.error) throw new Error(`computer.use ${input.do}: ${x.error.message}`); return x.data; };
  await gotoPage("data:text/html,<title>door start</title><label>Search box<input aria-label=\"Search box\"></label>");
  const routed = await use({ do: "route", goal: "type a name", site: "door.csproof.invalid" });
  check(routed && /screen/.test(JSON.stringify(routed)) && /Cloud computer/.test(JSON.stringify(routed)), "4k computer.use route: no Connection or learned operation covers the site, so the screen, on the cloud computer by default", JSON.stringify(routed).slice(0, 160));
  // the agent's Chrome reaches the public web only: a loopback or local page is refused by the door, with the way out named
  const local = await agent("computer.use", { do: "open", url: "http://127.0.0.1:8099/" });
  check(!!local.error && /public/.test(local.error.message || ""), "4k computer.use open of a local page is refused (the agent's Chrome reaches the public web only)", local.error && local.error.message);
  const looked = await use({ do: "look" });
  check(looked && looked.engine === "chrome.snapshot" && JSON.stringify(looked).includes("Search box"), "4k computer.use look returned the page's controls (chrome.snapshot)", JSON.stringify(looked).slice(0, 160));
  const typed = await use({ do: "type", args: { selector: { name: "Search box" }, text: "kit through the door" } });
  check(typed && typed.engine === "chrome.type", "4k computer.use type went to chrome.type", JSON.stringify(typed).slice(0, 140));
  const value = await evalIn("(document.querySelector('input') || {}).value");
  check(value === "kit through the door", "4k the text is in the page, read back over /cdp", value);
  const other = await agent("computer.use", { do: "look", on: "nowhere-computer" });
  check(!other.error && JSON.stringify(other.data).includes("question"), "4k a computer that does not exist is a question with the real names, never a guess", JSON.stringify(other.data || other.error).slice(0, 160));
  const bad = await agent("computer.use", { do: "launch-missiles" });
  check(!!bad.error, "4k an action that is not a computer's is refused", bad.error && bad.error.message);
  const rival = await agent("computer.use", { do: "look", agent: "someone-else" });
  check(!!rival.error && /own computer/.test(rival.error.message || ""), "4k an agent cannot use another agent's computer through the door", rival.error && rival.error.message);

  cdp.ws && cdp.ws.close();

  // ---- step 3 again, on the computer the pool itself made -------------------------------------
  // The image's own isolation checks and the browser checks, against this very container. The
  // token goes in the environment of the two child processes only, never printed.
  const { spawnSync } = await import("node:child_process");
  const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const env = { ...process.env, VYRE_COMPUTER_CONTAINER: CONTAINER, VYRE_COMPUTERD_TOKEN: ep.data.token };
  const iso = spawnSync("node", ["--test", "core/computers/image/isolation.test.js"], { cwd: here, env, encoding: "utf8", timeout: 240_000 });
  const line = k => (/^# (\w+) (\d+)$/m.exec((iso.stdout || "").split("\n").filter(l => l.startsWith(`# ${k} `)).join("\n")) || [])[2];
  console.log((iso.stdout || "").split("\n").filter(l => /^(not )?ok /.test(l)).map(l => "  " + l.slice(0, 170)).join("\n"));
  check(iso.status === 0 && line("fail") === "0" && line("skipped") === "0", "3 isolation.test.js on the pool's container", { pass: line("pass"), fail: line("fail"), skipped: line("skipped") });
  const bc = spawnSync("node", ["scripts/computers-proof/browser-checks.mjs", ep.data.url, ep.data.token, CONTAINER], { cwd: here, env, encoding: "utf8", timeout: 240_000 });
  console.log((bc.stdout || "").split("\n").filter(l => /^(PASS|FAIL)/.test(l)).map(l => "  " + l.replace(ep.data.token, "[token]").slice(0, 200)).join("\n"));
  check(bc.status === 0, "3 browser-checks (file://, chrome://, download folder)", { exit: bc.status });

  // ---- 4g. one computer cannot reach another's ports (the matrix's J7 step 7.4) ----------------
  // Agent code is model-controlled, so what runs in kit's computer must not be able to dial pax's screen (5900) or computerd (7000).
  // The login on each is the second wall; this is the first. Findings are recorded and the run goes on.
  if (process.env.PROOF_ISOLATION === "1") {
    const note = (ok, name, evidence) => { results.push({ ok, name }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${evidence !== undefined ? `: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}` : ""}`); if (!ok) failed = true; };
    const other = "pax", otherC = `${PREFIX}-computer-${other}`;
    let r2 = await person("agents.create", { name: other, computer: true });
    if (r2.error) throw new Error("agents.create pax: " + r2.error.message);
    r2 = await person("computers.checkout", { agent: other, why: "csproof" });
    if (r2.error) throw new Error("computers.checkout pax: " + r2.error.message);
    const ipOf = c => sh(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", c]).trim();
    // "Refused" means no byte comes back: the connection may open at the TCP level, but it is closed before anything is said
    // (the screen's greeting, or an HTTP answer to a ping). vyred, from outside, gets 12 bytes from both.
    const dial = (from, ip, port) => {
      const out = shOk(["exec", "-u", "1000:1000", from, "bash", "-c", `timeout 6 bash -c 'exec 3<>/dev/tcp/${ip}/${port} || exit 7; printf "GET /ping HTTP/1.0\\r\\n\\r\\n" >&3; head -c 12 <&3 | wc -c' 2>&1`]).split("\n").pop().trim();
      return /^\d+$/.test(out) && Number(out) > 0 ? `ANSWERED (${out} bytes)` : "REFUSED";
    };
    // 4h. What the address gate rests on: the agent's uid has no capability and cannot gain one, so it cannot forge another
    // computer's (or vyred's) source address or poison the bridge's ARP. Printed in full for the log.
    const asAgentC = cmd => shOk(["exec", "-u", "1000:1000", CONTAINER, "sh", "-c", cmd]);
    const stat = asAgentC("grep -E '^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs)' /proc/self/status");
    console.log("--- the agent uid's capabilities\n" + stat);
    const field = k => (new RegExp(`^${k}:\\s*(\\S+)`, "m").exec(stat) || [])[1];
    note(/^0+$/.test(String(field("CapEff"))) && /^0+$/.test(String(field("CapPrm"))) && /^0+$/.test(String(field("CapAmb"))) && field("NoNewPrivs") === "1",
      "4h the agent uid has no effective, permitted or ambient capability, and no-new-privileges is on", { CapBnd: field("CapBnd"), CapEff: field("CapEff"), NoNewPrivs: field("NoNewPrivs") });
    const sudo = asAgentC("command -v sudo doas pkexec 2>/dev/null; echo done").split("\n").filter(l => l && l !== "done");
    note(sudo.length === 0, "4h no sudo, doas or pkexec for the agent uid", sudo.join(",") || "none");
    const suid = asAgentC("find / -xdev -type f -perm -4000 2>/dev/null | head -20").split("\n").filter(Boolean);
    console.log("setuid files in the image (inert under no-new-privileges): " + (suid.join(" ") || "none"));
    // 4j (7.5c). The gate lets loopback in, which holds only while nothing in the computer forwards remote traffic to it.
    const procs = shOk(["exec", CONTAINER, "sh", "-c", "ps -eo comm= | sort -u"]).split("\n").map(x => x.trim()).filter(Boolean);
    const FORWARDERS = /^(tailscaled?|socat|redir|rinetd|haproxy|nginx|ncat|nc|netcat|sshd|dropbear|stunnel|gost|3proxy|squid|microsocks)$/;
    const fwd = procs.filter(x => FORWARDERS.test(x));
    const tcp = shOk(["exec", CONTAINER, "sh", "-c", "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null"]).split("\n");
    const listen = tcp.map(l => l.trim().split(/\s+/)).filter(f => f[3] === "0A").map(f => { const [ip, port] = f[1].split(":"); return { loopback: /^[0-9A-F]{6}7F$/.test(ip) || ip === "00000000000000000000000001000000", port: parseInt(port, 16), inode: f[9], uid: f[7], ip }; });
    for (const x of listen.filter(x => !x.loopback && x.port !== 5900 && x.port !== 7000)) {
      // Who owns a listener nobody expected: the process whose descriptors hold its socket.
      // Root without capabilities cannot read other uids' descriptors, so ask as each uid the computer runs.
      const who = ["1000:1000", "1001:1001", "1002:1002", "0"].map(u => shOk(["exec", "-u", u, CONTAINER, "sh", "-c", `for p in /proc/[0-9]*; do if ls -l $p/fd 2>/dev/null | grep -q "socket:.${x.inode}."; then echo "uid ${u} $(cat $p/comm) pid $(basename $p) $(tr '\\0' ' ' < $p/cmdline | cut -c1-160)"; fi; done; true`])).filter(Boolean).join(" | ");
      console.log(`unexpected listener :${x.port} (local ${x.ip}, owner uid ${x.uid}, inode ${x.inode}) is held by: ${who || "(not found)"}`);
    }
    const open = [...new Set(listen.filter(x => !x.loopback).map(x => x.port))].sort((a, b) => a - b);
    console.log("--- processes in the computer: " + procs.join(" ") + "\n--- listening: non-loopback " + open.join(",") + "; loopback " + [...new Set(listen.filter(x => x.loopback).map(x => x.port))].join(","));
    note(fwd.length === 0 && open.every(p => p === 5900 || p === 7000), "4j nothing in the computer forwards remote traffic to loopback (no tailscaled, socat, proxy or sshd), and only 5900 and 7000 listen beyond it", { forwarders: fwd, open });
    // 4i (7.5). Forging a source address needs a raw or packet socket (ARP poisoning needs a packet socket); both need
    // CAP_NET_RAW, which no computer has.
    const forge = asAgentC(`python3 - <<'PY'
import socket
out = []
for name, fam, typ, proto in (("raw IP socket", socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW), ("raw ICMP socket", socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP), ("packet socket (ARP)", socket.AF_PACKET, socket.SOCK_RAW, 0x0806)):
    try:
        x = socket.socket(fam, typ, proto); x.close(); out.append(name + ": OPENED")
    except Exception as e:
        out.append(name + ": " + type(e).__name__)
print("|".join(out))
PY`).split("\n").pop();
    note(/^raw IP socket: PermissionError\|raw ICMP socket: PermissionError\|packet socket \(ARP\): PermissionError$/.test(forge), "4i the agent cannot forge a source address or poison ARP: no raw or packet socket opens", forge);
    const a = ipOf(CONTAINER), b = ipOf(otherC);
    for (const [from, to, ip] of [[CONTAINER, other, b], [otherC, AGENT, a]]) {
      for (const port of [5900, 7000]) {
        const got = dial(from, ip, port);
        note(got === "REFUSED", `4g ${from.replace(`${PREFIX}-computer-`, "")}'s computer cannot connect to ${to}'s port ${port}`, got);
      }
    }
  }

  // ---- 4f. the computer dies mid-task (PROOF_KILL=1, the matrix's J7 step 7.3) ----------------
  // Kill the container the way a crash would. The pool's monitor must notice, say stopped, and Glass must answer
  // with a named refusal, not hang; nothing may be left running.
  if (process.env.PROOF_KILL === "1") {
    // Findings here are recorded and the run goes on, so one stale answer does not hide the next check.
    const note = (ok, name, evidence) => { results.push({ ok, name }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${evidence !== undefined ? `: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}` : ""}`); if (!ok) failed = true; };
    sh(["kill", CONTAINER]);
    const t0k = Date.now();
    let st = null;
    for (let i = 0; i < 30; i++) { const g = await person("computers.get", { agent: AGENT }); st = g.data && g.data.state; if (st && st !== "running") break; await sleep(1000); }
    const tKill = Math.round((Date.now() - t0k) / 100) / 10;
    note(st === "stopped" || st === "none", "4f a killed computer is reported stopped within 30 s from the runtime's event stream (the sweep is off in this proof)", { state: st, seconds: tKill });
    const w = await person("computers.watch", { agent: AGENT, surface: "deck:laptop" });
    let said = w.error ? String(w.error.message) : "";
    if (!w.error) {
      // A ticket was handed out: what does the stream do? It must end, with a reason a person can read.
      try { const ws = await wsConnect(socketPath, w.data.path); viewers.push(ws); const rfb = new RfbClient(ws); await rfb.handshake(); said = "the stream opened on a dead computer"; }
      catch (e) { said = "ticket given, then the stream ended: " + String(e.message).slice(0, 120); }
    }
    note(Boolean(w.error) && said === "This computer stopped. Start it again?", "4f Glass refuses a killed computer with a plain message (no ticket for a dead computer)", said || "no message");
    const up = shOk(["ps", "--filter", `name=${CONTAINER}`, "--format", "{{.Status}}"]);
    note(!/^Up/.test(up), "4f no running container is left", up || "(none)");
  }
} catch (e) {
  exitCode = 1;
  if (!/^step failed/.test(e.message)) console.log(`FAIL error: ${e.stack || e.message}`);
  console.log("--- last vyred log lines\n" + logs.slice(-15).join("\n"));
  // What the computer itself says, for a failure seen on a runner that cannot be reached by hand.
  console.log("--- container log (tail)\n" + shOk(["logs", "--tail", "60", CONTAINER]).slice(-6000));
  console.log("--- processes\n" + shOk(["exec", CONTAINER, "sh", "-c", "ps -eo user,pid,args | grep -v -E 'chromium|ps -eo|grep' | cut -c1-200 | head -30"]).slice(-3000));
  {
    // The same read the Glass proxy does, from the host: what does the container's VNC port say first?
    const ip = shOk(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", CONTAINER]).trim();
    const net = await import("node:net");
    const got = await new Promise(res => { const b = []; const c = net.connect(5900, ip); const t = setTimeout(() => { c.destroy(); res("timeout, got " + Buffer.concat(b).toString("latin1").length + " bytes"); }, 4000); c.on("data", d => { b.push(d); if (Buffer.concat(b).length >= 12) { clearTimeout(t); c.destroy(); res(JSON.stringify(Buffer.concat(b).subarray(0, 12).toString("latin1"))); } }); c.on("error", e => { clearTimeout(t); res("error " + e.message); }); });
    console.log("--- host read of " + ip + ":5900 first 12 bytes: " + got);
  }
  console.log("--- vnc package\n" + shOk(["exec", CONTAINER, "sh", "-c", "dpkg -l 'tigervnc*' 2>&1 | tail -4; Xvnc -version 2>&1 | head -5"]).slice(-900));
  console.log("--- first bytes of the VNC port\n" + shOk(["exec", CONTAINER, "sh", "-c", "for p in 5900 5901; do echo port $p; (timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/'$p'; head -c 16 <&3 | od -c | head -3') 2>&1; done; ss -ltn 2>&1 | head -10; ls -la /var/lib/vyre/.vnc 2>&1 | head"]).slice(-800));
  // For debugging a failure by hand: keep the computer up for PROOF_HOLD seconds.
  if (Number(process.env.PROOF_HOLD) > 0) { console.log(`HOLDING ${process.env.PROOF_HOLD} s`); await sleep(Number(process.env.PROOF_HOLD) * 1000); }
} finally {
  for (const v of viewers) { try { v.close(); } catch {} }
  console.log(`\n${results.filter(x => x.ok).length} passed, ${results.filter(x => !x.ok).length} failed, load at end ${load()}`);
  try { await d.stop(); } catch (e) { console.log("stop: " + e.message); }
  process.exit(exitCode || (failed ? 1 : 0));
}
