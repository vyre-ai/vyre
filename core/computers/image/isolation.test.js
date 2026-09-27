// @ts-check
// isolation: on a real computer, the agent's own uid cannot reach what the uid split protects.
//
// Needs a running computer container, so it runs only where one exists (the throwaway stack on
// the test box) and skips everywhere else:
//
//   VYRE_COMPUTER_CONTAINER=<container name> node --test core/computers/image/isolation.test.js
//
// With VYRE_COMPUTERD_TOKEN set as well (the computer's helper token, from vyred's database), it
// also raises and lowers the shield and checks the agent's processes stop and continue.
//
// Each check runs as the agent (docker exec -u 1000:1000), the way anything the agent starts in
// its own xterm would. python3 is the tool: the image purges curl, and python3 is there for AT-SPI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const C = process.env.VYRE_COMPUTER_CONTAINER || "";
const skip = C ? false : "set VYRE_COMPUTER_CONTAINER to a running computer to check its isolation";

/** Run python3 code in the computer as the agent; returns stdout. */
function asAgent(code) {
  return execFileSync("docker", ["exec", "-u", "1000:1000", C, "python3", "-c", code], { encoding: "utf8", timeout: 30_000 }).trim();
}

/** Pids of vyre's (uid 1001) processes whose command line matches. Readable by anyone: /proc/<pid>/status. */
const VYRE_PIDS = `
import os, re
def vyre(match):
    out = []
    for p in os.listdir('/proc'):
        if not p.isdigit(): continue
        try:
            st = open(f'/proc/{p}/status').read()
            uid = int(re.search(r'^Uid:\\s+(\\d+)', st, re.M).group(1))
            name = re.search(r'^Name:\\s+(.*)$', st, re.M).group(1)
        except Exception: continue
        if uid == 1001 and re.search(match, name): out.append(int(p))
    return out
`;

test("isolation: the agent's uid is 1000 and computerd, Chrome and Xvnc run as 1001", { skip }, () => {
  const r = JSON.parse(asAgent(`${VYRE_PIDS}
import json
print(json.dumps({"me": os.getuid(), "node": len(vyre('^node$')), "chrome": len(vyre('chrom')), "xvnc": len(vyre('^Xvnc$'))}))`));
  assert.equal(r.me, 1000);
  assert.ok(r.node >= 1, "computerd is not running as vyre");
  assert.ok(r.chrome >= 1, "Chrome is not running as vyre");
  assert.equal(r.xvnc, 1, "Xvnc is not running as vyre");
});

test("isolation: the agent cannot reach Chrome's DevTools: no TCP listener but VNC and computerd, and no way into the pipe", { skip }, () => {
  const r = JSON.parse(asAgent(`${VYRE_PIDS}
import json, socket
listen = []
for f in ('/proc/net/tcp', '/proc/net/tcp6'):
    try: lines = open(f).read().splitlines()[1:]
    except Exception: continue
    for l in lines:
        parts = l.split()
        addr, port = parts[1].split(':')
        # 127.0.0.11 is Docker's own DNS resolver in the network namespace, not the computer's.
        if parts[3] == '0A' and addr != '0B00007F': listen.append(int(port, 16))
dials = {}
for port in (9222, 9223, 9229):
    s = socket.socket(); s.settimeout(1)
    try: s.connect(('127.0.0.1', port)); dials[port] = 'open'
    except Exception as e: dials[port] = type(e).__name__
    finally: s.close()
fds = {}
for pid in vyre('chrom')[:3] + vyre('^node$')[:1]:
    try: os.listdir(f'/proc/{pid}/fd'); fds[pid] = 'readable'
    except PermissionError: fds[pid] = 'denied'
print(json.dumps({"listen": sorted(set(listen)), "dials": dials, "fds": fds}))`));
  assert.deepEqual(r.listen.filter(p => p !== 5900 && p !== 7000), [], `unexpected TCP listeners: ${r.listen}`);
  for (const [port, how] of Object.entries(r.dials)) assert.notEqual(how, "open", `127.0.0.1:${port} answered`);
  assert.ok(Object.keys(r.fds).length > 0, "found no Chrome or computerd process to check");
  for (const [pid, how] of Object.entries(r.fds)) assert.equal(how, "denied", `the agent can list pid ${pid}'s file descriptors (the CDP pipe)`);
});

