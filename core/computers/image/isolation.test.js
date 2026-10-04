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

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const C = process.env.VYRE_COMPUTER_CONTAINER || "";
const skip = C ? false : "set VYRE_COMPUTER_CONTAINER to a running computer to check its isolation";

// Static checks (no container needed): the two MEDIUMs the reviewer found on b001e641 (before
// browser had its own uid) stay fixed even without a throwaway stack to check them live on.
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = fs.readFileSync(path.join(HERE_DIR, "Dockerfile"), "utf8");
const ENTRYPOINT = fs.readFileSync(path.join(HERE_DIR, "entrypoint.sh"), "utf8");

test("isolation (static): Chrome's managed download policy points at browser's own folder, not the agent's home", () => {
  assert.match(DOCKERFILE, /"DownloadDirectory": "\/var\/lib\/vyre\/browser\/downloads"/,
    "the managed policy still sends downloads to the agent's home (MEDIUM 2, reviewer 28 Sep)");
  assert.doesNotMatch(DOCKERFILE, /"DownloadDirectory": "\/home\/agent/, "downloads point back at the agent's home");
});

test("isolation (static): the agent can reach browser's downloads folder despite /var/lib/vyre being locked down", () => {
  assert.match(DOCKERFILE, /chmod 0711 \/var\/lib\/vyre\b/, "/var/lib/vyre is not traversable (MEDIUM 3, reviewer 28 Sep)");
  assert.match(DOCKERFILE, /chown browser:agent \/var\/lib\/vyre\/browser && chmod 0750 \/var\/lib\/vyre\/browser/,
    "browser's own folder does not grant the agent group read+execute");
  assert.match(DOCKERFILE, /chown browser:agent \/var\/lib\/vyre\/browser\/downloads && chmod 2750/,
    "the downloads folder itself does not grant the agent group read");
});

test("isolation (static): Chrome is launched by entrypoint.sh (root), never by computerd, and both drop every capability", () => {
  assert.match(ENTRYPOINT, /setpriv --reuid=1002 --regid=1002 --init-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all/,
    "Chrome's setpriv call no longer strips ambient capabilities and the bounding set (the CAP_SETUID HIGH, reviewer 28 Sep)");
  assert.match(ENTRYPOINT, /setpriv --reuid=1001 --regid=1001 --init-groups --inh-caps=-all -- \\\n[\s\S]*?node \/opt\/computerd\/index\.js/,
    "computerd's own setpriv call grants it a capability again");
  assert.doesNotMatch(ENTRYPOINT, /ambient-caps=\+cap_setuid/, "something still grants an ambient CAP_SETUID");
});

test("isolation (static): Chrome's FIFOs are made under vyre's own volume, before the agent's xterm, and fail closed (reviewer HIGH, 28 Sep)", () => {
  assert.match(ENTRYPOINT, /CHROME_DIR="\$\{VYRE_HOME\}\/chrome-pipes"/,
    "CHROME_DIR is not under vyre's own volume (/var/lib/vyre/chrome-pipes) -- the agent's uid can write to /tmp");
  assert.doesNotMatch(ENTRYPOINT, /CHROME_DIR=\/tmp\/vyre-chrome/, "CHROME_DIR is still the old /tmp path, writable by the agent's uid");
  assert.doesNotMatch(ENTRYPOINT, /CHROME_DIR=\/run\/vyre-chrome/, "CHROME_DIR is the /run path computerd's stale default still names");
  // The reviewer's second HIGH (28 Sep): /var/lib/vyre is the computer's own named volume, kept
  // across a stop/start and a Docker restart, so a first boot's own chrome-pipes/ must be removed
  // before the mkdir below, not left for it to trip over as if it were an attacker's plant.
  assert.match(ENTRYPOINT, /as_vyre rm -rf -- "\$\{CHROME_DIR\}" \|\| exit 1\n(?:#.*\n)*as_vyre sh -c 'umask 007; mkdir "\$0"' "\$\{CHROME_DIR\}"/,
    "CHROME_DIR is not removed before the mkdir -- a second boot on the same volume would refuse to start");
  // mkdir with no -p: a directory (or symlink) already at that name must abort the boot, not be reused.
  assert.match(ENTRYPOINT, /mkdir "\$0"' "\$\{CHROME_DIR\}" \\\n\s*\|\| \{ log "\$\{CHROME_DIR\} already exists[\s\S]*?exit 1; \}/,
    "CHROME_DIR's mkdir is not a bare mkdir that fails closed on reuse (-p or a missing exit would let a pre-planted directory through)");
  assert.match(ENTRYPOINT, /\[ -d "\$0" \] && \[ ! -L "\$0" \]' "\$\{CHROME_DIR\}"[\s\S]*?is not a plain directory[\s\S]*?exit 1; \}/,
    "CHROME_DIR is not checked for being a symlink");
  assert.match(ENTRYPOINT, /stat -c %U "\$\{CHROME_DIR\}"\)" = "vyre"[\s\S]*?is not vyre's[\s\S]*?exit 1; \}/,
    "CHROME_DIR's owner is not checked to be vyre");
  assert.match(ENTRYPOINT, /as_vyre chgrp vyre-bus "\$\{CHROME_DIR\}" \|\| exit 1/, "a failed chgrp on CHROME_DIR does not abort the boot");
  assert.match(ENTRYPOINT, /as_vyre mkfifo -m 0660 "\$\{CHROME_IN\}" "\$\{CHROME_OUT\}" \|\| exit 1/, "a failed mkfifo does not abort the boot");
  // Order matters: this must all run before as_agent's xterm gets a shell that could run .bashrc.
  const dirIdx = ENTRYPOINT.indexOf('CHROME_DIR="${VYRE_HOME}/chrome-pipes"');
  const xtermIdx = ENTRYPOINT.indexOf("as_agent xterm");
  assert.ok(dirIdx > 0 && xtermIdx > 0 && dirIdx < xtermIdx,
    "the FIFO directory is made after (or xterm/CHROME_DIR not found), not before, the agent's xterm starts");
});

/** Run python3 code in the computer as the agent; returns stdout. */
function asAgent(code) {
  return execFileSync("docker", ["exec", "-u", "1000:1000", C, "python3", "-c", code], { encoding: "utf8", timeout: 30_000 }).trim();
}

/** Pids of some uid's processes whose command line matches. Readable by anyone: /proc/<pid>/status. */
const VYRE_PIDS = `
import os, re
def by_uid(uid, match):
    out = []
    for p in os.listdir('/proc'):
        if not p.isdigit(): continue
        try:
            st = open(f'/proc/{p}/status').read()
            u = int(re.search(r'^Uid:\\s+(\\d+)', st, re.M).group(1))
            name = re.search(r'^Name:\\s+(.*)$', st, re.M).group(1)
        except Exception: continue
        if u == uid and re.search(match, name): out.append(int(p))
    return out
def vyre(match): return by_uid(1001, match)
def browser(match): return by_uid(1002, match)
`;

test("isolation: the agent's uid is 1000, Chrome runs as 1002, and computerd and Xvnc run as 1001", { skip }, () => {
  const r = JSON.parse(asAgent(`${VYRE_PIDS}
import json
print(json.dumps({"me": os.getuid(), "node": len(vyre('^node$')), "chrome_vyre": len(vyre('chrom')), "chrome_browser": len(browser('chrom')), "xvnc": len(vyre('^Xvnc$'))}))`));
  assert.equal(r.me, 1000);
  assert.ok(r.node >= 1, "computerd is not running as vyre");
  assert.equal(r.chrome_vyre, 0, "Chrome is running as vyre, not its own uid");
  assert.ok(r.chrome_browser >= 1, "Chrome is not running as browser (1002)");
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
for pid in browser('chrom')[:3] + vyre('^node$')[:1]:
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
# docker exec gives every process it starts the container's Env, this one included: so the Env
# must never hold a secret (they come by /var/lib/vyre/.boot), and this very process is checked.
for f in glob.glob('/proc/[0-9]*/environ'):
    try: data = open(f, 'rb').read()
    except Exception: continue
    if b'COMPUTERD_TOKEN=' in data or b'VNC_PASSWORD=' in data: leaks.append(f)
home = {}
for d in ('/var/lib/vyre', '/var/lib/vyre/chromium'):
    try: os.listdir(d); home[d] = 'readable'
    except PermissionError: home[d] = 'denied'
    except FileNotFoundError: home[d] = 'missing'
try: open('/var/lib/vyre/.boot').read(); boot = 'readable'
except PermissionError: boot = 'denied'
except FileNotFoundError: boot = 'missing'
try: open('/var/lib/vyre/.agent-tokens').read(); agent_tokens = 'readable'
except PermissionError: agent_tokens = 'denied'
except FileNotFoundError: agent_tokens = 'missing'
print(json.dumps({"env": env, "mem": mem, "traced": traced, "leaks": leaks, "home": home, "boot": boot, "agent_tokens": agent_tokens}))`));
  assert.ok(Object.keys(r.env).length > 0, "found no computerd to check");
  for (const how of Object.values(r.env)) assert.equal(how, "denied", "the agent read computerd's environment");
  for (const how of Object.values(r.mem)) assert.notEqual(how, "readable", "the agent read computerd's memory");
  for (const how of Object.values(r.traced)) assert.notEqual(how, "attached", "the agent attached ptrace to computerd");
  assert.deepEqual(r.leaks, [], "a process the agent can read (an exec'd one included) carries COMPUTERD_TOKEN or VNC_PASSWORD");
  assert.equal(r.boot, "denied", "the agent can read /var/lib/vyre/.boot");
  // Same identity file as the browser-uid check above (AGENT_TOKENS in policy.js): a computer
  // with none is "missing", fine; "readable" from the agent's own uid never is -- every other
  // agent sharing the computer's token would otherwise be sitting in a file this agent can open.
  assert.notEqual(r.agent_tokens, "readable", "the agent can read /var/lib/vyre/.agent-tokens");
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

test("isolation: browser (Chrome's uid) cannot read vyre's secrets or vyre's own X cookie", { skip }, () => {
  const r = JSON.parse(execFileSync("docker", ["exec", "-u", "1002:1002", C, "python3", "-c", `
import os, json
def probe(path):
    try: open(path, 'rb').read(); return 'readable'
    except IsADirectoryError:
        try: os.listdir(path); return 'readable'
        except PermissionError: return 'denied'
    except PermissionError: return 'denied'
    except FileNotFoundError: return 'missing'
print(json.dumps({
  "boot": probe('/var/lib/vyre/.boot'),
  "agent_tokens": probe('/var/lib/vyre/.agent-tokens'),
  "vnc_passwd": probe('/var/lib/vyre/.vnc/passwd'),
  "vyre_xauth": probe('/var/lib/vyre/.Xauthority'),
  "vyre_home_listing": probe('/var/lib/vyre'),
  "own_profile": probe('/var/lib/vyre/browser/chromium'),
}))`], { encoding: "utf8", timeout: 30_000 }).trim());
  assert.equal(r.boot, "denied", "browser can read /var/lib/vyre/.boot");
  // A shared (browser-kind) computer has .agent-tokens too, same directory, same owner and mode
  // as .boot (policy.js AGENT_TOKENS); a computer with none is fine ("missing"), but "readable"
  // never is -- computerd (vyre) is the only uid that identity file may ever answer for.
  assert.notEqual(r.agent_tokens, "readable", "browser can read /var/lib/vyre/.agent-tokens");
  assert.equal(r.vnc_passwd, "denied", "browser can read the VNC password");
  assert.equal(r.vyre_xauth, "denied", "browser can read vyre's own X cookie");
  assert.equal(r.vyre_home_listing, "denied", "browser can list vyre's home (secrets included)");
  assert.equal(r.own_profile, "readable", "browser cannot even reach its own Chrome profile");
});

test("isolation: computerd and Chrome hold no capability at all -- CapEff and CapAmb are both 0 (reviewer, CAP_SETUID HIGH, 28 Sep)", { skip }, () => {
  const r = JSON.parse(asAgent(`${VYRE_PIDS}
import json
def caps(pids):
    out = {}
    for p in pids:
        try:
            st = open(f'/proc/{p}/status').read()
            out[p] = {k: re.search(rf'^{k}:\\s+(\\S+)', st, re.M).group(1) for k in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')}
        except Exception as e: out[p] = {"error": str(e)}
    return out
print(json.dumps({"node": caps(vyre('^node$')), "chrome": caps(browser('chrom'))}))`));
  assert.ok(Object.keys(r.node).length > 0, "found no computerd to check");
  assert.ok(Object.keys(r.chrome).length > 0, "found no Chrome to check");
  for (const [group, pids] of Object.entries(r)) {
    for (const [pid, caps] of Object.entries(pids)) {
      for (const k of ["CapEff", "CapAmb", "CapPrm"]) {
        assert.equal(caps[k], "0000000000000000", `${group} pid ${pid}'s ${k} is ${caps[k]}, not zero`);
      }
    }
  }
});

