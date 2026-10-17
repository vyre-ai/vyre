// The agent computer proof (0.6): two agents on ONE computer, each its own Linux user, screen and Chrome. Driven from outside the way vyred drives it: the real Docker driver through the
// restricted proxy, agentd through the one allowed exec, the screen relay and the Chrome link through the pinned relay port. Stops at the first FAIL.
//   PROOF_DIR=<folder> PROXY_URL=http://127.0.0.1:<port> BEARER_FILE=<file> node agents.mjs
//
// What it shows: (1) both agents are live with their own screens (a frame comes back through the relay, and a screen ticket works once); (2) a login-like cookie set in A's Chrome is there
// after A sleeps and wakes, and B's Chrome never has it; (3) the relay and the debugging socket refuse a stranger, and agent B's uid cannot open A's socket or read A's profile.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DockerDriver } from "../../core/computers/driver/docker.js";
import { agentdCtl, execTransport, RELAY_PORT } from "../../core/computers/agentd-ctl.js";
import { createCdpAdapter } from "../../core/computers/cdp-adapter.js";
import { Cdp } from "../../lib/cdp.js";

const DIR = process.env.PROOF_DIR, PROXY = process.env.PROXY_URL, BEARER = process.env.BEARER_FILE;
if (!DIR || !PROXY || !BEARER) throw new Error("set PROOF_DIR, PROXY_URL and BEARER_FILE");
const OUT = path.join(DIR, "out"); fs.mkdirSync(OUT, { recursive: true });
const PREFIX = "csproof", NAME = "agentbox", CONTAINER = `${PREFIX}-computer-${NAME}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000, ...opts }).trim();
const shOk = args => { try { return sh(args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return `ERR ${String(e.stdout || "").trim()} ${String(e.stderr || e.message).trim()}`.trim(); } };
function check(ok, name, evidence) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${evidence !== undefined ? `: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}` : ""}`);
  if (!ok) throw new Error(`step failed: ${name}`);
}
setTimeout(() => { console.log("FAIL watchdog: the agent proof ran over 10 minutes\n" + shOk(["logs", "--tail", "60", CONTAINER]).slice(-4000)); process.exit(3); }, 10 * 60_000).unref();

const d = new DockerDriver({ url: PROXY, bearer: fs.readFileSync(BEARER, "utf8").trim(), labelPrefix: PREFIX, network: "csproof-net" });
const token = crypto.randomBytes(24).toString("base64url"), vnc = crypto.randomBytes(6).toString("base64url").slice(0, 8);
const { id } = await d.create({ agent: NAME, image: "csproof-computer:test", network: "csproof-net", env: { SCREEN: "1440x900" }, cpus: 2, memoryMb: 3072, size: { w: 1440, h: 900 },
  labels: { [`${PREFIX}.computer`]: NAME, [`${PREFIX}.managed`]: "true" }, volume: `${PREFIX}-home-${NAME}`, browserVolume: `${PREFIX}-browser-${NAME}` });