test("isolation: the agent cannot read computerd's environment, trace it, or find the token anywhere", { skip }, () => {
  const r = JSON.parse(asAgent(`${VYRE_PIDS}
import json, ctypes, glob
node = vyre('^node$')
env = {}
for pid in node:
    try: open(f'/proc/{pid}/environ', 'rb').read(); env[pid] = 'readable'
    except PermissionError: env[pid] = 'denied'
mem = {}
for pid in node:
    try: open(f'/proc/{pid}/mem', 'rb').read(1); mem[pid] = 'readable'
    except Exception as e: mem[pid] = type(e).__name__
libc = ctypes.CDLL(None, use_errno=True)
traced = {}
for pid in node:
    rc = libc.ptrace(16, pid, None, None)  # PTRACE_ATTACH
    traced[pid] = 'attached' if rc == 0 else ctypes.get_errno()
leaks = []
# docker exec gives every process it starts the container's create-time env, this one included;
# the agent's own processes (xterm and what it starts) never had it.
mine = {str(os.getpid()), str(os.getppid())}
for f in glob.glob('/proc/[0-9]*/environ'):
    if f.split('/')[2] in mine: continue
    try: data = open(f, 'rb').read()
    except Exception: continue
    if b'COMPUTERD_TOKEN=' in data or b'VNC_PASSWORD=' in data: leaks.append(f)
home = {}
for d in ('/var/lib/vyre', '/var/lib/vyre/chromium'):
    try: os.listdir(d); home[d] = 'readable'
    except PermissionError: home[d] = 'denied'
    except FileNotFoundError: home[d] = 'missing'
print(json.dumps({"env": env, "mem": mem, "traced": traced, "leaks": leaks, "home": home}))`));
  assert.ok(Object.keys(r.env).length > 0, "found no computerd to check");
  for (const how of Object.values(r.env)) assert.equal(how, "denied", "the agent read computerd's environment");
  for (const how of Object.values(r.mem)) assert.notEqual(how, "readable", "the agent read computerd's memory");
  for (const how of Object.values(r.traced)) assert.notEqual(how, "attached", "the agent attached ptrace to computerd");
  assert.deepEqual(r.leaks, [], "a process the agent can read carries COMPUTERD_TOKEN or VNC_PASSWORD");
  assert.equal(r.home["/var/lib/vyre"], "denied", "the agent can list vyre's volume (the Chrome profile)");
});

test("isolation: without the token the agent cannot lower the shield, reach /cdp, or read /fs", { skip }, () => {
  const r = JSON.parse(asAgent(`
import json, urllib.request, urllib.error
def call(method, path, body=None, headers={}):
    req = urllib.request.Request('http://127.0.0.1:7000' + path, method=method, data=body, headers=headers)
    try: return urllib.request.urlopen(req, timeout=5).status
    except urllib.error.HTTPError as e: return e.code
    except Exception as e: return type(e).__name__
print(json.dumps({
  "shield": call('POST', '/shield', b'{"on":false}', {'content-type': 'application/json'}),
  "shield_guess": call('POST', '/shield', b'{"on":false}', {'content-type': 'application/json', 'authorization': 'Bearer guess'}),
  "cdp": call('GET', '/cdp/json/version'),
  "fs": call('GET', '/fs/'),
}))`));
  assert.deepEqual(r, { shield: 401, shield_guess: 401, cdp: 401, fs: 401 });
});

const TOKEN = process.env.VYRE_COMPUTERD_TOKEN || "";

/** Run python3 code in the computer as vyre (computerd's own uid), the token passed on stdin. */
function asVyre(code) {
  return execFileSync("docker", ["exec", "-i", "-u", "1001:1001", C, "python3", "-c", code], { input: TOKEN, encoding: "utf8", timeout: 30_000 }).trim();
}

