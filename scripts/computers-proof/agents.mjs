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
  if (!ok) { if (process.env.PROOF_CONTINUE === "1") { failedChecks.push(name); return; } throw new Error(`step failed: ${name}`); }
}
const failedChecks = [];
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
  let up = false, lastErr = "";
  for (let i = 0; i < 60 && !up; i++) { try { await ctl.createUser(A); up = true; } catch (e) { lastErr = String(e && e.message || e); await sleep(2000); } }
  if (!up) {
    console.log("agentd last error: " + lastErr);
    console.log("--- processes in the computer\n" + shOk(["exec", CONTAINER, "sh", "-c", "ps -eo user,pid,args | grep -v -E 'chromium|ps -eo|grep' | cut -c1-200 | head -40"]));
    console.log("--- agentd dir\n" + shOk(["exec", CONTAINER, "sh", "-c", "ls -la /var/lib/vyre/agentd /opt/agentd 2>&1 | head -40"]));
    console.log("--- agentd status\n" + shOk(["exec", CONTAINER, "sh", "-c", "grep -E '^(Name|Uid|CapEff|CapBnd|NoNewPrivs)' /proc/$(pgrep -f agentd-main | head -1)/status 2>&1"]));
    console.log("--- agentctl\n" + shOk(["exec", CONTAINER, "sh", "-c", "getent passwd agentctl; ls -la /opt/agentd/client; cat /opt/agentd/client"]));
    console.log("--- container log (full)\n" + shOk(["logs", CONTAINER]).slice(-6000));
    console.log("--- proxy log\n" + (() => { try { return fs.readFileSync(path.join(DIR, "run", "proxy.log"), "utf8").slice(-4000); } catch (e) { return String(e.message); } })());
  }
  check(up, "agentd answers through the one allowed exec", up ? undefined : lastErr);
  // the process itself: agentctl's uid, no new privileges, and a bounding set of setuid and setgid only (the entrypoint cannot set securebits: that needs CAP_SETPCAP, which no computer has)
  const apid = shOk(["exec", CONTAINER, "sh", "-c", "pgrep -u agentctl -f agentd-main | head -1"]);
  const ast = shOk(["exec", CONTAINER, "grep", "-E", "^(Uid|CapEff|CapBnd|CapAmb|NoNewPrivs):", `/proc/${apid}/status`]);
  check(/^Uid:\s*1004\b/m.test(ast) && /^NoNewPrivs:\s*1$/m.test(ast) && /^CapBnd:\s*0*c0$/m.test(ast) && /^CapAmb:\s*0*c0$/m.test(ast) && /^CapEff:\s*0*c0$/m.test(ast), "agentd runs as agentctl with no new privileges and only setuid and setgid in its bounding set", ast.replace(/\n/g, " | "));
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
  if (a === null) {
    console.log("--- processes of agent A's screen\n" + shOk(["exec", CONTAINER, "sh", "-c", "ps -eo user,pid,args | grep -E 'agb2|ag2|Xvnc|fluxbox|chromium|agentd' | grep -v grep | cut -c1-220 | head -30"]));
    console.log("--- agent A's browser folder\n" + shOk(["exec", "-u", "0", CONTAINER, "sh", "-c", "ls -la /var/lib/vyre/browsers/agb21000 /var/lib/vyre/x/ag20000 2>&1 | head -30"]));
    const PRE = "setpriv --reuid=21000 --regid=21000 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs --";
    for (const [label, lim] of [["with the agentd limits (--as 3 GiB, 512 procs)", "prlimit --as=3221225472 --nproc=512 --nofile=4096 --fsize=4294967296"], ["without --as", "prlimit --nproc=512 --nofile=4096 --fsize=4294967296"]]) {
      console.log(`--- agentd-chrome.py as agentd starts it, ${label} (10 s)\n` + shOk(["exec", "-u", "0", CONTAINER, "sh", "-c", `timeout 10 ${PRE} ${lim} /usr/bin/nice -n 5 /usr/bin/env -i HOME=/var/lib/vyre/browsers/agb21000 PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -I /opt/agentd/agentd-chrome.py 2>&1 | grep -v 'dbus\\|DBus' | head -12; echo "exit $?"; pgrep -u 21000 -c chromium`]));
    }
    console.log("--- id and limits of the browser uid\n" + shOk(["exec", "-u", "21000", CONTAINER, "sh", "-c", "id; ulimit -a | head -20; df -h /dev/shm | tail -1; ls -ld /var/lib/vyre/browsers/agb21000 /var/lib/vyre/browsers/agb21000/profile 2>&1"]));
  }
  check(a !== null, "agent A's Chrome answers over its debugging pipe");
  // the link is the browser target, which has no Network domain: cookies are read and written through Storage
  const cookiesOf = async c => (await c.send("Storage.getCookies", {})).cookies.filter(x => x.domain.replace(/^\./, "") === "example.com");
  await a.send("Storage.setCookies", { cookies: [{ name: "proof_login", value: "signed-in-1", domain: "example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 86400, secure: true }] });
  const before = (await cookiesOf(a)).map(c => c.name);
  check(before.includes("proof_login"), "a persistent cookie is set in A's Chrome", before);
  await a.close(); adapter.drop("a");
  // Chrome commits cookies to disk in batches every 30 s (a login is that old by the time a screen has been idle for 5 minutes); a cookie set a second ago is not on disk yet, whatever the shutdown does.
  await sleep(35_000);
  // where the cookie lives on disk (printed for the log; the check is the cookie after waking)
  const cookieDb = when => console.log(`--- cookie files ${when}\n` + shOk(["exec", "-u", "21000", CONTAINER, "python3", "-c",
    "import sqlite3,glob,os\nfor f in glob.glob('/var/lib/vyre/browsers/agb21000/profile/**/Cookies', recursive=True):\n    print(f, os.path.getsize(f))\n    try:\n        c=sqlite3.connect('file:'+f+'?mode=ro', uri=True)\n        print(c.execute('select host_key,name,length(value),length(encrypted_value),expires_utc,is_persistent from cookies').fetchall())\n    except Exception as e:\n        print('sqlite', e)"]));
  cookieDb("before sleeping");
  // a login made in the last seconds before the computer sleeps: only a clean close of Chrome (Browser.close from the holder) writes it
  adapter.drop("a");
  const a3 = await connect("a");
  await a3.send("Storage.setCookies", { cookies: [{ name: "proof_fresh", value: "just-now", domain: "example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 86400, secure: true }] });
  await a3.close(); adapter.drop("a");

  await ctl.stopScreen(A); await sleep(8000);   // Chrome ends on SIGTERM and writes its profile
  check(!/chromium/.test(shOk(["exec", CONTAINER, "sh", "-c", "ps -u 21000 -o args= || true"])), "A's Chrome is gone after sleep");
  cookieDb("after sleeping");
  await ctl.startScreen(A);
  let a2 = null;
  for (let i = 0; i < 30 && !a2; i++) { try { a2 = await connect("a"); } catch { adapter.drop("a"); await sleep(2000); } }
  check(a2 !== null, "A's Chrome answers again after waking");
  const after = (await cookiesOf(a2)).map(c => `${c.name}=${c.value}`);
  if (!after.includes("proof_login=signed-in-1")) { cookieDb("after waking"); console.log("all cookies: " + JSON.stringify((await a2.send("Storage.getCookies", {})).cookies.map(c => c.domain + " " + c.name))); }
  check(after.includes("proof_login=signed-in-1"), "the login survived the computer sleeping and waking", after);
  check(after.includes("proof_fresh=just-now"), "a login made seconds before the computer slept survived too (Chrome closed cleanly and wrote its profile)", after);

  const b = await connect("b");
  const bCookies = (await cookiesOf(b)).map(c => c.name);
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
  // The cookie works (the agent's X clients connect), and the extension that makes it untrusted is on: the owner sees SECURITY in the server's extension list, the untrusted client is not shown it.
  const info = shOk(["exec", "-u", "20000", ...xenv, CONTAINER, "sh", "-c", "xdpyinfo 2>&1 | head -1"]);
  check(/name of display:\s+:20/.test(info), "the agent's untrusted cookie works: its X clients connect to its own screen", info);
  const ownerExt = shOk(["exec", "-u", "21000", "-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/browsers/agb21000/xauth", CONTAINER, "sh", "-c", "xdpyinfo | grep -c SECURITY"]);
  check(/^[1-9]/.test(ownerExt), "the X SECURITY extension is on in the agent's screen (the owner lists it)", ownerExt);
  const grab = shOk(["exec", "-u", "20000", ...xenv, CONTAINER, "sh", "-c", "import -window root /tmp/agent-grab.png >/dev/null 2>&1; echo $?"]);
  const ownGrab = shOk(["exec", "-u", "21000", "-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/browsers/agb21000/xauth", CONTAINER, "sh", "-c", "import -window root /tmp/browser-grab.png >/dev/null 2>&1; echo $?"]);
  check(ownGrab === "0", "the screen's owner can capture its own screen", ownGrab);
  check(grab !== "0", "an untrusted client cannot capture the screen (other clients' windows)", `exit ${grab}`);
  // Keystrokes. The claim is that code running as the agent, with the cookie it has, cannot capture or inject input on the screen. Each is tested with a positive control as the screen's owner, because the
  // defaults of the X SECURITY extension have changed between server versions and a test that cannot fail proves nothing.
  const asOwner = ["exec", "-u", "21000", "-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/browsers/agb21000/xauth"];
  const asUntrusted = ["exec", "-u", "20000", "-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/x/ag20000/xauth"];
  // RECORD is the X extension that reports every key typed on the screen. libXtst's calls return 0 without a word when the server does not offer the extension to this client (an untrusted client is not shown it),
  // so the probe asks for the version first and creates a context only when it is there. "allowed" means the client could record; "refused" means the extension is absent or the request errored.
  const recordPy = [
    "import ctypes",
    "x=ctypes.CDLL('libX11.so.6');t=ctypes.CDLL('libXtst.so.6')",
    "x.XOpenDisplay.restype=ctypes.c_void_p",
    "d=x.XOpenDisplay(None)",
    "errs=[]",
    "H=ctypes.CFUNCTYPE(ctypes.c_int,ctypes.c_void_p,ctypes.c_void_p)",
    "cb=H(lambda a,b:(errs.append(1),0)[1])",
    "x.XSetErrorHandler(cb)",
    "t.XRecordQueryVersion.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_int),ctypes.POINTER(ctypes.c_int)]",
    "ma=ctypes.c_int();mi=ctypes.c_int()",
    "ok=t.XRecordQueryVersion(ctypes.c_void_p(d),ctypes.byref(ma),ctypes.byref(mi))",
    "if ok:",
    "    t.XRecordAllocRange.restype=ctypes.c_void_p",
    "    r=t.XRecordAllocRange()",
    "    c=ctypes.c_ulong(3)",
    "    rs=(ctypes.c_void_p*1)(r)",
    "    t.XRecordCreateContext.restype=ctypes.c_ulong",
    "    t.XRecordCreateContext(ctypes.c_void_p(d),0,ctypes.byref(c),1,rs,1)",
    "    x.XSync(ctypes.c_void_p(d),0)",
    "print('refused' if (not ok or errs) else 'allowed')",
  ].join("\n");
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
  // raw XInput2 root events bypass the window-targeted xev above: a listener on the root under the agent's cookie must hear no key while the owner types, and the owner's own listener must (the control)
  shOk(["exec", "-u", "20000", "-e", "DISPLAY=:20", "-e", "XAUTHORITY=/var/lib/vyre/x/ag20000/xauth", CONTAINER, "sh", "-c", "(timeout 6 xinput test-xi2 --root > /tmp/agent-xi2.log 2>&1 &) ; sleep 1"]);
  shOk([...asOwner, CONTAINER, "sh", "-c", "(timeout 6 xinput test-xi2 --root > /tmp/owner-xi2.log 2>&1 &) ; sleep 1; xdotool key r; sleep 1.5"]);
  const xi2Agent = shOk(["exec", "-u", "20000", CONTAINER, "sh", "-c", "grep -c KeyPress /tmp/agent-xi2.log || true"]);
  const xi2Owner = shOk(["exec", "-u", "21000", CONTAINER, "sh", "-c", "grep -c KeyPress /tmp/owner-xi2.log || true"]);
  check(Number(xi2Owner) >= 1, "the owner's XInput2 root listener hears the key (the control)", xi2Owner);
  check(Number(xi2Agent) === 0, "(c) an XInput2 root listener with the agent's cookie hears no key", `${xi2Agent}`);
  const ownerHeard = shOk([...asOwner, CONTAINER, "sh", "-c", `timeout 4 xev -id ${wid} > /tmp/owner-xev.log 2>&1 & sleep 1; xdotool key e; sleep 1.5; grep -c KeyPress /tmp/owner-xev.log || true`]);
  check(Number(ownerHeard) >= 1, "the owner's own listener does hear it (the control)", ownerHeard);
  const dl = shOk(["exec", "-u", "20000", CONTAINER, "sh", "-c", "ls /var/lib/vyre/downloads/ag20000 && ! touch /var/lib/vyre/downloads/ag20000/x 2>/dev/null && echo readable-not-writable"]);
  check(/readable-not-writable/.test(dl), "the agent can read its downloads folder and not write to it", dl.slice(-80));
  const prefs = shOk(["exec", "-u", "21000", CONTAINER, "cat", "/var/lib/vyre/browsers/agb21000/profile/Default/Preferences"]);
  check(/"password_manager_enabled":\s*false/.test(prefs) && /"credentials_enable_service":\s*false/.test(prefs), "the profile has the password manager off", prefs.slice(0, 120));
  // (4) a streaming run: it runs as the agent's uid in a good folder, and a link in the home that leads out of it (to /etc, to another agent's home) is refused by the helper's realpath check
  const run = (cwd, argv = ["/usr/bin/id", "-u"]) => new Promise(async (resolve, reject) => {
    const ticket = crypto.randomBytes(24).toString("base64url");
    try { await ctl.runTicket(A, ticket, { argv, cwd }); } catch (e) { return resolve({ registered: false, why: e.message }); }
    const s = net.connect(RELAY_PORT, ip); let buf = Buffer.alloc(0); const out = { registered: true, stdout: "", exit: null };
    s.on("connect", () => s.write(`${ticket}\n`)); s.on("error", reject);
    s.on("data", c => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
        const kind = buf[0], n = buf.readUInt32BE(1), payload = buf.subarray(5, 5 + n); buf = buf.subarray(5 + n);
        if (kind === 0) out.stdout += payload.toString(); else if (kind === 2) { out.exit = JSON.parse(payload.toString()); s.destroy(); resolve(out); }
      }
    });
    setTimeout(() => { s.destroy(); resolve(out); }, 8000);
  });
  const AH = "/var/lib/vyre/agents/ag20000/home";
  shOk(["exec", "-u", "20000", CONTAINER, "sh", "-c", `ln -sfn /etc ${AH}/to-etc && ln -sfn /var/lib/vyre/agents/ag20001/home ${AH}/to-other && mkdir -p ${AH}/work`]);
  const good = await run(`${AH}/work`);
  check(good.exit && good.exit.code === 0 && good.stdout.trim() === "20000", "a run starts as the agent's uid in a folder of its home", good);
  // sec53: what a process started THROUGH agentd holds. The agent's shell and the agent's Chrome have no capability at all and cannot gain one; this is the guard that does not depend on securebits.
  const zero = "0000000000000000";
  const capsOf = txt => Object.fromEntries(["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(k => [k, ((new RegExp(`^${k}:\\s*(\\S+)`, "m")).exec(txt) || [])[1]]));
  const agentProc = await run(`${AH}/work`, ["/usr/bin/grep", "-E", "^(Cap|NoNewPrivs)", "/proc/self/status"]);
  const agentCaps = capsOf(agentProc.stdout || "");
  // The bounding set cannot be emptied here (dropping from it needs CAP_SETPCAP, which no computer has), so it stays at the computer's own two bits at most; with nothing permitted, inheritable or ambient and no-new-privileges it grants nothing.
  const boundOk = v => /^0*[0-9a-f]{0,2}$/.test(String(v)) && (parseInt(v, 16) & ~0xc0) === 0;
  check(["CapInh", "CapPrm", "CapEff", "CapAmb"].every(k => agentCaps[k] === zero) && boundOk(agentCaps.CapBnd) && /^NoNewPrivs:\s*1$/m.test(agentProc.stdout || ""), "a process agentd starts for the agent holds no capability (inheritable, permitted, effective, ambient; bounding at most the computer's own two) and has no-new-privileges", { ...agentCaps, out: (agentProc.stdout || "").replace(/\n/g, " | ").slice(-200) });
  const cpid = shOk(["exec", "-u", "0", CONTAINER, "sh", "-c", "pgrep -u 21000 -x chromium | head -1"]);
  const chromeStatus = shOk(["exec", "-u", "0", CONTAINER, "grep", "-E", "^(Cap|NoNewPrivs)", `/proc/${cpid}/status`]);
  check(["CapInh", "CapPrm", "CapEff", "CapAmb"].every(k => capsOf(chromeStatus)[k] === zero) && boundOk(capsOf(chromeStatus).CapBnd) && /^NoNewPrivs:\s*1$/m.test(chromeStatus), "the agent's Chrome (the browser uid, started through agentd) holds no capability and has no-new-privileges", chromeStatus.replace(/\n/g, " | ").slice(-200));
  // sec53: what uid 0 would own if agentd ever became it (no securebits). Root-owned files nobody else may read, on the state volume and the homes; none may hold a token, key or password.
  const rootOwned = shOk(["exec", "-u", "0", CONTAINER, "sh", "-c", "find /var/lib/vyre /home -xdev -user 0 ! -perm -004 2>/dev/null | head -100"]);
  console.log("--- root-owned files with no world read (state volume and homes)\n" + (rootOwned || "(none)"));
  check(!/token|key|pass|secret|\.boot|xauth|cookie|\.pem|cred/i.test(rootOwned), "no root-owned, not world-readable file on the state volume or in the homes is a token, key or password", rootOwned ? rootOwned.split("\n").length + " files, none such" : "none");
  for (const link of ["to-etc", "to-other"]) {
    const bad = await run(`${AH}/${link}`);
    check(bad.registered && bad.exit && bad.exit.error && /inside the agent's home/.test(bad.exit.error) && bad.stdout === "", `a run through a link out of the home (${link}) is refused by the helper and prints nothing`, bad);
  }
  const outside = await run("/etc");
  check(outside.registered === false, "a folder outside the home is refused when the ticket is registered", outside.why);
  const asOther = shOk(["exec", "-u", "20001", CONTAINER, "ls", AH]);
  check(denied(asOther), "another agent cannot list this agent's home", asOther.slice(-80));
  // (5) the desk (owner, 20 Oct 2026): the agent's folders, the wallpaper, and a dock of Chrome, Terminal and Files whose programs are the agent's, in its folder. A woke after sleeping, so this is the desk a wake gives.
  const desk = shOk(["exec", "-u", "20000", CONTAINER, "sh", "-c", `cd ${AH} && ls -1d Inbox Work Done Downloads Scripts Notes && readlink Downloads && touch Inbox/.proof && rm Inbox/.proof && echo writable`]);
  check(["Inbox", "Work", "Done", "Downloads", "Scripts", "Notes"].every(n => desk.split("\n").includes(n)) && desk.includes("/var/lib/vyre/downloads/ag20000") && /writable$/.test(desk), "the agent's folder has Inbox, Work, Done, Downloads, Scripts and Notes, its own to write, and Downloads is Chrome's download folder", desk.replace(/\n/g, " "));
  const dockPid = shOk(["exec", "-u", "0", CONTAINER, "sh", "-c", "pgrep -u 20000 -f 'agentd-dock.py$' | head -1"]);
  check(/^\d+$/.test(dockPid), "the dock runs as the agent's uid", dockPid);
  // read as the agent itself: root in the computer has no DAC_OVERRIDE
  const dockEnv = shOk(["exec", "-u", "20000", CONTAINER, "sh", "-c", `tr '\\0' '\\n' < /proc/${dockPid}/environ | grep XAUTHORITY`]);
  check(dockEnv === "XAUTHORITY=/var/lib/vyre/x/ag20000/xauth", "the dock holds the agent's untrusted cookie, not the screen's", dockEnv);
  const wm = shOk(["exec", "-u", "0", CONTAINER, "sh", "-c", "ps -u 21000 -o args= | grep -m1 '^/usr/bin/fluxbox'"]);
  check(/-rc \/etc\/vyre-desk\/fluxbox\/init/.test(wm), "the window manager runs with the desk's settings (no toolbar, no desktop menu, no key that starts a program)", wm);
  const fifo = shOk(["exec", "-u", "21000", CONTAINER, "stat", "-c", "%F %a %U %G", "/var/lib/vyre/x/ag20000/show-chrome"]);
  check(fifo === "fifo 620 agb21000 ag20000", "the dock's Chrome button is a FIFO the browser uid owns, which only the agent's group may write", fifo);
  const otherWrite = shOk(["exec", "-u", "20001", CONTAINER, "sh", "-c", "echo 1 > /var/lib/vyre/x/ag20000/show-chrome"]);
  check(denied(otherWrite), "another agent cannot press this agent's Chrome button", otherWrite.slice(-80));
  const shoot = async name => {
    shOk([...asOwner, CONTAINER, "import", "-window", "root", `/var/lib/vyre/browsers/agb21000/${name}`]);
    shOk(["cp", `${CONTAINER}:/var/lib/vyre/browsers/agb21000/${name}`, path.join(OUT, name)]);
    return fs.existsSync(path.join(OUT, name)) ? fs.statSync(path.join(OUT, name)).size : 0;
  };
  // the probe window from the keystroke checks is the owner's and still up; close it so the picture is the desk
  shOk([...asOwner, CONTAINER, "sh", "-c", `xdotool windowkill ${wid} 2>/dev/null; true`]);
  await sleep(1000);
  check((await shoot("agent-desk.png")) > 1000, "a picture of agent A's desk is saved (agent-desk.png)");
  // the wallpaper itself (Chrome's window covers the middle of the screen in the picture)
  shOk(["cp", `${CONTAINER}:/var/lib/vyre/browsers/agb21000/wallpaper.png`, path.join(OUT, "agent-wallpaper.png")]);
  check(fs.existsSync(path.join(OUT, "agent-wallpaper.png")), "the wallpaper was made at the screen's size (agent-wallpaper.png)");
  // press the dock as a person would: it is centred at the bottom, three 76 px tiles (agentd-dock.py), on a 1440x900 screen
  const pages = async () => (await a2.send("Target.getTargets", {})).targetInfos.filter(t => t.type === "page").length;
  const tabsBefore = await pages().catch(e => `ERR ${e.message}`);
  const press = x => shOk([...asOwner, CONTAINER, "xdotool", "mousemove", String(x), "843", "click", "1"]);
  press(720); await sleep(3000);
  const term = shOk(["exec", "-u", "0", CONTAINER, "sh", "-c", "ps -u 20000 -o args= | grep -m1 '^/usr/bin/xterm'"]);
  check(/tmux -S \/var\/lib\/vyre\/agents\/ag20000\/tmux\.sock new-session -A -s desk -c \/var\/lib\/vyre\/agents\/ag20000\/home/.test(term), "Terminal opens a terminal as the agent, in its folder, on its own tmux", term);
  console.log("--- what the dock's terminal shows\n" + shOk(["exec", "-u", "20000", CONTAINER, "/usr/bin/tmux", "-S", "/var/lib/vyre/agents/ag20000/tmux.sock", "capture-pane", "-p", "-t", "desk"]).slice(0, 600));
  const sessions = await ctl.terminals(A).catch(e => `ERR ${e.message}`);
  check(Array.isArray(sessions) && sessions.some(s => s.name === "desk"), "the dock's terminal is one of the agent's terminals in Vyre", sessions);
  press(802); await sleep(4000);
  const fm = shOk(["exec", "-u", "0", CONTAINER, "sh", "-c", "ps -u 20000 -o args= | grep -m1 pcmanfm"]);
  check(/pcmanfm \/var\/lib\/vyre\/agents\/ag20000\/home$/.test(fm), "Files opens the file manager as the agent, on its folder", fm);
  press(638); await sleep(3000);
  const tabsAfter = await pages().catch(e => `ERR ${e.message}`);
  check(typeof tabsBefore === "number" && typeof tabsAfter === "number" && tabsAfter === tabsBefore + 1, "Chrome brings Chrome to the front with a new tab (the holder opens it; the agent never reaches Chrome's pipe)", `${tabsBefore} -> ${tabsAfter}`);
  await sleep(1000);
  check((await shoot("agent-desk-open.png")) > 1000, "a picture of the desk with Terminal, Files and Chrome open is saved (agent-desk-open.png)");

  await b.close(); await a2.close(); await adapter.close();
  fs.writeFileSync(path.join(OUT, "agents-proof.txt"), "all agent computer checks passed\n");
  if (failedChecks.length) throw new Error(`${failedChecks.length} checks failed: ${failedChecks.join("; ")}`);
  console.log("agent computer proof: all checks passed");
} catch (e) {
  console.log(`FAIL ${e.message}\n--- container log (tail)\n${shOk(["logs", "--tail", "60", CONTAINER]).slice(-4000)}`);
  process.exitCode = 1;
} finally {
  // After a FAIL the CDP sockets the steps opened would keep the process alive until the 10-minute watchdog: stop the computer (bounded), then leave at once with the proof's own exit code.
  try { await Promise.race([d.stop(id), sleep(30_000)]); } catch {}
  process.exit(process.exitCode || 0);
}
