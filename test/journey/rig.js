// @ts-check
// The journey harness's two machines on this one: a fresh Mac and a fresh Linux server, each a
// temp home with its own fakes (ADR 0008). Nothing here reaches a real ssh, docker, tailscale or
// claude, and nothing listens beyond 127.0.0.1 and ::1.
//
//   <root>/mac            the Mac's HOME; VYRE_HOME is mac/.vyre
//   <root>/srv/host       the server account's HOME, where remote commands run
//   <root>/srv/vyre       VYRE_DIR, the stack folder the installer creates
//   <root>/srv/bin        where the installer puts the host `vyre` wrapper (VYRE_WRAPPER)
//   <root>/srv/fakebin    docker, sudo, id, uname for the server's PATH
//   <root>/srv/home       the container's HOME; its .vyre is the box's vyred home
//   <root>/mirror         what https://vyre.run/box/ serves, as file:// (box/ plus SHA256SUMS)
//   <root>/rig.json       everything the fakes need (paths, both environments), via JOURNEY_RIG
//
// Two loopbacks stand for two machines: the box's onboarding page listens on [::1] (its host
// loopback, where Docker would publish the port), and the Mac's ssh forward puts it on the Mac's
// 127.0.0.1, same port on both ends as ADR 0002 wants. The tailnet listener binds 127.0.0.1,
// the address the fake box tailscale reports once it is Running.

import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
export const BIN = path.join(REPO, "bin", "vyre");
export const TARGET = "alex@203.0.113.4";
export const TS_NAME = "vyre.tail0000.ts.net";
const NODE = process.execPath;
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// sshd sets this for every remote command; the wrapper passes it into the container.
const SSH_CONNECTION = "198.51.100.7 50022 203.0.113.4 22";
const USER = { 7: { ID: 7, LoginName: "alex@example.com", DisplayName: "Alex" } };
export const BOX_RUNNING = { BackendState: "Running", TUN: true, AuthURL: "",
  Self: { HostName: "vyre", DNSName: `${TS_NAME}.`, TailscaleIPs: ["127.0.0.1"], ID: "nbox", UserID: 7 }, User: USER, CertDomains: [TS_NAME] };
const BOX_FRESH = { BackendState: "NeedsLogin", TUN: true, AuthURL: "", Self: null, User: null };

// The fake claude does the setup-token dance, as in test/onboard.test.js.
const CLAUDE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.283 (Claude Code)"; exit 0; fi
printf '\\033]8;id=a1;https://claude.com/cai/oauth/authorize?code=true&client_id=c1&state=s1\\033\\\\Sign in\\033]8;;\\033\\\\\\n'
printf 'Paste code here if prompted > '
read code
if [ "$code" = "good-code" ]; then printf '\\nYour token: sk-ant-oat01-${"Zx9_".repeat(12)}\\n'; else printf '\\nInvalid code\\n'; exit 1; fi
`;

/** A port free on both loopbacks, so the Mac's end and the box's end can share its number. */
export async function freePort() {
  for (;;) {
    const port = await new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {net.AddressInfo} */ (s.address()).port; s.close(() => res(p)); }); });
    const six = await new Promise(res => { const s = net.createServer(); s.once("error", () => res(false)); s.listen(port, "::1", () => s.close(() => res(true))); });
    if (six) return /** @type {number} */ (port);
  }
}

const exe = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, { mode: 0o755 }); };
const shim = (file, script, ...pre) => exe(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, script)}" ${pre.join(" ")} "$@"\n`);
const sha256 = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** The folder python3 lives in, for the pty relay that drives `claude setup-token` on a Mac. */
function python3Dir() {
  try { return path.dirname(execFileSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim()); } catch { return null; }
}

/** A self-signed certificate for the box's ts.net name, what `tailscale cert` would fetch. */
function makeCert(dir) {
  const crt = path.join(dir, "cert.pem"), key = path.join(dir, "key.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", crt,
      "-days", "60", "-subj", `/CN=${TS_NAME}`, "-addext", `subjectAltName=DNS:${TS_NAME}`], { stdio: "ignore" });
    return { crt, key };
  } catch { return null; }
}

/**
 * @typedef {{ code: number, out: string }} Ran
 * @typedef {{ child: import("node:child_process").ChildProcess, done: Promise<Ran>, output: () => string }} Running
 */

/**
 * Build both machines. JOURNEY_INSTALLER and JOURNEY_BOX_DIR may point at another installer and
 * box folder, to try the harness against a branch's copies without touching this tree.
 * @param {{ mac?: "running"|"signed-out" }} [o]
 */