const STATES = `
import os, re, json
def agent_states():
    out = {}
    for p in os.listdir('/proc'):
        if not p.isdigit(): continue
        try: st = open(f'/proc/{p}/status').read()
        except Exception: continue
        if int(re.search(r'^Uid:\\s+(\\d+)', st, re.M).group(1)) != 1000: continue
        out[p] = re.search(r'^State:\\s+(\\S)', st, re.M).group(1)
    return out
`;

const SHIELD = on => `
import sys, urllib.request, json
tok = sys.stdin.read().strip()
req = urllib.request.Request('http://127.0.0.1:7000/shield', method='POST', data=json.dumps({"on": ${on ? "True" : "False"}}).encode(),
  headers={'content-type': 'application/json', 'authorization': 'Bearer ' + tok})
print(urllib.request.urlopen(req, timeout=5).read().decode())
`;

test("isolation: while shielded every process of the agent's is stopped, and continues after", { skip: skip || (TOKEN ? false : "set VYRE_COMPUTERD_TOKEN too") }, async () => {
  const before = JSON.parse(asVyre(`${STATES}\nprint(json.dumps(agent_states()))`));
  assert.ok(Object.keys(before).length > 0, "no agent process to check (is xterm running?)");
  try {
    assert.deepEqual(JSON.parse(asVyre(SHIELD(true))), { shielded: true, frozen: true });
    await new Promise(r => setTimeout(r, 500));
    const during = JSON.parse(asVyre(`${STATES}\nprint(json.dumps(agent_states()))`));
    for (const [pid, st] of Object.entries(during)) assert.equal(st, "T", `agent pid ${pid} is ${st}, not stopped, while shielded`);
  } finally {
    asVyre(SHIELD(false));
  }
  await new Promise(r => setTimeout(r, 500));
  const after = JSON.parse(asVyre(`${STATES}\nprint(json.dumps(agent_states()))`));
  for (const [pid, st] of Object.entries(after)) assert.notEqual(st, "T", `agent pid ${pid} is still stopped`);
});

/** Run a shell command in the computer as the agent, with its own environment; returns { code, out }. */
function shAgent(cmd) {
  try {
    const out = execFileSync("docker", ["exec", "-u", "1000:1000", "-e", "DISPLAY=:1", "-e", "XAUTHORITY=/run/vyre-x/agent.xauth", C, "sh", "-c", cmd],
      { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out: out.trim() };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: typeof err.status === "number" ? err.status : -1, out: String(err.stdout || "") + String(err.stderr || "") };
  }
}

test("isolation: the agent is an untrusted X client: no cookie no display, and no screen grab or XTEST with its own", { skip }, () => {
  assert.notEqual(shAgent("XAUTHORITY=/nonexistent xdpyinfo >/dev/null").code, 0, "the display admits a client with no cookie");
  const ok = shAgent("xdpyinfo -queryExtensions");
  assert.equal(ok.code, 0, `the agent's cookie does not open the display: ${ok.out}`);
  // An untrusted client is not even shown XTEST (nor SECURITY).
  assert.doesNotMatch(ok.out, /XTEST/, "the agent's display offers XTEST");
  // Chrome and the desktop are trusted windows; an untrusted client reading the root window gets
  // an error or nothing, never the pixels.
  const grab = shAgent("import -window root png:- 2>/dev/null | wc -c");
  assert.ok(grab.code !== 0 || Number(grab.out) === 0, `the agent grabbed the screen (${grab.out} bytes)`);
  const xtest = shAgent("xdotool key --clearmodifiers a");
  assert.notEqual(xtest.code, 0, "the agent injected input with XTEST");
  // Its own terminal still works: xterm is an ordinary untrusted client.
  const xterm = shAgent("pgrep -u 1000 -x xterm");
  assert.equal(xterm.code, 0, "the agent's xterm is not running under its untrusted cookie");
});
