// @ts-check
// `vyre box` end to end against fakes: an ssh that runs the "remote" command here, a remote PATH
// with fake uname, docker, sudo and vyre and a fake browser. Nothing
// real is reached: no server, no Docker.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { tempHome } from "../../../test/helpers.js";
import * as config from "../../config/index.js";
import box, { add, move, parsePreflight, plan, unfit, newer, needsGroup } from "./box.js";
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
# A target named in FAKE_SSH_REFUSE turns every login away.
if [ -n "\${FAKE_SSH_REFUSE:-}" ] && [ "$FAKE_TARGET" = "$FAKE_SSH_REFUSE" ]; then echo "access denied by policy" >&2; exit 255; fi
exec sh -c "$*"
`;

// Docker on the "server": logs each call with the ssh target, streams a line of "data" for a
// volume tar, and fails a volume named in the box's missing or fail files.
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

// The box's vyre: canned `up` output, and onboard.status from status.1.json, status.2.json, ...
// one per call, repeating the last once they run out.
const FAKE_VYRE = `#!/bin/sh
echo "$*" >> "$FAKE_BOX/vyre.log"
case "$1" in
  up) cat "$FAKE_BOX/up.out" ;;
  call)
    [ "$2" = wink.server.status ] && { cat "$FAKE_BOX/server.json" 2>/dev/null || echo '{"owned":false}'; exit 0; }
    [ "$2" = onboard.link ] && [ -f "$FAKE_BOX/link.json" ] && { cat "$FAKE_BOX/link.json"; exit 0; }
    # The box's passkeys: keys.json once (then keys.next.json takes its place), else one passkey.
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

const ADDRESS = "https://vyre.tail0000.ts.net";
const steps = (done) => Object.fromEntries(["you", "claude", "pair", "name", "history", "devices"].map((k, i) => [k, i < done ? "done" : "todo"]));
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
    VYRE_OPEN_BIN: path.join(bin, "open"), VYRE_BOX_INSTALLER: path.join(bin, "installer.sh"),
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
  assert.equal(unfit({ ...p, tun: false }), null, "no tunnel device is needed");
  assert.equal(unfit(p), null);
  assert.equal(parsePreflight("os=Linux\ndocker=2.29.1\nsudo=root\n").docker, "2.29.1");
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

const OLD = "alex@203.0.113.9", NEW = "alex@203.0.113.10";
const ssh = r => fs.readFileSync(path.join(r.root, "ssh.log"), "utf8");

test("box add --yes: installs, saves the box, and says it is not paired yet and how to pair it (no browser, no link)", async t => {
  const r = rig(t);
  const { code, text } = await capture(() => add("alex@203.0.113.9", { yes: true }));
  assert.equal(code, 0, text);
  assert.match(r.read("installer.log"), /^--yes --version \S+$/m, "the installer was copied over and run with --yes and the version");
  assert.match(text, /installed and not paired yet/);
  assert.match(text, /vyre call wink\.server\.code/);
  assert.equal(r.read("opened"), "", "no browser is opened: a server has no first-run page");
  assert.doesNotMatch(ssh(r), /-O forward/, "no tunnel to a loopback page");
  assert.equal(/** @type {any} */ (config.load()).box.ssh, "alex@203.0.113.9");
});

test("box add --yes: the server gets this Mac's own version by default, the version asked for with --version, and latest on request", async t => {
  const r = rig(t);
  let { code, text } = await capture(() => add("alex@203.0.113.9", { yes: true }));
  assert.equal(code, 0, text);
  assert.match(r.read("installer.log"), new RegExp(`^--yes --version ${VERSION.replace(/\./g, "\\.")}$`, "m"), "the installer is told this Mac's version");
  assert.match(text, new RegExp(`Vyre will install ${VERSION.replace(/\./g, "\\.")}, the version of this Mac`));

  const r2 = rig(t);
  ({ code, text } = await capture(() => add("alex@203.0.113.9", { yes: true, version: "0.9.1" })));
  assert.equal(code, 0, text);
  assert.match(r2.read("installer.log"), /^--yes --version 0\.9\.1$/m);
  assert.match(text, /0\.9\.1.*you asked for/);

  const r3 = rig(t);
  ({ code, text } = await capture(() => add("alex@203.0.113.9", { yes: true, version: "latest" })));
  assert.equal(code, 0, text);
  assert.match(r3.read("installer.log"), /^--yes --version latest$/m);
  assert.match(text, /latest published release/);
});

test("box add: --version through the command line reaches the installer; a malformed one is a usage error and changes nothing", async t => {
  const r = rig(t);
  let { code } = await capture(() => box[0].run(["add", "alex@203.0.113.9", "--yes", "--version", "0.9.1"]));
  assert.equal(code, 0);
  assert.match(r.read("installer.log"), /^--yes --version 0\.9\.1$/m);
  const r2 = rig(t);
  ({ code } = await capture(() => box[0].run(["add", "alex@203.0.113.9", "--yes", "--version=nope"])));
  assert.notEqual(code, 0);
  assert.equal(r2.read("installer.log"), "", "the installer never ran");
});