export async function makeRig(o = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vyre-journey-")));
  const d = (...p) => path.join(root, ...p);
  for (const dir of ["mac/.vyre", "srv/host", "srv/bin", "srv/home/.vyre", "fakes", "state/forwards", "mirror"]) fs.mkdirSync(d(dir), { recursive: true });
  const onboardPort = await freePort(), tailnetPort = await freePort();
  const installer = process.env.JOURNEY_INSTALLER || path.join(REPO, "scripts", "install-box.sh");
  const boxDir = process.env.JOURNEY_BOX_DIR || path.join(REPO, "box");

  // what vyre.run/box/ serves: the box folder's files and their checksums
  const sums = [];
  for (const f of fs.readdirSync(boxDir)) {
    if (!fs.statSync(path.join(boxDir, f)).isFile()) continue;
    fs.copyFileSync(path.join(boxDir, f), d("mirror", f));
    sums.push(`${sha256(d("mirror", f))}  ${f}`);
  }
  fs.writeFileSync(d("mirror", "SHA256SUMS"), sums.join("\n") + "\n");

  // fakes: the Mac's ssh, open and tailscale; the box's tailscale and claude; the server's PATH
  shim(d("fakes", "ssh"), "ssh.mjs");
  shim(d("fakes", "tailscale-mac"), "tailscale.mjs", "mac");
  shim(d("fakes", "tailscale-box"), "tailscale.mjs", "box");
  exe(d("fakes", "open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${d("state", "opened")}"\n`);
  exe(d("fakes", "claude"), CLAUDE);
  shim(d("srv", "fakebin", "docker"), "docker.mjs");
  exe(d("srv", "fakebin", "sudo"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -n|-E|-H|--) shift ;; -u) shift 2 ;; *) break ;; esac; done\nexec "$@"\n`);
  exe(d("srv", "fakebin", "uname"), `#!/bin/sh\necho Linux\n`);
  exe(d("srv", "fakebin", "id"), `#!/bin/sh\ncase "$1" in -u) echo 1000 ;; -un|-nu) echo alex ;; -gn|-ng) echo alex ;; -nG|-Gn) echo alex ;; -g) echo 1000 ;; *) echo "uid=1000(alex) gid=1000(alex)" ;; esac\n`);

  const cert = makeCert(d("state"));
  const py = python3Dir();
  const rig = {
    root, repo: REPO, here: HERE, forwards: d("state", "forwards"),
    log: { ssh: d("state", "ssh.log"), docker: d("state", "docker.log"), tailscale: d("state", "tailscale.log") },
    state: { box: d("state", "box-tailscale.json"), mac: d("state", "mac-tailscale.json"), opened: d("state", "opened") },
    cert,
    server: { env: {
      HOME: d("srv", "host"), PATH: `${d("srv", "bin")}:${d("srv", "fakebin")}:${SYSTEM_PATH}`, VYRE_DIR: d("srv", "vyre"),
      VYRE_WRAPPER: d("srv", "bin", "vyre"), VYRE_TUN: "/dev/null", VYRE_BOX_URL: `file://${d("mirror")}/`, SSH_CONNECTION,
      JOURNEY_RIG: d("rig.json"), LANG: "C",
    } },
    container: { env: {
      HOME: d("srv", "home"), VYRE_HOME: d("srv", "home", ".vyre"), VYRE_SUPERVISOR: "docker", VYRE_ONBOARD_HOST: "::1",
      VYRE_TAILSCALE_BIN: d("fakes", "tailscale-box"), VYRE_CLAUDE_BIN: d("fakes", "claude"), NO_COLOR: "1",
      PATH: [path.dirname(NODE), SYSTEM_PATH, py].filter(Boolean).join(":"), JOURNEY_RIG: d("rig.json"),
    } },
    mac: { env: {
      HOME: d("mac"), VYRE_HOME: d("mac", ".vyre"), PATH: `${path.dirname(NODE)}:${SYSTEM_PATH}`, NO_COLOR: "1",
      VYRE_TAILSCALE_BIN: d("fakes", "tailscale-mac"), VYRE_SSH_BIN: d("fakes", "ssh"), VYRE_OPEN_BIN: d("fakes", "open"),
      VYRE_BOX_POLL_MS: "250", JOURNEY_RIG: d("rig.json"),
      ...(process.env.JOURNEY_INSTALLER ? { VYRE_BOX_INSTALLER: installer } : {}),
    } },
  };
  fs.writeFileSync(d("rig.json"), JSON.stringify(rig, null, 2));
  for (const f of Object.values(rig.log)) fs.writeFileSync(f, "");
  fs.writeFileSync(rig.state.box, JSON.stringify(BOX_FRESH));
  fs.writeFileSync(rig.state.mac, JSON.stringify({ mode: o.mac || "running" }));
  const base = { transcripts: [], roots: [], vault: { keystore: "file" } };
  fs.writeFileSync(d("mac", ".vyre", "config.json"), JSON.stringify({ ...base, role: "local", projectsDir: d("mac", "projects") }));
  fs.writeFileSync(d("srv", "home", ".vyre", "config.json"), JSON.stringify({ ...base, role: "box", projectsDir: d("srv", "home", "projects"),
    network: { onboardPort, port: tailnetPort } }));

  /** Spawn with a hard timeout; output is stdout and stderr together. */
  function spawnOne(cmd, args, env, { timeout = 60_000, cwd = env.HOME } = {}) {
    const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", c => { out += c; });
    child.stderr?.on("data", c => { out += c; });
    const timer = setTimeout(() => { out += `\n[journey: killed after ${timeout} ms]`; child.kill("SIGKILL"); }, timeout);
    const done = new Promise(res => child.on("close", code => { clearTimeout(timer); res({ code: code ?? 1, out }); }));
    return { child, done: /** @type {Promise<Ran>} */ (done), output: () => out };
  }

  const read = f => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

  return {
    ...rig, onboardPort, tailnetPort, installer, python3: py,
    env: { mac: rig.mac.env, server: rig.server.env, container: rig.container.env },
    /** `vyre <args>` on the Mac, no terminal. */
    mac: (args, opts) => spawnOne(NODE, [BIN, ...args], rig.mac.env, opts),
    /** A shell command on the server, as its account, in its home. */
    server: (cmd, opts) => spawnOne("/bin/sh", ["-c", cmd], rig.server.env, opts),
    ssh: () => read(rig.log.ssh).split("\n").filter(Boolean),
    docker: () => read(rig.log.docker).split("\n").filter(Boolean),
    opened: () => read(rig.state.opened).split("\n").filter(Boolean),
    macConfig: () => readJson(d("mac", ".vyre", "config.json")),
    boxConfig: () => readJson(d("srv", "home", ".vyre", "config.json")),
    macTailscale: mode => fs.writeFileSync(rig.state.mac, JSON.stringify({ mode })),
    /** The person finished Tailscale's sign-in in the browser. */
    boxSignedIn: () => fs.writeFileSync(rig.state.box, JSON.stringify(BOX_RUNNING)),

    /** Stop every vyred and relay this rig started, then remove both machines. */
    async close() {
      const pids = [];
      for (const f of [d("srv", "home", ".vyre", "vyred.pid"), d("mac", ".vyre", "vyred.pid")]) pids.push(Number(read(f)));
      for (const f of fs.readdirSync(rig.forwards)) if (f.endsWith(".pid")) pids.push(Number(read(path.join(rig.forwards, f))));
      const live = pids.filter(p => p && p !== process.pid);
      for (const p of live) { try { process.kill(p, "SIGTERM"); } catch {} }
      for (let i = 0; i < 60 && live.some(p => { try { process.kill(p, 0); return true; } catch { return false; } }); i++) await new Promise(r => setTimeout(r, 50));
      for (const p of live) { try { process.kill(p, "SIGKILL"); } catch {} }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Poll fn until check(value) holds; throws with the last value after ms. */
export async function until(fn, check, ms = 15_000, what = "a condition") {
  let last;
  for (const end = Date.now() + ms; Date.now() < end;) {
    last = await fn();
    if (check(last)) return last;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)?.slice(0, 600)}`);
}

/**
 * The browser: open the one-time link (through the Mac's forward), keep the session from the
 * redirect's fragment, and call onboarding tools with it the way the page does.
 * @param {string} url
 */
export async function browser(url) {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const location = r.headers.get("location") || "";
  const session = (location.match(/#s=([A-Za-z0-9_-]+)$/) || [])[1] || "";
  const base = new URL(url).origin;
  /** @returns {Promise<any>} the tool's data; throws with its error */
  async function tool(name, input = {}) {
    const res = await fetch(`${base}/v1/tools/${name}`, { method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", "x-vyre-onboard": session }, body: JSON.stringify(input) });
    const j = await res.json();
    if (j.error) throw new Error(`${name}: ${j.error.code}: ${j.error.message}`);
    return j.data;
  }
  return { status: r.status, location, session, tool };
}

/**
 * The browser once the address is served: the onboarding page moves to https://<ts.net name>
 * and the loopback link stops working (deck/onboard/onboard.js), since the Mac takes the tunnel
 * down as soon as the address step is done. The name does not resolve here, so this connects to
 * the fake tailnet's 127.0.0.1 and names the host the way the browser would.
 * @param {{ tailnetPort: number, cert: { crt: string } }} rig
 */
export function atAddress(rig) {
  const host = `${TS_NAME}:${rig.tailnetPort}`;
  const ca = fs.readFileSync(rig.cert.crt);
  /** @returns {Promise<any>} the tool's data; throws with its error */
  function tool(name, input = {}) {
    const body = JSON.stringify(input);
    return new Promise((resolve, reject) => {
      const req = https.request({ host: "127.0.0.1", port: rig.tailnetPort, servername: TS_NAME, ca, method: "POST", path: `/v1/tools/${name}`, timeout: 20_000,
        headers: { host, origin: `https://${host}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", c => { text += c; });
        res.on("end", () => {
          try {
            const j = JSON.parse(text);
            if (j.error) reject(new Error(`${name}: ${j.error.code}: ${j.error.message}`)); else resolve(j.data);
          } catch { reject(new Error(`${name}: ${res.statusCode} ${text.slice(0, 200)}`)); }
        });
      });
      req.on("timeout", () => req.destroy(new Error(`${name}: timed out`)));
      req.on("error", reject);
      req.end(body);
    });
  }
  return { tool };
}
