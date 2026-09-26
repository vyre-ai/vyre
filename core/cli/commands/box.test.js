// @ts-check
// `vyre box` end to end against fakes: an ssh that runs the "remote" command here, a remote PATH
// with fake uname, docker, sudo and vyre, a fake Tailscale on the Mac and a fake browser. Nothing
// real is reached: no server, no Docker, no Tailscale.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { tempHome } from "../../../test/helpers.js";
import * as config from "../../config/index.js";
import { ending } from "../ending.js";
import box, { add, parsePreflight, parseLink, plan, unfit, settled, newer } from "./box.js";

const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"
op=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -O) op=$2; shift 2 ;;
    -L) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
[ -n "$op" ] && exit 0
exec sh -c "$*"
`;

// The box's vyre: canned `up` output, and onboard.status from status.1.json, status.2.json, ...
// one per call, repeating the last once they run out.
const FAKE_VYRE = `#!/bin/sh
echo "$*" >> "$FAKE_BOX/vyre.log"
case "$1" in
  up) cat "$FAKE_BOX/up.out" ;;
  call)
    n=$(( $(cat "$FAKE_BOX/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE_BOX/n"
    [ -f "$FAKE_BOX/status.$n.json" ] && cp "$FAKE_BOX/status.$n.json" "$FAKE_BOX/last.json"
    cat "$FAKE_BOX/last.json" ;;
  version) echo 0.0.1 ;;
esac
`;

const TAILNET = { BackendState: "Running", Self: { HostName: "laptop", DNSName: "laptop.tail0000.ts.net.", UserID: 7 }, User: { 7: { LoginName: "alex@example.com" } }, Peer: {} };
const ADDRESS = "https://vyre.tail0000.ts.net";
const steps = (done) => Object.fromEntries(["you", "claude", "tailscale", "name", "history", "devices"].map((k, i) => [k, i < done ? "done" : "todo"]));
const status = (done, extra = {}) => ({ address: done >= 4 ? ADDRESS : null, owner: "alex@example.com", assistant: "Juno", finished: false, steps: steps(done), ...extra });

function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {net.AddressInfo} */ (s.address()).port; s.close(() => res(p)); }); });
}

/** A temp Mac home and a temp "server" in one folder, with every fake on PATH. */
function rig(t) {
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ role: "local", transcripts: [], roots: [], projectsDir: path.join(home, "projects"), vault: { keystore: "file" } }));
  const root = fs.mkdtempSync(path.join(home, "rig-"));
  const bin = path.join(root, "bin"), fb = path.join(root, "box");
  fs.mkdirSync(bin); fs.mkdirSync(fb);
  const exe = (name, body) => fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  exe("ssh", FAKE_SSH);
  exe("vyre", FAKE_VYRE);
  exe("tailscale", `#!/bin/sh\ncat <<'J'\n${JSON.stringify(TAILNET)}\nJ\n`);
  exe("uname", "#!/bin/sh\necho Linux\n");
  exe("docker", `#!/bin/sh\n[ "$1 $2" = "compose version" ] && { echo 2.29.1; exit 0; }\nexit 0\n`);
  exe("sudo", `#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n`);
  exe("open", `#!/bin/sh\necho "$1" >> "$FAKE_BOX/opened"\n`);
  exe("installer.sh", `#!/bin/sh\necho "$*" >> "$FAKE_BOX/installer.log"\nenv | grep -q '^VYRE_NO_UP=1' && echo no-up >> "$FAKE_BOX/installer.log"\nmkdir -p "$VYRE_DIR" && touch "$VYRE_DIR/compose.yml"\necho installed\n`);
  const env = {
    PATH: `${bin}:${process.env.PATH}`, VYRE_SSH_BIN: path.join(bin, "ssh"), FAKE_SSH_LOG: path.join(root, "ssh.log"),
    VYRE_TAILSCALE_BIN: path.join(bin, "tailscale"), VYRE_OPEN_BIN: path.join(bin, "open"), VYRE_BOX_INSTALLER: path.join(bin, "installer.sh"),
    VYRE_DIR: path.join(root, "srv", "vyre"), VYRE_TUN: "/dev/null", VYRE_BOX_POLL_MS: "20", FAKE_BOX: fb,
  };
  const prev = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const read = f => { try { return fs.readFileSync(path.join(fb, f), "utf8"); } catch { return ""; } };
  const setStatuses = list => list.forEach((s, i) => fs.writeFileSync(path.join(fb, `status.${i + 1}.json`), JSON.stringify(s, null, 2)));
  return { home, root, fb, read, setStatuses, upOut: s => fs.writeFileSync(path.join(fb, "up.out"), s), stack: env.VYRE_DIR };
}

/** Run fn with console.log captured; resolves { code, text }. */
async function capture(fn) {
  const lines = [], log = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  try { return { code: await fn(), text: lines.join("\n") }; } finally { console.log = log; }
}

test("box: preflight lines parse, and the plan says what will change", () => {
  const p = parsePreflight("os=Linux\ndocker=none\nsudo=no\ntun=yes\nbox=no\ndistro=Ubuntu 24.04 LTS\ndir=/srv/vyre\n");
  assert.deepEqual(p, { os: "Linux", docker: null, sudo: "no", tun: true, box: false, distro: "Ubuntu 24.04 LTS", dir: "/srv/vyre" });
  assert.match(plan(p).join("\n"), /install Docker with get\.docker\.com[\s\S]*create \/srv\/vyre[\s\S]*\/usr\/local\/bin\/vyre[\s\S]*sudo will ask/);
  assert.match(String(unfit({ ...p, os: "Darwin" })), /not Linux/);
  assert.match(String(unfit({ ...p, tun: false })), /\/dev\/net\/tun/);
  assert.equal(unfit(p), null);
  assert.equal(parsePreflight("os=Linux\ndocker=2.29.1\nsudo=root\n").docker, "2.29.1");
});

test("box: the link comes from --json, or from the text before --json exists", () => {
  const url = "http://127.0.0.1:7300/onboard?t=abc123";
  assert.deepEqual(parseLink(`note\n${JSON.stringify({ role: "box", url, port: 7300, address: null })}\n`), { url, port: 7300, address: null });
  assert.deepEqual(parseLink(JSON.stringify({ url: null, address: ADDRESS }, null, 2)), { url: null, port: null, address: ADDRESS });
  assert.deepEqual(parseLink(`\n  Open this link to set up Vyre (it works once, for an hour):\n\n    ${url}\n`), { url, port: 7300, address: null });
  assert.deepEqual(parseLink(`  your address: ${ADDRESS}\n`), { url: null, port: null, address: ADDRESS });
  assert.equal(parseLink("vyre: no box in /srv/vyre"), null);
  assert.equal(settled(status(3)), false);
  assert.equal(settled(status(4)), true, "the address serves: the Mac can take over");
  assert.equal(newer("0.2.0", "0.1.9"), 1);
  assert.equal(newer("0.1.0", "0.1.0"), 0);
});

test("box add: with no terminal and no --yes it shows the plan and changes nothing", async t => {
  const r = rig(t);
  const { code, text } = await capture(() => add("alex@203.0.113.9"));
  assert.equal(code, 1);
  assert.match(text, /Vyre will, on alex@203\.0\.113\.9/);
  assert.match(text, /use the Docker already there \(Compose 2\.29\.1\)/);
  assert.match(text, /nothing changed/);
  assert.equal(r.read("installer.log"), "", "the installer never ran");
  assert.equal(fs.existsSync(r.stack), false);
});

test("box add --yes: installs, opens the link, waits step by step, saves, and ends ready", async t => {
  const r = rig(t);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/onboard?t=tok`;
  r.upOut(JSON.stringify({ role: "box", url, port, ssh: null, address: null, box: true }) + "\n");
  r.setStatuses([status(0), status(2), status(3, { steps: { ...steps(3), history: "skipped" } }), status(6, { finished: true })]);
  const { code, text } = await capture(() => add("alex@203.0.113.9", { yes: true }));
  assert.equal(code, 0, text);

  assert.match(r.read("installer.log"), /^--yes$/m, "the installer was copied over and run with --yes");
  const ssh = fs.readFileSync(path.join(r.root, "ssh.log"), "utf8");
  assert.match(ssh, /sh \/\S+ --yes/);
  assert.match(ssh, new RegExp(`-O forward -L ${port}:127\\.0\\.0\\.1:${port}`));
  assert.match(ssh, /-O cancel/);
  for (let i = 0; i < 50 && !r.read("opened"); i++) await new Promise(res => setTimeout(res, 20));
  assert.equal(r.read("opened").trim(), url, "the browser is opened detached, so give it a moment");
  assert.match(text, /Finish in your browser\. I'll wait here\./);
  for (const label of ["You", "Claude Code", "Tailscale", "Your address", "Your devices"]) assert.match(text, new RegExp(`${label}\\s+done`));
  assert.match(text, /Your history\s+skipped/);
  assert.equal(text.match(/Claude Code\s+done/g)?.length, 1, "each step is said once");
  assert.ok(text.includes(ending({ address: ADDRESS, assistant: "Juno" }).join("\n")), text);

  const c = /** @type {any} */ (config.load());
  assert.equal(c.box.ssh, "alex@203.0.113.9");
  assert.equal(c.network.box, ADDRESS);
});

test("box add: a box already set up skips install and the browser, and finishes", async t => {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  r.upOut(`  vyred is already running\n  your address: ${ADDRESS}\n`);
  r.setStatuses([status(6, { finished: true })]);
  const { code, text } = await capture(() => add("alex@203.0.113.9"));
  assert.equal(code, 0, text);
  assert.match(text, /already on alex@203\.0\.113\.9/);
  assert.equal(r.read("installer.log"), "");
  assert.equal(r.read("opened"), "");
  assert.match(text, /Vyre is ready\./);
  assert.equal(config.load().network.box, ADDRESS);
});

test("box add: the Mac's pairing code is approved on the box over SSH, so nobody types it", async t => {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  r.setStatuses([status(6, { finished: true })]);
  const asked = [];
  const call = async (tool, input) => {
    asked.push(tool);
    if (tool === "link.status") return { data: { linked: false, pending: null } };
    if (tool === "link.pair") return { data: { code: "123-456", box: input.box } };
    return { error: { code: "no_such_tool", message: tool } };
  };
  const { code, text } = await capture(() => add("alex@203.0.113.9", { call }));
  assert.equal(code, 0, text);
  assert.deepEqual(asked, ["link.status", "link.pair"]);
  assert.match(r.read("vyre.log"), /^link approve 123-456$/m);
  assert.doesNotMatch(r.read("vyre.log"), /^up /m, "a finished box needs no link, tunnel or browser");
  assert.equal(r.read("opened"), "");
  assert.match(text, /paired/);
});

test("box add: onboarding finished without an address says what is left, and pairs nothing", async t => {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  r.setStatuses([status(3, { finished: true, steps: { ...steps(3), name: "skipped" } })]);
  const asked = [];
  const { code, text } = await capture(() => add("alex@203.0.113.9", { call: async tool => { asked.push(tool); return { data: {} }; } }));
  assert.equal(code, 0, text);
  assert.deepEqual(asked, []);
  assert.match(text, /your box has no address yet/);
  assert.match(text, /Almost there/);
  assert.doesNotMatch(text, /Vyre is ready/);
  assert.equal(/** @type {any} */ (config.load()).box.ssh, "alex@203.0.113.9");
});

test("box add: a taken local port stops it and names the port", async t => {
  const r = rig(t);
  const srv = net.createServer();
  await new Promise(res => srv.listen(0, "127.0.0.1", () => res(null)));
  t.after(() => srv.close());
  const port = /** @type {net.AddressInfo} */ (srv.address()).port;
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  r.upOut(JSON.stringify({ url: `http://127.0.0.1:${port}/onboard?t=x`, port, address: null }));
  const { code, text } = await capture(() => add("alex@203.0.113.9"));
  assert.equal(code, 1);
  assert.match(text, new RegExp(`port ${port} on this computer is taken`));
  assert.equal(r.read("opened"), "");
});

test("box add: a signed-out Mac stops before touching the server", async t => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.root, "bin", "tailscale"), `#!/bin/sh\necho '{"BackendState":"NeedsLogin"}'\n`, { mode: 0o755 });
  const { code, text } = await capture(() => add("alex@203.0.113.9", { yes: true }));
  assert.equal(code, 1);
  assert.match(text, /open Tailscale and sign in/);
  assert.equal(fs.existsSync(path.join(r.root, "ssh.log")), false);
});

test("box remove --yes: uninstalls on the server and forgets the box", async t => {
  const r = rig(t);
  config.save({ box: { ssh: "alex@203.0.113.9" }, network: { box: ADDRESS } });
  const run = /** @type {any} */ (box[0]).run;
  const { code, text } = await capture(() => run(["remove", "--yes"]));
  assert.equal(code, 0, text);
  assert.match(r.read("installer.log"), /^--uninstall$/m);
  const c = /** @type {any} */ (config.load());
  assert.equal(c.box, undefined);
  assert.equal(c.network.box, undefined);
});