test("box add: a box already installed and paired skips the installer and says so", async t => {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  r.put("server.json", JSON.stringify({ owned: true, space: "Personal", device: "Alex's phone" }));
  const { code, text } = await capture(() => add("alex@203.0.113.9"));
  assert.equal(code, 0, text);
  assert.match(text, /already on alex@203\.0\.113\.9/);
  assert.match(text, /Your server is paired to Personal/);
  assert.equal(r.read("installer.log"), "");
  assert.equal(r.read("opened"), "");
});

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
  const { code, text } = await capture(() => add(OLD, { yes: true }));
  assert.equal(code, 0, text);
  assert.match(text, new RegExp(`add ${user} to the docker group \\(root-equivalent on this server; lets Vyre manage the stack without your password\\)`));
  assert.match(ssh(r), /sh \/\S+ --yes && sudo usermod -aG docker "\$\(id -un\)"/);
  assert.match(r.read("usermod.log"), new RegExp(`^-aG docker ${user}$`, "m"));
  assert.equal(ssh(r).match(/ControlMaster=auto/g)?.length, 2, "the master is opened again so the group applies");
});


test("box update: runs vyre update on the saved box and compares versions; a failed update and no box are exit 1", async t => {
  const r = rig(t);
  const run = /** @type {any} */ (box[0]).run;
  const none = await capture(() => run(["update"]));
  assert.equal(none.code, 1);
  assert.match(none.text, /no box yet: vyre box add <user@host>/);
  assert.equal(r.read("vyre.log"), "", "nothing ran without a box");

  config.save({ box: { ssh: OLD } });
  r.put("version", VERSION + "\n");
  const same = await capture(() => run(["update"]));
  assert.equal(same.code, 0, same.text);
  assert.match(same.text, /pulled the new image/);
  assert.ok(same.text.includes(`the box and this Mac both run ${VERSION}`), same.text);
  assert.deepEqual(r.read("vyre.log").trim().split("\n"), ["update", "version"]);

  r.put("version", "0.0.0\n");
  const older = await capture(() => run(["update"]));
  assert.equal(older.code, 0, older.text);
  assert.match(older.text, /the box runs 0\.0\.0, older than this Mac's .*; its next image catches up/);
  assert.match(ssh(r), new RegExp(OLD.replace(/\./g, "\\.")), "it went to the saved target");

  r.put("version", "99.0.0\n");
  const newer = await capture(() => run(["update"]));
  assert.equal(newer.code, 0, newer.text);
  assert.match(newer.text, /the box runs 99\.0\.0, newer than this Mac's .*&& vyre up/);

  r.put("update-fail", "");
  const failed = await capture(() => run(["update"]));
  assert.equal(failed.code, 1, failed.text);
  assert.match(failed.text, /the image pull failed/);
  assert.match(failed.text, /vyre update on the box stopped \(exit 4\)/);
  assert.doesNotMatch(failed.text, /the box runs/, "no version compare after a failed update");
});

test("box backup: writes through .partial at 0600, refuses to overwrite without --force", async t => {
  const r = rig(t);
  config.save({ box: { ssh: OLD } });
  const run = /** @type {any} */ (box[0]).run;
  const file = path.join(r.root, "b.tar.gz");
  const first = await capture(() => run(["backup", file]));
  assert.equal(first.code, 0, first.text);
  assert.match(fs.readFileSync(file, "utf8"), /data vyre_vyre-work/);
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
  for (const v of ["vyre-home", "vyre-work"]) assert.match(text, new RegExp(`${v}\\s+moved`));
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

/** Masters opened, by target, in order. */
const masters = r => ssh(r).split("\n").filter(l => l.includes("ControlMaster=auto")).map(l => l.trim().split(" ").slice(-2)[0]);

/** A box already set up and finished, so add goes straight from reaching it to the ending. */
function finishedBox(t) {
  const r = rig(t);
  fs.mkdirSync(r.stack, { recursive: true });
  fs.writeFileSync(path.join(r.stack, "compose.yml"), "");
  r.setStatuses([status(6, { finished: true })]);
  return r;
}
const noPair = { call: async () => ({ error: { code: "no_such_tool", message: "" } }) };


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
  assert.deepEqual([f[0].view.name, f[0].view.choices, f[0].view.args], ["yes", ["yes", "no"], ["box", "remove", "--purge", "--yes"]]);
  assert.match(f[0].view.label, /stop the stack.*Go ahead\?$/);
  assert.equal(f[0].data.question, "Go ahead?");
  assert.equal(r.read("installer.log"), "", "nothing ran on the server");
  assert.equal(/** @type {any} */ (config.load()).box.ssh, "alex@203.0.113.9", "the box is still remembered");
});