await d.seed(id, { computerd_token: token, vnc_password: vnc });
await d.seedAgentd(id, crypto.randomBytes(32).toString("base64url"));
await d.start(id);
const ip = sh(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", CONTAINER]);

const ctl = agentdCtl({ transport: execTransport(input => d.execIn(id, input)), vncKey: async () => "k".repeat(32) });
const U = n => ({ agentId: `agent-${n}`, user: `ag${20000 + n}`, uid: 20000 + n, display: 20 + n });
const [A, B] = [U(0), U(1)];

try {
  // agentd answers once the entrypoint has started it
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await ctl.createUser(A); up = true; } catch { await sleep(2000); } }
  check(up, "agentd answers through the one allowed exec");
  await ctl.createUser(B);
  for (const u of [A, B]) await ctl.startScreen(u);
  // vyred's address is pinned by computerd and written for the relay, as the pool does before it opens a screen
  const ping = await fetch(`http://${ip}:7000/ping`, { headers: { authorization: `Bearer ${token}` } });
  check(ping.ok, "computerd pins this address", ping.status);
  await sleep(500);
  check(shOk(["exec", CONTAINER, "cat", "/var/lib/vyre/vyred-peer"]).length > 6, "the relay can read the pinned address");

  // (1) a screen ticket opens each agent's own screen, once
  const hello = async ticket => new Promise((resolve, reject) => {
    const s = net.connect(RELAY_PORT, ip); const got = [];
    s.on("connect", () => s.write(`${ticket}\n`)); s.on("data", c => got.push(c)); s.on("error", reject);
    setTimeout(() => { s.destroy(); resolve(Buffer.concat(got).toString("latin1")); }, 4000);
  });
  const t1 = crypto.randomBytes(24).toString("base64url");
  await ctl.screenTicket(A, t1);
  const rfb = await hello(t1);
  check(rfb.startsWith("RFB 003."), "agent A's screen answers through the relay with RFB", rfb.slice(0, 12));
  check(!(await hello(t1)).startsWith("RFB"), "the same ticket opens nothing the second time");
  check(!(await hello(crypto.randomBytes(24).toString("base64url"))).startsWith("RFB"), "a ticket nobody registered opens nothing");

  // (2) Chrome through the endpoint, a cookie, sleep, wake
  const adapter = createCdpAdapter({ open: async agent => {
    const u = agent === "a" ? A : B; const ticket = crypto.randomBytes(24).toString("base64url");
    await ctl.cdpTicket(u, ticket);
    return { host: ip, port: RELAY_PORT, hello: `${ticket}\n`, release: () => {} };
  } });
  const connect = async agent => { const ep = await adapter.endpoint(agent); const c = new Cdp({ cdpUrl: `${ep.url}/cdp`, token: ep.token }); await c.connect(); return c; };
  // Chrome takes a while to start; the holder's socket appears with it
  let a = null;
  for (let i = 0; i < 30 && !a; i++) { try { a = await connect("a"); } catch { adapter.drop("a"); await sleep(2000); } }
  check(a !== null, "agent A's Chrome answers over its debugging pipe");
  await a.send("Network.setCookie", { name: "proof_login", value: "signed-in-1", url: "https://example.com/", expires: Math.floor(Date.now() / 1000) + 86400, secure: true });
  const before = (await a.send("Network.getCookies", { urls: ["https://example.com/"] })).cookies.map(c => c.name);
  check(before.includes("proof_login"), "a persistent cookie is set in A's Chrome", before);
  await a.close(); adapter.drop("a");

  await ctl.stopScreen(A); await sleep(8000);   // Chrome ends on SIGTERM and writes its profile
  check(!/chromium/.test(shOk(["exec", CONTAINER, "sh", "-c", "ps -u 21000 -o args= || true"])), "A's Chrome is gone after sleep");
  await ctl.startScreen(A);
  let a2 = null;
  for (let i = 0; i < 30 && !a2; i++) { try { a2 = await connect("a"); } catch { adapter.drop("a"); await sleep(2000); } }
  check(a2 !== null, "A's Chrome answers again after waking");
  const after = (await a2.send("Network.getCookies", { urls: ["https://example.com/"] })).cookies.map(c => `${c.name}=${c.value}`);
  check(after.includes("proof_login=signed-in-1"), "the login survived the computer sleeping and waking", after);

  const b = await connect("b");
  const bCookies = (await b.send("Network.getCookies", { urls: ["https://example.com/"] })).cookies.map(c => c.name);
  check(!bCookies.includes("proof_login"), "agent B's Chrome does not have A's login", bCookies);

  // (3) strangers and the other agent
  const refused = await new Promise(resolve => { const s = net.connect(RELAY_PORT, ip); const got = []; s.on("data", c => got.push(c)); s.on("close", () => resolve(Buffer.concat(got).length)); s.on("error", () => resolve(-1)); s.on("connect", () => s.write("x".repeat(40) + "\n")); setTimeout(() => resolve(-2), 5000); });
  check(refused === 0, "a bad ticket gets no byte back", refused);
  // the browser is its own uid (agb21000 for agent 20000): the agent's own shell, and the other agent, can reach none of its socket, profile or memory
  const denied = (out) => /ERR/.test(out) && /ermission denied|not permitted|No such file/i.test(out);
  for (const uid of [20000, 20001]) {
    const sock = shOk(["exec", "-u", String(uid), CONTAINER, "python3", "-c", "import socket;s=socket.socket(socket.AF_UNIX);s.connect('/var/lib/vyre/browsers/agb21000/cdp.sock')"]);
    check(denied(sock), `uid ${uid} cannot open agent A's browser debugging socket`, sock.slice(-100));
    const prof = shOk(["exec", "-u", String(uid), CONTAINER, "ls", "/var/lib/vyre/browsers/agb21000/profile"]);
    check(denied(prof), `uid ${uid} cannot read agent A's Chrome profile`, prof.slice(-100));
  }
  const pid = shOk(["exec", "-u", "0", CONTAINER, "sh", "-c", "pgrep -u 21000 -x chromium | head -1"]);
  check(/^\d+$/.test(pid), "agent A's Chrome runs as the browser uid 21000", pid);
  for (const [what, cmd] of [["environment", `cat /proc/${pid}/environ`], ["open files", `ls /proc/${pid}/fd`], ["memory map", `cat /proc/${pid}/maps`], ["memory", `head -c 16 /proc/${pid}/mem`]]) {
    const out = shOk(["exec", "-u", "20000", CONTAINER, "sh", "-c", `${cmd} 2>&1`]);
    check(/ermission denied|not permitted|No such/i.test(out) || out === "", `the agent's shell cannot read its browser's ${what}`, out.slice(0, 80));
  }
  // the screen is the browser uid's too: the agent can read neither the screen's memory, its cookie nor its socket; what it has is an untrusted cookie that works but cannot see other clients' windows
  const xpid = shOk(["exec", "-u", "0", CONTAINER, "sh", "-c", "pgrep -u 21000 -x Xvnc | head -1"]);
  check(/^\d+$/.test(xpid), "Xvnc runs as the browser uid 21000, not the agent's", xpid);
  for (const [what, cmd] of [["environment", `cat /proc/${xpid}/environ`], ["memory", `head -c 16 /proc/${xpid}/mem`], ["open files", `ls /proc/${xpid}/fd`]]) {
    const out = shOk(["exec", "-u", "20000", CONTAINER, "sh", "-c", `${cmd} 2>&1`]);
    check(/ermission denied|not permitted|No such/i.test(out) || out === "", `the agent's shell cannot read the screen's ${what}`, out.slice(0, 80));
  }
  const trustedCookie = shOk(["exec", "-u", "20000", CONTAINER, "cat", "/var/lib/vyre/browsers/agb21000/xauth"]);
  check(denied(trustedCookie), "the agent cannot read the trusted X cookie", trustedCookie.slice(-80));
  const vsock = shOk(["exec", "-u", "20000", CONTAINER, "python3", "-c", "import socket;s=socket.socket(socket.AF_UNIX);s.connect('/var/lib/vyre/browsers/agb21000/vnc.sock')"]);
  check(denied(vsock), "the agent cannot open the screen's VNC socket", vsock.slice(-80));
  const xenv = ["-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/x/ag20000/xauth"];
  const info = shOk(["exec", "-u", "20000", ...xenv, CONTAINER, "sh", "-c", "xdpyinfo | grep -c SECURITY"]);
  check(/^[1-9]/.test(info), "the agent's untrusted cookie works and the X SECURITY extension is on", info);
  const grab = shOk(["exec", "-u", "20000", ...xenv, CONTAINER, "sh", "-c", "import -window root /tmp/agent-grab.png >/dev/null 2>&1; echo $?"]);
  const ownGrab = shOk(["exec", "-u", "21000", "-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/browsers/agb21000/xauth", CONTAINER, "sh", "-c", "import -window root /tmp/browser-grab.png >/dev/null 2>&1; echo $?"]);
  check(ownGrab === "0", "the screen's owner can capture its own screen", ownGrab);
  check(grab !== "0", "an untrusted client cannot capture the screen (other clients' windows)", `exit ${grab}`);
  // Keystrokes. The claim is that code running as the agent, with the cookie it has, cannot capture or inject input on the screen. Each is tested with a positive control as the screen's owner, because the
  // defaults of the X SECURITY extension have changed between server versions and a test that cannot fail proves nothing.
  const asOwner = ["exec", "-u", "21000", "-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/browsers/agb21000/xauth"];
  const asUntrusted = ["exec", "-u", "20000", "-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/x/ag20000/xauth"];
  const recordPy = "import ctypes\\nx=ctypes.CDLL('libX11.so.6');t=ctypes.CDLL('libXtst.so.6')\\nx.XOpenDisplay.restype=ctypes.c_void_p\\nd=x.XOpenDisplay(None)\\nerrs=[]\\nH=ctypes.CFUNCTYPE(ctypes.c_int,ctypes.c_void_p,ctypes.c_void_p)\\ncb=H(lambda a,b:(errs.append(1),0)[1])\\nx.XSetErrorHandler(cb)\\nt.XRecordAllocRange.restype=ctypes.c_void_p\\nr=t.XRecordAllocRange()\\nc=ctypes.c_ulong(3)\\nrs=(ctypes.c_void_p*1)(r)\\nt.XRecordCreateContext.restype=ctypes.c_ulong\\nt.XRecordCreateContext(ctypes.c_void_p(d),0,ctypes.byref(c),1,rs,1)\\nx.XSync(ctypes.c_void_p(d),0)\\nprint('refused' if errs else 'allowed')";
  const ownerRecord = shOk([...asOwner, CONTAINER, "python3", "-c", recordPy]);
  check(ownerRecord === "allowed", "XRecord works for the screen's owner (the control)", ownerRecord);
  const agentRecord = shOk([...asUntrusted, CONTAINER, "python3", "-c", recordPy]);
  check(agentRecord === "refused", "(a) XRecord is refused to the agent's cookie", agentRecord);
  // a probe window of the owner's that takes keys; the owner's xev logs what reaches it
  shOk(["exec", "-u", "21000", "-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/browsers/agb21000/xauth", CONTAINER, "sh", "-c", "rm -f /var/lib/vyre/browsers/agb21000/xev.log; (xev -geometry 300x200+10+10 -name keyprobe > /var/lib/vyre/browsers/agb21000/xev.log 2>&1 &) ; sleep 2; xdotool search --name keyprobe | head -1 > /var/lib/vyre/browsers/agb21000/probe.id"]);
  const wid = shOk(["exec", "-u", "21000", CONTAINER, "cat", "/var/lib/vyre/browsers/agb21000/probe.id"]);
  check(/^\d+$/.test(wid), "the owner's key probe window is up", wid);
  shOk([...asOwner, CONTAINER, "sh", "-c", `xdotool windowfocus ${wid}; sleep 1`]);
  const keys = () => shOk(["exec", "-u", "21000", CONTAINER, "sh", "-c", "grep -c KeyPress /var/lib/vyre/browsers/agb21000/xev.log || true"]);
  shOk([...asOwner, CONTAINER, "xdotool", "key", "q"]); await sleep(800);
  check(Number(keys()) >= 1, "the owner's own key reaches its probe (the control)", keys());
  const keysBefore = Number(keys());
  shOk([...asUntrusted, CONTAINER, "xdotool", "key", "z"]); await sleep(800);
  check(Number(keys()) === keysBefore, "(b) XTEST from the agent's cookie injects no key into the owner's window", `${keysBefore} -> ${keys()}`);
  // (c) an untrusted client may not listen to another client's window while the owner types into it
  shOk(["exec", "-u", "20000", "-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/x/ag20000/xauth", CONTAINER, "sh", "-c", `(timeout 6 xev -id ${wid} > /tmp/agent-xev.log 2>&1 &) ; sleep 1`]);
  shOk([...asOwner, CONTAINER, "xdotool", "key", "w"]); await sleep(1500);
  const heard = shOk(["exec", "-u", "20000", CONTAINER, "sh", "-c", "grep -c KeyPress /tmp/agent-xev.log || true"]);
  check(Number(heard) === 0, "(c) a client with the agent's cookie gets no key event of the owner's window", `${heard} key events; ${shOk(["exec", "-u", "20000", CONTAINER, "sh", "-c", "head -c 200 /tmp/agent-xev.log"]).slice(0, 120)}`);
  const ownerHeard = shOk([...asOwner, CONTAINER, "sh", "-c", `timeout 4 xev -id ${wid} > /tmp/owner-xev.log 2>&1 & sleep 1; xdotool key e; sleep 1.5; grep -c KeyPress /tmp/owner-xev.log || true`]);
  check(Number(ownerHeard) >= 1, "the owner's own listener does hear it (the control)", ownerHeard);
  const dl = shOk(["exec", "-u", "20000", CONTAINER, "sh", "-c", "ls /var/lib/vyre/downloads/ag20000 && ! touch /var/lib/vyre/downloads/ag20000/x 2>/dev/null && echo readable-not-writable"]);
  check(/readable-not-writable/.test(dl), "the agent can read its downloads folder and not write to it", dl.slice(-80));
  const prefs = shOk(["exec", "-u", "0", CONTAINER, "cat", "/var/lib/vyre/browsers/agb21000/profile/Default/Preferences"]);
  check(/"password_manager_enabled":\s*false/.test(prefs) && /"credentials_enable_service":\s*false/.test(prefs), "the profile has the password manager off", "ok");
  await b.close(); await adapter.close();
  fs.writeFileSync(path.join(OUT, "agents-proof.txt"), "all agent computer checks passed\n");
  console.log("agent computer proof: all checks passed");
} catch (e) {
  console.log(`FAIL ${e.message}\n--- container log (tail)\n${shOk(["logs", "--tail", "60", CONTAINER]).slice(-4000)}`);
  process.exitCode = 1;
} finally {
  try { await d.stop(id); } catch {}
}
