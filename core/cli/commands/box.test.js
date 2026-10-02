// @ts-check
// `vyre server` end to end against fakes: an ssh that runs the "remote" command here, a remote PATH
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
import box, { add, move, parsePreflight, parseLink, plan, unfit, settled, newer, needsGroup, viaTailnet } from "./box.js";
import { parse as parseTailnet } from "../tailnet.js";
import { VERSION } from "../../daemon/index.js";

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
export FAKE_TARGET="$1"
shift
[ -n "$op" ] && exit 0
# A target named in FAKE_SSH_REFUSE turns every login away, as a Tailscale SSH policy would.
if [ -n "\${FAKE_SSH_REFUSE:-}" ] && [ "$FAKE_TARGET" = "$FAKE_SSH_REFUSE" ]; then echo "tailscale: access denied by policy" >&2; exit 255; fi
exec sh -c "$*"
`;

// Docker on the "server": logs each call with the ssh target, streams a line of "data" for a
// volume tar, and fails a volume named in the server's missing or fail files.
const FAKE_DOCKER = `#!/bin/sh
echo "\${FAKE_TARGET:-} $*" >> "$FAKE_BOX/docker.log"
case "$1 $2" in
  "compose version") echo 2.29.1; exit 0 ;;
  "volume inspect") grep -qx "$3" "$FAKE_BOX/missing" 2>/dev/null && exit 1; exit 0 ;;
  "volume ls") cat "$FAKE_BOX/volumes" 2>/dev/null; exit 0 ;;
esac
if [ "$1" = run ]; then
  v=""
  for w in "$@"; do case "$w" in vyre_*) v=\${w%%:*} ;; esac; done
  case "$*" in
    *czf*) grep -qx "$v" "$FAKE_BOX/fail" 2>/dev/null && { echo "tar: read error on $v" >&2; exit 2; }
           echo "data $v"; exit 0 ;;
    *xzf*) cat >/dev/null; exit 0 ;;
  esac
fi
exit 0
`;

// The server's vyre: canned `up` output, and onboard.status from status.1.json, status.2.json, ...
// one per call, repeating the last once they run out.
const FAKE_VYRE = `#!/bin/sh
echo "$*" >> "$FAKE_BOX/vyre.log"
case "$1" in
  up) cat "$FAKE_BOX/up.out" ;;
  call)
    [ "$2" = onboard.link ] && [ -f "$FAKE_BOX/link.json" ] && { cat "$FAKE_BOX/link.json"; exit 0; }
    # The server's passkeys: keys.json once (then keys.next.json takes its place), else one passkey.
    if [ "$2" = presence.keys ]; then
      if [ -f "$FAKE_BOX/keys.json" ]; then cat "$FAKE_BOX/keys.json"; [ -f "$FAKE_BOX/keys.next.json" ] && mv "$FAKE_BOX/keys.next.json" "$FAKE_BOX/keys.json"
      else echo '[{"kind":"passkey"}]'; fi
      exit 0
    fi
    n=$(( $(cat "$FAKE_BOX/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE_BOX/n"
    [ -f "$FAKE_BOX/status.$n.json" ] && cp "$FAKE_BOX/status.$n.json" "$FAKE_BOX/last.json"
    cat "$FAKE_BOX/last.json" ;;
  version) cat "$FAKE_BOX/version" 2>/dev/null || echo 0.0.1 ;;
  update) [ -f "$FAKE_BOX/update-fail" ] && { echo "the image pull failed"; exit 4; }; echo "pulled the new image" ;;
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
  exe("docker", FAKE_DOCKER);
  // With a sudo-password file, sudo -n fails as it does when sudo needs a password.
  exe("sudo", `#!/bin/sh\nif [ "$1" = -n ]; then [ -f "$FAKE_BOX/sudo-password" ] && exit 1; shift; fi\nexec "$@"\n`);
  // Not in the docker group, whatever this machine's account is in (the test box's is).
  exe("id", `#!/bin/sh\ncase "$1" in -nG|-Gn) echo staff ;; *) exec /usr/bin/id "$@" ;; esac\n`);
  exe("usermod", `#!/bin/sh\necho "$*" >> "$FAKE_BOX/usermod.log"\n`);
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
  const put = (f, text) => fs.writeFileSync(path.join(fb, f), text);
  return { home, root, fb, read, put, setStatuses, upOut: s => fs.writeFileSync(path.join(fb, "up.out"), s), stack: env.VYRE_DIR };
}