const TOKEN = process.env.VYRE_COMPUTERD_TOKEN || "";

/** Run python3 code in the computer as vyre (computerd's own uid), the token passed on stdin. */
function asVyre(code) {
  return execFileSync("docker", ["exec", "-i", "-u", "1001:1001", C, "python3", "-c", code], { input: TOKEN, encoding: "utf8", timeout: 30_000 }).trim();
}

const VYRE_PROBE = `
import os, json
def probe(p):
    try:
        st = os.lstat(p)
        return {"owner": st.st_uid, "mode": oct(st.st_mode & 0o7777), "is_symlink": os.path.islink(p)}
    except Exception as e:
        return {"error": type(e).__name__}
`;

test("isolation: Chrome's FIFOs live at /var/lib/vyre/chrome-pipes, owned by vyre, and the agent cannot see, write, replace or symlink into them", { skip: skip || (TOKEN ? false : "set VYRE_COMPUTERD_TOKEN too (asVyre needs it on stdin)") }, () => {
  // The directory is 0770 vyre:vyre-bus, so the agent's uid (in neither) cannot even lstat what's
  // inside it by path -- checked as vyre itself, the one uid that can see the real facts.
  const facts = JSON.parse(asVyre(`${VYRE_PROBE}
print(json.dumps({
  "dir": probe("/var/lib/vyre/chrome-pipes"),
  "in": probe("/var/lib/vyre/chrome-pipes/in"),
  "out": probe("/var/lib/vyre/chrome-pipes/out"),
  "old_tmp_path": probe("/tmp/vyre-chrome"),
}))`));
  assert.equal(facts.dir.owner, 1001, "the FIFO directory is not owned by vyre (1001)");
  assert.equal(facts.dir.is_symlink, false, "the FIFO directory is a symlink");
  assert.equal(facts.dir.mode, "0o770", `the FIFO directory's mode is ${facts.dir.mode}, not 0770`);
  for (const name of ["in", "out"]) {
    assert.equal(facts[name].owner, 1001, `the ${name} FIFO is not owned by vyre (1001)`);
    assert.equal(facts[name].mode, "0o660", `the ${name} FIFO's mode is ${facts[name].mode}, not 0660`);
  }
  assert.equal(facts.old_tmp_path.error, "FileNotFoundError", "the old /tmp/vyre-chrome path exists -- something still uses it, or it was pre-planted");

  // As the agent: cannot even stat into the directory (no x on it), let alone write, replace or
  // walk past it -- the mode above is not just declared, it holds against the one uid it must.
  const denied = JSON.parse(asAgent(`${VYRE_PROBE}
def can_write(p):
    try:
        with open(p, "a"): pass
        return True
    except Exception:
        return False
def can_replace(p):
    try:
        os.unlink(p)
        return True
    except Exception:
        return False
print(json.dumps({
  "stat_in": probe("/var/lib/vyre/chrome-pipes/in"),
  "write_dir": can_write("/var/lib/vyre/chrome-pipes/agent-planted"),
  "unlink_in": can_replace("/var/lib/vyre/chrome-pipes/in"),
}))`));
  assert.equal(denied.stat_in.error, "PermissionError", "the agent's uid can stat into the FIFO directory at all");
  assert.equal(denied.write_dir, false, "the agent's uid can create a new file inside the FIFO directory");
  assert.equal(denied.unlink_in, false, "the agent's uid can unlink (and so replace) Chrome's own FIFO");
});

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