/** Run fn with console.log captured; resolves { code, text }. */
async function capture(fn) {
  const lines = [], log = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  try { return { code: await fn(), text: lines.join("\n") }; } finally { console.log = log; }
}

test("box: preflight lines parse, and the plan says what will change", () => {
  const p = parsePreflight("os=Linux\ndocker=none\nsudo=no\ntun=yes\nbox=no\ndistro=Ubuntu 24.04 LTS\ndir=/srv/vyre\n");
  assert.deepEqual(p, { os: "Linux", docker: null, sudo: "no", tun: true, box: false, distro: "Ubuntu 24.04 LTS", dir: "/srv/vyre", user: "", dockerGroup: false, volumes: [] });
  assert.equal(needsGroup(p), true, "sudo needs a password and the account is not in the docker group");
  assert.equal(needsGroup({ ...p, sudo: "yes" }), false);
  assert.equal(needsGroup({ ...p, dockerGroup: true }), false);
  assert.deepEqual(parsePreflight("volumes=vyre_vyre-home vyre_vyre-work \n").volumes, ["vyre_vyre-home", "vyre_vyre-work"]);
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
  assert.equal(settled(status(4)), true, "a server too old to say arrived: the address serving is enough");
  assert.equal(settled(status(4, { arrived: false })), false, "the page still needs the tunnel for Switch to");
  assert.equal(settled(status(4, { arrived: true })), true, "the owner reached the address");
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
  for (let i = 0; i < 250 && !r.read("opened"); i++) await new Promise(res => setTimeout(res, 20));
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

test("box add: a server already set up skips install and the browser, and finishes", async t => {
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

test("box add: a finished box pairs this Mac and asks for the approval in the Deck, never over SSH", async t => {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  r.setStatuses([status(6, { finished: true })]);
  const asked = [];
  const call = async (tool, input) => {
    asked.push(tool);
    if (tool === "link.status") return { data: { linked: asked.includes("link.pair"), pending: null } };
    if (tool === "link.pair") return { data: { code: "123-456", box: input.box } };
    return { error: { code: "no_such_tool", message: tool } };
  };
  const { code, text } = await capture(() => add("alex@203.0.113.9", { call }));
  assert.equal(code, 0, text);
  assert.deepEqual(asked, ["link.status", "link.pair", "link.status"]);
  assert.match(text, /this Mac is paired with/);
  assert.doesNotMatch(r.read("vyre.log"), /link approve/, "anything in the server's container could approve over SSH");
  assert.doesNotMatch(r.read("vyre.log"), /^up /m, "a finished box needs no link, tunnel or browser");
  assert.equal(r.read("opened"), "");
  assert.match(text, /Approve this Mac on your phone at \S+[\s\S]*Code: 123-456/);
});

test("box add: with no passkey yet, the enrollment link opens before pairing", async t => {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  r.setStatuses([status(6, { finished: true })]);
  const passkeyUrl = `${ADDRESS}/onboard/passkey#e=abcd1234`;
  fs.writeFileSync(path.join(r.root, "box", "link.json"), JSON.stringify({ url: null, address: ADDRESS, passkeyUrl }));
  const call = async (tool, input) => tool === "link.status" ? { data: { linked: false } } : tool === "link.pair" ? { data: { code: "123-456" } } : { error: { code: "no_such_tool", message: tool } };
  const { code, text } = await capture(() => add("alex@203.0.113.9", { call }));
  assert.equal(code, 0, text);
  for (let i = 0; i < 250 && !r.read("opened"); i++) await new Promise(res => setTimeout(res, 20));
  assert.equal(r.read("opened").trim(), passkeyUrl);
  assert.ok(text.indexOf("Make your passkey") < text.indexOf("Approve this Mac"), "the passkey comes first: it is what approves the Mac");
});

test("box add: onboarding finished without an address reopens the browser, says what is left, and pairs nothing", async t => {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  // Its address is still to set up, so the browser opens again, and the ending says what is left.
  const port = await freePort();
  r.upOut(JSON.stringify({ role: "box", url: `http://127.0.0.1:${port}/onboard?t=again`, port, ssh: null, address: null, box: null }) + "\n");
  r.setStatuses([status(3, { finished: true, steps: { ...steps(3), name: "skipped" } })]);
  const asked = [];
  const { code, text } = await capture(() => add("alex@203.0.113.9", { call: async tool => { asked.push(tool); return { data: {} }; } }));
  assert.equal(code, 0, text);
  assert.deepEqual(asked, []);
  assert.match(text, /your server has no address yet/);
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

test("box remove --yes: uninstalls on the server and forgets the server", async t => {
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

const OLD = "alex@203.0.113.9", NEW = "alex@203.0.113.10";
const ssh = r => fs.readFileSync(path.join(r.root, "ssh.log"), "utf8");

test("box: a target ssh would read as an option never reaches ssh", async t => {
  const r = rig(t);
  const { code } = await capture(() => add("-oProxyCommand=touch /tmp/pwned@203.0.113.9", { yes: true }));
  assert.equal(code, 1);
  assert.equal(fs.existsSync(path.join(r.root, "ssh.log")), false);
});

test("box add: sudo with a password adds the account to the docker group in the same session, then reconnects", async t => {
  const r = rig(t);
  r.put("sudo-password", "");
  const user = (await import("node:os")).userInfo().username;
  r.setStatuses([status(6, { finished: true })]);
  const { code, text } = await capture(() => add(OLD, { yes: true, call: async () => ({ error: { code: "no_such_tool", message: "" } }) }));
  assert.equal(code, 0, text);
  assert.match(text, new RegExp(`add ${user} to the docker group \\(root-equivalent on this server; lets Vyre manage the stack without your password\\)`));
  assert.match(ssh(r), /sh \/\S+ --yes && sudo usermod -aG docker "\$\(id -un\)"/);
  assert.match(r.read("usermod.log"), new RegExp(`^-aG docker ${user}$`, "m"));
  assert.equal(ssh(r).match(/ControlMaster=auto/g)?.length, 2, "the master is opened again so the group applies");
});

test("box add: the wait gives up when the link expires, and says how to carry on", async t => {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  const port = await freePort();
  r.upOut(JSON.stringify({ url: `http://127.0.0.1:${port}/onboard?t=x`, port, address: null }));
  r.setStatuses([status(1)]);
  process.env.VYRE_BOX_WAIT_MS = "100";
  t.after(() => { delete process.env.VYRE_BOX_WAIT_MS; });
  const { code, text } = await capture(() => add(OLD));
  assert.equal(code, 1);
  assert.match(text, /setup link has expired/);
  assert.match(text, /run vyre server add alex@203\.0\.113\.9 again to carry on/);
});

test("box update: runs vyre update on the saved box and compares versions; a failed update and no box are exit 1", async t => {
  const r = rig(t);
  const run = /** @type {any} */ (box[0]).run;
  const none = await capture(() => run(["update"]));
  assert.equal(none.code, 1);
  assert.match(none.text, /no server yet: vyre server add <user@host>/);
  assert.equal(r.read("vyre.log"), "", "nothing ran without a server");

  config.save({ box: { ssh: OLD } });
  r.put("version", VERSION + "\n");
  const same = await capture(() => run(["update"]));
  assert.equal(same.code, 0, same.text);
  assert.match(same.text, /pulled the new image/);
  assert.ok(same.text.includes(`the server and this Mac both run ${VERSION}`), same.text);
  assert.deepEqual(r.read("vyre.log").trim().split("\n"), ["update", "version"]);

  r.put("version", "0.0.0\n");
  const older = await capture(() => run(["update"]));
  assert.equal(older.code, 0, older.text);
  assert.match(older.text, /the server runs 0\.0\.0, older than this Mac's .*; its next image catches up/);
  assert.match(ssh(r), new RegExp(OLD.replace(/\./g, "\\.")), "it went to the saved target");

  r.put("version", "99.0.0\n");
  const newer = await capture(() => run(["update"]));
  assert.equal(newer.code, 0, newer.text);
  assert.match(newer.text, /the server runs 99\.0\.0, newer than this Mac's .*&& vyre up/);

  r.put("update-fail", "");
  const failed = await capture(() => run(["update"]));
  assert.equal(failed.code, 1, failed.text);
  assert.match(failed.text, /the image pull failed/);
  assert.match(failed.text, /vyre update on the server stopped \(exit 4\)/);
  assert.doesNotMatch(failed.text, /the server runs/, "no version compare after a failed update");
});

test("box backup: writes through .partial at 0600, refuses to overwrite without --force", async t => {
  const r = rig(t);
  config.save({ box: { ssh: OLD } });
  const run = /** @type {any} */ (box[0]).run;
  const file = path.join(r.root, "b.tar.gz");
  const first = await capture(() => run(["backup", file]));
  assert.equal(first.code, 0, first.text);
  assert.match(fs.readFileSync(file, "utf8"), /data vyre_tailscale-state/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(file + ".partial"), false);
  const log = ssh(r);
  assert.ok(log.indexOf("trap") < log.indexOf("docker compose stop"), "the restart is armed before the stack stops");
  assert.match(log, /EXIT/);
  assert.match(log, /HUP INT TERM/);

  const again = await capture(() => run(["backup", file]));
  assert.equal(again.code, 1);
  assert.match(again.text, /exists; pick another file, or add --force/);
  assert.equal((await capture(() => run(["backup", file, "--force"]))).code, 0);
});

test("box backup: a missing volume fails before the stack stops", async t => {
  const r = rig(t);
  config.save({ box: { ssh: OLD } });
  r.put("missing", "vyre_vyre-work\n");
  const file = path.join(r.root, "b.tar.gz");
  const { code, text } = await capture(() => /** @type {any} */ (box[0]).run(["backup", file]));
  assert.equal(code, 1);
  assert.match(text, /vyre_vyre-work is missing/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(file + ".partial"), false);
  assert.doesNotMatch(r.read("docker.log"), /compose stop/);
});

/** A saved box on OLD, and the new server's vyre up answering with the same address. */
function moving(t) {
  const r = rig(t);
  config.save({ box: { ssh: OLD }, network: { box: ADDRESS } });
  r.upOut(JSON.stringify({ role: "box", url: null, port: 7300, address: ADDRESS }));
  process.env.VYRE_BOX_PROBE_MS = "0";
  t.after(() => { delete process.env.VYRE_BOX_PROBE_MS; });
  return r;
}

test("box move: carries the volumes, checks the new box answers, then takes the old one off", async t => {
  const r = moving(t);
  const { code, text } = await capture(() => move(NEW, { yes: true }, { probe: async () => ({ version: "0.0.1" }) }));
  assert.equal(code, 0, text);
  const inst = r.read("installer.log");
  assert.match(inst, /^--yes$/m);
  assert.match(inst, /^no-up$/m, "VYRE_NO_UP reaches the installer");
  assert.match(inst, /^--yes --uninstall$/m);
  assert.doesNotMatch(inst, /--purge/);
  const dk = r.read("docker.log");
  assert.ok(dk.indexOf(`${NEW} compose down -v`) >= 0 && dk.indexOf(`${NEW} compose down -v`) < dk.indexOf(`${OLD} compose stop`), "the fresh stack is down before any volume moves");
  for (const v of ["vyre-home", "vyre-work", "tailscale-state"]) assert.match(text, new RegExp(`${v}\\s+moved`));
  assert.equal(/** @type {any} */ (config.load()).box.ssh, NEW);
});

test("box move: a new box that does not answer is stopped and the old one started again", async t => {
  const r = moving(t);
  const { code, text } = await capture(() => move(NEW, { yes: true }, { probe: async () => null }));
  assert.equal(code, 1);
  assert.match(text, /did not answer from this Mac/);
  const dk = r.read("docker.log");
  assert.match(dk, new RegExp(`${NEW.replace(/\./g, "\\.")} compose stop`));
  assert.ok(dk.lastIndexOf(`${OLD} compose start`) > dk.indexOf(`${OLD} compose stop`));
  assert.match(text, /running again on alex@203\.0\.113\.9, as it was/);
  assert.doesNotMatch(r.read("installer.log"), /--uninstall/);
  assert.equal(/** @type {any} */ (config.load()).box.ssh, OLD);
});

test("box move: a failed copy starts the old box again and says which side failed", async t => {
  const r = moving(t);
  r.put("fail", "vyre_vyre-work\n");
  const { code, text } = await capture(() => move(NEW, { yes: true }, { probe: async () => ({}) }));
  assert.equal(code, 1);
  assert.match(text, /copying vyre-work failed \(old: tar: read error on vyre_vyre-work\)/);
  assert.match(r.read("docker.log"), new RegExp(`${OLD} compose start`));
  assert.match(text, /running again on/);
  assert.equal(/** @type {any} */ (config.load()).box.ssh, OLD);
});

// ---- Tailscale SSH ----

const HOST_KEYS = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleOnlyNotARealKey"];
/** A tailnet whose peer "box" is at 100.64.0.5, with Tailscale SSH unless told otherwise. */
const withPeer = (peer = {}) => ({ ...TAILNET, Peer: { n1: { HostName: "box", DNSName: "box.tail0000.ts.net.", TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
  Online: true, UserID: 7, OS: "linux", sshHostKeys: HOST_KEYS, ...peer } } });
const tailscaleSays = (r, s) => fs.writeFileSync(path.join(r.root, "bin", "tailscale"), `#!/bin/sh\ncat <<'J'\n${JSON.stringify(s)}\nJ\n`, { mode: 0o755 });
const TS_TARGET = "alex@box.tail0000.ts.net";
/** Masters opened, by target, in order. */
const masters = r => ssh(r).split("\n").filter(l => l.includes("ControlMaster=auto")).map(l => l.trim().split(" ").slice(-2)[0]);

test("box: viaTailnet names the MagicDNS name only for an online peer that runs Tailscale SSH", () => {
  const t = parseTailnet(withPeer());
  assert.equal(t.peers[0].ssh, true, "sshHostKeys present");
  for (const host of ["box", "box.tail0000.ts.net", "BOX.tail0000.ts.net.", "100.64.0.5", "fd7a:115c:a1e0::5"]) assert.equal(viaTailnet(`alex@${host}`, t), TS_TARGET, host);
  assert.equal(viaTailnet("alex@203.0.113.9", t), null, "not on the tailnet");
  assert.equal(viaTailnet("alex@box", parseTailnet(withPeer({ sshHostKeys: undefined }))), null, "no Tailscale SSH");
  assert.equal(parseTailnet(withPeer({ sshHostKeys: [] })).peers[0].ssh, false);
  assert.equal(viaTailnet("alex@box", parseTailnet(withPeer({ Online: false }))), null, "offline");
  const two = { ...TAILNET, Peer: { ...withPeer().Peer, n2: { ...withPeer().Peer.n1, DNSName: "box-1.tail0000.ts.net.", TailscaleIPs: ["100.64.0.6"] } } };
  assert.equal(viaTailnet("alex@box", parseTailnet(two)), TS_TARGET, "the first label of a MagicDNS name wins over a shared HostName");
  const shared = { ...TAILNET, Peer: { a: { ...withPeer().Peer.n1, DNSName: "box-1.tail0000.ts.net." }, b: { ...withPeer().Peer.n1, DNSName: "box-2.tail0000.ts.net." } } };
  assert.equal(viaTailnet("alex@box", parseTailnet(shared)), null, "a HostName two peers share names neither");
});

/** A box already set up and finished, so add goes straight from reaching it to the ending. */
function finishedBox(t) {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  r.setStatuses([status(6, { finished: true })]);
  return r;
}
const noPair = { call: async () => ({ error: { code: "no_such_tool", message: "" } }) };

test("box add: a host on the tailnet with Tailscale SSH is reached by its MagicDNS name, which is saved", async t => {
  const r = finishedBox(t);
  tailscaleSays(r, withPeer());
  const { code, text } = await capture(() => add("alex@100.64.0.5", noPair));
  assert.equal(code, 0, text);
  assert.match(text, /reaching alex@box\.tail0000\.ts\.net over Tailscale SSH/);
  assert.deepEqual(masters(r), [TS_TARGET], "one master, to the tailnet name");
  assert.equal(/** @type {any} */ (config.load()).box.ssh, TS_TARGET);
});

test("box add: when Tailscale SSH turns the Mac away, it falls back to the target as typed and saves that", async t => {
  const r = finishedBox(t);
  tailscaleSays(r, withPeer());
  process.env.FAKE_SSH_REFUSE = TS_TARGET;
  t.after(() => { delete process.env.FAKE_SSH_REFUSE; });
  const { code, text } = await capture(() => add("alex@box", noPair));
  assert.equal(code, 0, text);
  assert.match(text, /Tailscale SSH did not let this Mac in \(tailscale: access denied by policy\); trying alex@box as typed/);
  assert.deepEqual(masters(r), [TS_TARGET, "alex@box"]);
  assert.equal(/** @type {any} */ (config.load()).box.ssh, "alex@box");
});

test("box add: a host not on the tailnet, or a peer without Tailscale SSH, is reached as typed", async t => {
  for (const [target, s] of [["alex@203.0.113.9", withPeer()], ["alex@box", withPeer({ sshHostKeys: undefined })]]) {
    const r = finishedBox(t);
    tailscaleSays(r, s);
    const { code, text } = await capture(() => add(target, noPair));
    assert.equal(code, 0, text);
    assert.doesNotMatch(text, /Tailscale SSH/);
    assert.deepEqual(masters(r), [target]);
    assert.equal(/** @type {any} */ (config.load()).box.ssh, target);
  }
});

test("box move: a new server on the tailnet with Tailscale SSH is reached and saved by its MagicDNS name", async t => {
  const r = moving(t);
  tailscaleSays(r, withPeer());
  const { code, text } = await capture(() => move("alex@box", { yes: true }, { probe: async () => ({}) }));
  assert.equal(code, 0, text);
  assert.match(text, /reaching alex@box\.tail0000\.ts\.net over Tailscale SSH/);
  assert.deepEqual(masters(r).slice(0, 2), [OLD, TS_TARGET], "the old box as saved, the new one over the tailnet");
  assert.equal(/** @type {any} */ (config.load()).box.ssh, TS_TARGET);
});

test("box add: after the switch, the code waits for the passkey, and an expired code is replaced", async t => {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  // The owner switched to the address (arrived) and is making the passkey there: none yet.
  r.setStatuses([status(6, { finished: true, arrived: true })]);
  fs.writeFileSync(path.join(r.root, "box", "link.json"), JSON.stringify({ url: null, address: ADDRESS, passkeyUrl: `${ADDRESS}/onboard/passkey#e=x` }));
  r.put("keys.json", "[]");
  r.put("keys.next.json", '[{"kind":"passkey"}]');
  const asked = [];
  const codes = ["123-456", "654-321"];
  let statuses = 0;
  const call = async (tool) => {
    asked.push(tool);
    if (tool === "link.pair") return { data: { code: codes.shift() } };
    if (tool === "link.status") {
      statuses++;
      // First look: not paired. Then the first code expires unapproved; the second is approved.
      if (statuses === 1) return { data: { linked: false, pending: null } };
      if (statuses === 2) return { data: { linked: false, pending: null, error: "the pairing code expired; start again" } };
      return { data: { linked: true, pending: null } };
    }
    return { error: { code: "no_such_tool", message: tool } };
  };
  const { code, text } = await capture(() => add("alex@203.0.113.9", { call }));
  assert.equal(code, 0, text);
  assert.equal(r.read("opened"), "", "no second passkey tab: the page took the owner there");
  assert.match(text, /waiting for your passkey at https:\/\/vyre\.tail0000\.ts\.net/);
  assert.ok(text.indexOf("waiting for your passkey") < text.indexOf("Code: 123-456"), "the code is made only once a passkey exists");
  assert.match(text, /That code expired\. The new one: 654-321/);
  assert.match(text, /this Mac is paired with/);
  assert.deepEqual(asked.filter(x => x === "link.pair").length, 2);
});

test("box: vyre commands lists every verb run() handles, with its arguments and flags", async () => {
  const { listing } = await import("./commands.js");
  const verbs = (await listing({ only: "box" })).commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["status", "add", "update", "backup", "move", "remove"]);
  assert.deepEqual(verbs.find(v => v.verb === "add").args, [{ name: "user@host", required: true }]);
  assert.deepEqual(verbs.find(v => v.verb === "remove").flags.map(f => f.name), ["purge", "yes"]);
  assert.deepEqual(verbs.filter(v => v.read).map(v => v.verb), ["status"]);
});

test("box --view: a plan that wants a yes is a prompt frame to run again with --yes, exit 2, and nothing changes", async t => {
  const r = rig(t);
  config.save({ box: { ssh: "alex@203.0.113.9" }, network: { box: ADDRESS } });
  const { setView } = await import("../kit.js");
  const lines = [];
  const write = process.stdout.write;
  t.after(() => { process.stdout.write = write; setView(null); });
  process.stdout.write = /** @type {any} */ (chunk => { lines.push(String(chunk)); return true; });
  setView("box remove");
  const { code } = await capture(() => /** @type {any} */ (box[0]).run(["remove", "--purge", "--json"]));
  setView(null);
  process.stdout.write = write;
  assert.equal(code, 2);
  const f = lines.join("").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(f[0].view.kind, "prompt");
  assert.deepEqual([f[0].view.name, f[0].view.choices, f[0].view.args], ["yes", ["yes", "no"], ["server", "remove", "--purge", "--yes"]]);
  assert.match(f[0].view.label, /stop the stack.*Go ahead\?$/);
  assert.equal(f[0].data.question, "Go ahead?");
  assert.equal(r.read("installer.log"), "", "nothing ran on the server");
  assert.equal(/** @type {any} */ (config.load()).box.ssh, "alex@203.0.113.9", "the server is still remembered");
});
