// @ts-check
// The Space helper (box/vyre `space-helper-run`, `space-helper`, `admin`; team/archive/work-journals/space-helper.md Revision 2): the root side of a Space's Twenty store.
// Run with sh against a temp folder standing in for /var/lib/vyre-spaces. docker, nsenter (with a tiny iptables that keeps one rule list per pid, the
// container's namespace) and the other host tools are fakes on PATH; the compose file is the REAL one, from stores/twenty/provision.js. Linux only (stat -c).
// A request from another uid and a real iptables owner match need a real box: see team/archive/work-journals/space-helper.md for the box test list.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.mjs";
import { TWENTY_TESTED_REF, composeFile } from "../stores/twenty/provision.js";
import { REPO, rig, UID, ranges, opts } from "./space-helper-rig.js";

test("space helper: up makes root-only secrets, a linted compose, the join and the rule BEFORE the store starts, and proves the firewall", opts, async t => {
  const r = rig(t);
  await r.prime();
  const id = r.ask("up harlow\n");
  const h = /** @type {any} */ (await r.helper());
  assert.equal(h.code, 0, h.out);
  const st = r.status(id);
  assert.equal(st.state, "ok", JSON.stringify(st));
  assert.equal(st.id, id);
  const d = path.join(r.SP, "private", "spaces", "harlow");
  assert.equal(fs.statSync(path.join(d, "secrets.env")).mode & 0o777, 0o600, "secrets are root-only");
  assert.match(fs.readFileSync(path.join(d, "secrets.env"), "utf8"), /^PG_PASSWORD=[0-9a-f]{64}\nREDIS_PASSWORD=[0-9a-f]{64}\nAPP_SECRET=[0-9a-f]{64}\nENCRYPTION_KEY=[0-9a-f]{64}\n$/);
  const compose = fs.readFileSync(path.join(d, "compose.yml"), "utf8");
  assert.ok(!/env_file|privileged|ports:|network_mode|unless-stopped/.test(compose));
  assert.match(compose, /^    restart: "no"$/m, "RH-7: a store never starts by itself");
  assert.ok(compose.match(/^    image: .*$/gm).every(l => /@sha256:[0-9a-f]{64}$/.test(l)), "every image in root's copy is by digest: " + compose.match(/^    image: .*$/gm));
  assert.deepEqual(r.rules().sort(), ranges("harlow"));
  const calls = r.calls();
  // The order: create, join, then the store starts; the proof comes after.
  const at = (/** @type {RegExp} */ re) => calls.search(re);
  assert.ok(at(/compose .* create/) < at(/network connect --alias vyre-harlow vyre-harlow-twenty_store vyre-vyre-1/), calls);
  assert.ok(at(/network connect/) < at(/compose .* up -d --wait/), "joined before the store starts");
  assert.ok(at(/ -I OUTPUT 1 /) < at(/compose .* up -d --wait/), "the rule is in before the store starts");
  assert.match(calls, /setpriv --reuid=2000/, "the agent probe ran");
  assert.match(calls, new RegExp(`setpriv --reuid=${process.getuid()}`), "and the control");
  assert.ok(/--env-file \S*private\/spaces\/harlow\/secrets.env/.test(calls) && !/vyre-spaces\/spool/.test(calls), "compose reads root's own copy, never the daemon's folder");
  assert.ok(!fs.existsSync(r.spool(id)) && fs.readdirSync(path.join(r.SP, "private", "claim")).length === 0, "the request was consumed");
  // The same up again keeps the secrets and leaves one rule.
  const before = fs.readFileSync(path.join(d, "secrets.env"), "utf8");
  const id2 = r.ask("up harlow\n");
  await r.helper();
  assert.equal(r.status(id2).state, "ok");
  assert.equal(fs.readFileSync(path.join(d, "secrets.env"), "utf8"), before);
  assert.equal(r.rules().length, 2, "applying twice leaves the same two rules");
});

test("space helper: every request that is not exactly `<verb> <name>` is refused before anything runs", opts, async t => {
  const r = rig(t);
  await r.prime();
  const bad = {
    "an extra word": "up harlow now\n", "a path in the name": "up ../etc\n", "a name with a dot": "up har.low\n", "an unknown verb": "purge-space harlow\n",
    "fscrypt-enable is not a verb": "fscrypt-enable harlow\n", "a capital verb": "UP harlow\n", "two lines": "up harlow\nup northwind\n", "a CR": "up harlow\r\n",
    "a NUL": Buffer.from("up harlow\0\n"), "a trailing space": "up harlow \n", "a leading space": " up harlow\n", "no newline": "up harlow",
    "a name of 32 characters": "up a" + "b".repeat(31) + "\n", "a name that collides by prefix": "up foo-twenty-bar\n", "a digit first": "up 9harlow\n",
    "over 64 bytes": "up " + "a".repeat(80) + "\n", "empty": "\n",
  };
  const ids = Object.entries(bad).map(([k, v]) => [k, r.ask(/** @type {any} */ (v))]);
  const mode = r.ask("up harlow\n", { mode: 0o666 });
  const h = /** @type {any} */ (await r.helper());
  assert.equal(h.code, 0, h.out);
  for (const [k, id] of [...ids, ["a request with mode 0666", mode]]) {
    const st = r.status(/** @type {string} */ (id));
    assert.equal(st && st.state, "failed", `${k}: ${JSON.stringify(st)}`);
  }
  assert.ok(!/compose|network|nsenter/.test(r.calls()), "nothing was run for any of them: " + r.calls());
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "spaces")) || fs.readdirSync(path.join(r.SP, "private", "spaces")).length === 0, "no Space was made");
});

test("space helper: a link, a FIFO, a hard link and a stale request are refused after the claim, and the helper does not block", opts, async t => {
  const r = rig(t);
  await r.prime();
  const secret = path.join(r.root, "root-file"); fs.writeFileSync(secret, "up harlow\n");
  const lnk = r.hex(); fs.symlinkSync(secret, r.spool(lnk));
  const fifo = r.hex(); assert.equal(spawnSync("mkfifo", [r.spool(fifo)]).status, 0);
  const hard = r.ask("up harlow\n"); fs.linkSync(r.spool(hard), path.join(r.root, "hardlink"));
  const stale = r.ask("up harlow\n", { age: 3600 });
  const junk = path.join(r.SP, "spool", "not-a-request"); fs.mkdirSync(junk); fs.writeFileSync(path.join(junk, "x"), "x");
  const h = /** @type {any} */ (await r.helper());
  assert.equal(h.code, 0, h.out);
  for (const [k, id] of [["symlink", lnk], ["FIFO", fifo], ["hard link", hard], ["stale", stale]]) assert.equal(r.status(id)?.state, "failed", `${k}: ${JSON.stringify(r.status(id))}`);
  assert.match(r.status(stale).message, /stale/);
  assert.deepEqual(fs.readdirSync(path.join(r.SP, "spool")), [], "the spool is left empty, junk included, so the path unit cannot loop on it");
  assert.ok(!/compose/.test(r.calls()));
});

test("space helper: stop, down and firewall-del for a Space root does not know are refused; a request left claimed by a crash is answered interrupted", opts, async t => {
  const r = rig(t);
  await r.prime();
  const ids = ["stop", "down", "firewall-del", "firewall-add"].map(v => r.ask(`${v} ghost\n`));
  const old = r.hex(); fs.mkdirSync(path.join(r.SP, "private", "claim"), { recursive: true }); fs.writeFileSync(path.join(r.SP, "private", "claim", "req-" + old), "up ghost\n");
  await r.helper();
  for (const id of ids) { assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /no such Space/); }
  assert.equal(r.status(old).message, "interrupted");
  assert.ok(!/compose/.test(r.calls()));
});

test("space helper: two requests before root reads the first are both answered, each by its own id", opts, async t => {
  const r = rig(t);
  await r.prime();
  const a = r.ask("up harlow\n"), b = r.ask("up northwind\n");
  await r.helper();
  assert.equal(r.status(a).state, "ok"); assert.equal(r.status(b).state, "ok");
  assert.equal(r.rules().length, 4, "two rules (two uid ranges) for each of the two Spaces");
});

test("space helper: the Space cap, the up rate and one-at-a-time answer busy or refuse instead of running", opts, async t => {
  const r = rig(t);
  await r.prime();
  const capped = [r.ask("up aa\n"), r.ask("up bb\n"), r.ask("up cc\n")];
  await r.helper();
  const states = capped.map(id => r.status(id)).sort((x, y) => x.state.localeCompare(y.state)).map(s => s.state);
  assert.deepEqual(states.filter(s => s === "ok").length + states.filter(s => s === "failed").length, 3);
  const cap = /** @type {any} */ (await r.run(["space-helper-run"], { VYRE_SPACES_CAP: "2", VYRE_SPACES_UP_PER_MIN: "100" }));
  assert.equal(cap.code, 0);
  const extra = r.ask("up dd\n");
  await r.run(["space-helper-run"], { VYRE_SPACES_CAP: "2", VYRE_SPACES_UP_PER_MIN: "100" });
  assert.equal(r.status(extra).state, "failed"); assert.match(r.status(extra).message, /too many Spaces/);
  const rate = [r.ask("up aa\n"), r.ask("up aa\n")];
  await r.run(["space-helper-run"], { VYRE_SPACES_UP_PER_MIN: "1" });
  assert.ok(rate.some(id => r.status(id).state === "busy"), JSON.stringify(rate.map(id => r.status(id))));
  // A Space whose lock is held answers busy.
  fs.mkdirSync(path.join(r.SP, "private", "lock-aa"));
  const held = r.ask("stop aa\n");
  await r.helper();
  assert.equal(r.status(held).state, "busy");
});

test("space helper: a lock whose run is gone is taken over at once, and a fresh install clears what an earlier install left (locks, claims, the up-rate window, old answers) and keeps every Space", opts, async t => {
  const r = rig(t);
  await r.prime();
  const first = r.ask("up aa\n"); await r.helper();
  assert.equal(r.status(first).state, "ok");
  const priv = path.join(r.SP, "private");
  // a lock left by a run that no longer exists: not busy
  fs.mkdirSync(path.join(priv, "lock-aa")); fs.writeFileSync(path.join(priv, "lock-aa", "pid"), "999999\n");
  const again = r.ask("stop aa\n"); await r.helper();
  assert.equal(r.status(again).state, "ok", JSON.stringify(r.status(again)));
  assert.equal(fs.existsSync(path.join(priv, "lock-aa")), false, "the lock is released at the end of the request");
  assert.deepEqual(fs.readdirSync(priv).filter(f => f.includes(".dead.")), [], "the renamed-away dead lock is removed, none is left behind");
  // what an earlier install left: a lock with no owner, a claim, a full rate window, an old answer
  fs.mkdirSync(path.join(priv, "lock-bb")); fs.mkdirSync(path.join(priv, "claim"), { recursive: true }); fs.writeFileSync(path.join(priv, "claim", "req-" + "a".repeat(32)), "up bb\n");
  fs.writeFileSync(path.join(priv, "rate-up"), `${Math.floor(Date.now() / 60000)} 1000\n`);
  const old = path.join(r.SP, "status", "status-" + "b".repeat(32)); fs.writeFileSync(old, "{}"); const past = new Date(Date.now() - 3600_000); fs.utimesSync(old, past, past);
  const recent = path.join(r.SP, "status", "status-" + "c".repeat(32)); fs.writeFileSync(recent, "{}");
  const inst = /** @type {any} */ (await r.run(["space-helper", "install"]));
  assert.equal(inst.code, 0, inst.out);
  for (const gone of ["lock-bb", "rate-up", path.join("claim", "req-" + "a".repeat(32))]) assert.equal(fs.existsSync(path.join(priv, gone)), false, `${gone} was cleared`);
  assert.equal(fs.existsSync(old), false, "an answer nobody waits for is cleared"); assert.equal(fs.existsSync(recent), true, "a recent answer is kept");
  assert.ok(fs.existsSync(path.join(priv, "spaces", "aa", "record")), "the Space is kept");
  const up = r.ask("up bb\n"); await r.helper();
  assert.equal(r.status(up).state, "ok", JSON.stringify(r.status(up)));
});

test("space helper: a flood is cut at the spool cap, and a stop still runs afterwards", opts, async t => {
  const r = rig(t);
  await r.prime();
  await (async () => { r.ask("up harlow\n"); await r.helper(); })();
  const flood = Array.from({ length: 200 }, () => r.ask("up harlow\n"));
  const h = /** @type {any} */ (await r.run(["space-helper-run"], { VYRE_SPACES_SPOOL_CAP: "5", VYRE_SPACES_UP_PER_MIN: "1000" }));
  assert.equal(h.code, 0, h.out);
  assert.deepEqual(fs.readdirSync(path.join(r.SP, "spool")), [], "everything beyond the cap is deleted, not left to loop");
  assert.ok(flood.filter(id => r.status(id)).length <= 5, "no more than the cap were answered");
  const stop = r.ask("stop harlow\n");
  await r.helper();
  assert.equal(r.status(stop).state, "ok");
  assert.ok(fs.statSync(path.join(r.SP, "private", "log")).size < 262144 + 1000, "the log is capped");
});

test("space helper: the cleanup lane runs stop, down and firewall-del before an up in the same batch", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  r.ask("up northwind\n"); r.ask("stop harlow\n");
  await r.helper();
  const calls = r.calls().split("\n");
  const stopAt = calls.findIndex((l, i) => /compose .* stop/.test(l) && /harlow/.test(l) && i > calls.findIndex(x => /harlow.* up -d/.test(x)));
  const upAt = calls.findIndex(l => /northwind.* create/.test(l));
  assert.ok(stopAt > 0 && upAt > 0 && stopAt < upAt, `stop at ${stopAt}, up at ${upAt}`);
});

test("space helper: firewall-del is refused while the project runs, then removes exactly that Space's rule; down keeps the data and the rule until asked", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); r.ask("up northwind\n"); await r.helper();
  assert.equal(r.rules().length, 4);
  const early = r.ask("firewall-del harlow\n"); await r.helper();
  assert.equal(r.status(early).state, "failed"); assert.match(r.status(early).message, /running/);
  assert.equal(r.rules().length, 4);
  const down = r.ask("down harlow\n"); await r.helper();
  assert.equal(r.status(down).state, "ok");
  assert.match(r.status(down).message, /data is kept/);
  assert.ok(!/ -v/.test(r.calls().split("\n").filter(l => /harlow.* down/.test(l)).join("\n")), "down never takes the volumes");
  assert.equal(r.rules().length, 4, "the rules stay until firewall-del");
  const del = r.ask("firewall-del harlow\n"); await r.helper();
  assert.equal(r.status(del).state, "ok");
  assert.deepEqual(r.rules().sort(), ranges("northwind"), "only harlow's rules are gone");
});

test("space helper RH-3: a recreated vyre container has no join and no rule; up re-applies with a fresh pid and proves it; a rule that does not block fails the up and stops the store", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  assert.equal(r.rules("4242").length, 2);
  // The container is recreated: new pid, no network joins, an empty namespace.
  r.flag("ctr-pid", "5151"); fs.writeFileSync(path.join(r.F, "joined"), "");
  assert.deepEqual(r.rules("5151"), []);
  const id = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(id).state, "ok");
  assert.equal(r.rules("5151").length, 2, "the rules went into the NEW namespace");
  assert.match(r.calls(), /nsenter -t 5151 /, "the pid is read fresh");
  // The rule is accepted but does not block (RH-4): the probe sees the agent connect, so the up fails and the store is stopped.
  r.flag("ctr-pid", "6262"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-ineffective");
  const bad = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(bad).state, "failed"); assert.match(r.status(bad).message, /uid \d+ can reach the store/);
  assert.ok(!fs.existsSync(path.join(r.F, "running-harlow")), "stopped, not left running unfirewalled");
  fs.rmSync(path.join(r.F, "fw-ineffective"));
  // A dead store (RH-4 control): the agent probe times out, and the control fails first, so it does not read as a pass.
  r.flag("ctr-pid", "7373"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("store-dead");
  const dead = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(dead).state, "failed"); assert.match(r.status(dead).message, /control connect/);
  fs.rmSync(path.join(r.F, "store-dead"));
  // A rule that cannot be added fails before the store starts.
  r.flag("ctr-pid", "8484"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-add-fails");
  fs.rmSync(path.join(r.F, "running-harlow"), { force: true });
  const nofw = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(nofw).state, "failed"); assert.match(r.status(nofw).message, /could not be added/);
  assert.ok(!fs.existsSync(path.join(r.F, "running-harlow")), "the store never started");
});

test("space helper: `space-helper reattach` joins and firewalls again a Space that still runs after the container was recreated, and stops one it cannot prove", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  r.flag("ctr-pid", "9191"); fs.writeFileSync(path.join(r.F, "joined"), "");
  const ok = /** @type {any} */ (await r.run(["space-helper", "reattach"]));
  assert.equal(ok.code, 0, ok.out);
  assert.equal(r.rules("9191").length, 2);
  r.flag("ctr-pid", "9292"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-ineffective");
  const bad = /** @type {any} */ (await r.run(["space-helper", "reattach"]));
  assert.match(bad.out, /the Space harlow was stopped/);
  assert.ok(!fs.existsSync(path.join(r.F, "running-harlow")));
});

test("space helper: a regenerated compose file with a forbidden key or an unrecorded image is refused and nothing is started", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.flag("bad-compose");
  const a = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(a).state, "failed"); assert.match(r.status(a).message, /refused: lint: service key privileged/);
  fs.rmSync(path.join(r.F, "bad-compose")); r.flag("bad-image");
  const b = r.ask("up harlow\n"); await r.helper();
  assert.match(r.status(b).message, /an image root did not record/);
  assert.ok(!/ create/.test(r.calls()), "compose never ran on either: " + r.calls());
});

test("space helper: the log and the status carry no path, no secret and no request text beyond a matched verb", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); r.ask("up /etc/passwd\n"); await r.helper();
  const log = fs.readFileSync(path.join(r.SP, "private", "log"), "utf8");
  const secrets = fs.readFileSync(path.join(r.SP, "private", "spaces", "harlow", "secrets.env"), "utf8").split("\n").map(l => l.split("=")[1]).filter(Boolean);
  for (const s of secrets) assert.ok(!log.includes(s));
  assert.ok(!log.includes("/etc/passwd") && !log.includes(r.root), log);
  for (const f of fs.readdirSync(path.join(r.SP, "status"))) { const txt = fs.readFileSync(path.join(r.SP, "status", f), "utf8"); assert.ok(!txt.includes(r.root) && !secrets.some(s => txt.includes(s))); }
});

test("space helper: it refuses to run when the folders are not as it needs them", opts, async t => {
  const r = rig(t);
  await r.prime();
  fs.chmodSync(path.join(r.SP, "private"), 0o770);
  const id = r.ask("up harlow\n");
  const h = /** @type {any} */ (await r.helper());
  assert.match(h.out, /not as the Space helper needs it/);
  assert.equal(r.status(id), null);
  assert.ok(fs.existsSync(r.spool(id)), "the request is left alone");
  fs.chmodSync(path.join(r.SP, "private"), 0o700);
  fs.chmodSync(path.join(r.SP, "spool"), 0o777);
  assert.match(/** @type {any} */ ((await r.helper())).out, /not as the Space helper needs it/);
});

test("space helper: install writes a path unit on the spool with the start limits off, and the compose mounts the two folders", opts, async t => {
  const r = rig(t);
  await r.prime(true);
  const p = fs.readFileSync(path.join(r.UNITS, "vyre-spaces.path"), "utf8"), s = fs.readFileSync(path.join(r.UNITS, "vyre-spaces.service"), "utf8");
  assert.match(p, /DirectoryNotEmpty=.*\/spool/); assert.match(p, /TriggerLimitIntervalSec=0/); assert.match(p, /StartLimitIntervalSec=0/);
  assert.match(s, /StartLimitIntervalSec=0/); assert.match(s, /ExecStart=.*space-helper-run/);
  assert.equal(fs.readFileSync(path.join(r.SP, "private", "image"), "utf8").trim(), "sha256:" + "a".repeat(64));
  const images = fs.readFileSync(path.join(r.SP, "private", "images"), "utf8").trim().split("\n").map(l => l.split(" "));
  const written = images.map(i => i[0]);
  for (const want of [/postgres/, /redis/, /twentycrm\/twenty/]) assert.ok(written.some(w => want.test(w)), `${want} is recorded: ${written.join(", ")}`);
  const pulled = fs.readFileSync(path.join(r.F, "pulled"), "utf8").trim().split("\n");
  assert.ok(pulled.every(p => !p.includes("${")), `every pull names a real reference, never a compose template: ${pulled.join(", ")}`);
  assert.ok(pulled.some(p => /^twentycrm\/twenty:v[0-9.]+(@sha256:[0-9a-f]{64})?$/.test(p)), `Twenty is pulled by its pinned tag and digest: ${pulled.join(", ")}`);
  for (const [, dg] of images) assert.match(dg, /^[a-z0-9\/]+@sha256:[0-9a-f]{64}$/, "every image is recorded by digest");
  assert.equal(fs.statSync(path.join(r.SP, "private")).mode & 0o777, 0o700);
  assert.match(r.calls(), /systemctl enable --now vyre-spaces\.path/);
  const compose = fs.readFileSync(path.join(REPO, "box/compose.yml"), "utf8");
  assert.match(compose, /VYRE_SPACES_ROOT:-\/var\/lib\/vyre-spaces\}\/spool:\/run\/vyre-spaces\n/);
  assert.match(compose, /VYRE_SPACES_ROOT:-\/var\/lib\/vyre-spaces\}\/status:\/run\/vyre-spaces-state:ro\n/);
});

test("space helper RH-2: purge and fscrypt-enable are only `vyre admin`, which needs a terminal and the exact typed word", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  r.ask("down harlow\n"); await r.helper();
  // A pipe is not a terminal.
  let a = /** @type {any} */ (await r.run(["admin", "purge-space", "harlow"], {}, "purge-space harlow\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /needs a terminal/);
  assert.ok(!fs.existsSync(path.join(r.F, "purged")));
  // The test seam stands in for the terminal: a wrong word does nothing, the exact one purges and removes the record and the secrets.
  a = /** @type {any} */ (await r.run(["admin", "purge-space", "harlow"], { VYRE_ADMIN_NO_TTY: "1" }, "y\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /not the word/);
  assert.ok(fs.existsSync(path.join(r.SP, "private", "spaces", "harlow", "record")));
  a = /** @type {any} */ (await r.run(["admin", "purge-space", "harlow"], { VYRE_ADMIN_NO_TTY: "1" }, "purge-space harlow\n"));
  assert.equal(a.code, 0, a.out); assert.match(a.out, /It cannot be undone/);
  assert.equal(fs.readFileSync(path.join(r.F, "purged"), "utf8").trim(), "harlow");
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "spaces", "harlow")));
  assert.equal(r.rules().length, 0, "its firewall rule is removed with it");
  a = /** @type {any} */ (await r.run(["admin", "purge-space", "ghost"], { VYRE_ADMIN_NO_TTY: "1" }, "purge-space ghost\n"));
  assert.match(a.out, /no Space named ghost/);
  // fscrypt: only on ext4 with a block device, skipped when the feature is already there, exactly tune2fs -O encrypt.
  // Root finds the lent-workspace folder itself, from Docker's mounts of the vyre container; nothing the daemon writes is read.
  r.flag("no-mounts");
  a = /** @type {any} */ (await r.run(["admin", "fscrypt-enable"], { VYRE_ADMIN_NO_TTY: "1" }, "fscrypt\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /could not find the folder/);
  fs.rmSync(path.join(r.F, "no-mounts"));
  a = /** @type {any} */ (await r.run(["admin", "fscrypt-enable"], { VYRE_ADMIN_NO_TTY: "1" }, "fscrypt\n"));
  assert.equal(a.code, 0, a.out); assert.match(a.out, /cannot be undone, and it changes nothing else/);
  assert.match(r.calls(), /^tune2fs -O encrypt \/dev\/vda1$/m);
  r.flag("features", "has_journal encrypt");
  const before = r.calls();
  a = /** @type {any} */ (await r.run(["admin", "fscrypt-enable"], { VYRE_ADMIN_NO_TTY: "1" }, "fscrypt\n"));
  assert.match(a.out, /already on/); assert.equal((r.calls().match(/tune2fs -O encrypt/g) || []).length, (before.match(/tune2fs -O encrypt/g) || []).length);
  r.flag("fstype", "btrfs");
  a = /** @type {any} */ (await r.run(["admin", "fscrypt-enable"], { VYRE_ADMIN_NO_TTY: "1" }, "fscrypt\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /not ext4/);
  // And nothing in the spool grammar can ask for either.
  const ids = [r.ask("purge-space harlow\n"), r.ask("fscrypt-enable\n")]; await r.helper();
  for (const id of ids) assert.equal(r.status(id).state, "failed");
});

test("space helper RH-6: the rule refuses every uid but the daemon's, so nothing else can reach Twenty's first-user signup", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  assert.deepEqual(r.rules().sort(), ranges("harlow"), "two positive ranges, either side of the daemon uid: a negated match would drop the kernel's own REJECT reply");
  assert.ok(!r.rules().some(l => l.includes("!")));
  // The sessions uid connecting is a failure of the proof, like an agent's.
  assert.match(r.calls(), new RegExp(`--reuid=${UID + 1} `));
});

test("space helper RH-7: `space-helper watch` reattaches after the vyre container starts again outside the wrapper, and stops a Space it cannot prove", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  // docker restart vyre-vyre-1: a new pid, no joins, an empty namespace; the watcher sees the start event.
  r.flag("ctr-pid", "3131"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("events", "start\n");
  const ok = /** @type {any} */ (await r.run(["space-helper", "watch"], { VYRE_SPACES_WATCH_ONCE: "1" }));
  assert.equal(ok.code, 0, ok.out);
  assert.equal(r.rules("3131").length, 2, "the rules are back in the new namespace");
  assert.match(r.calls(), /events --filter container=vyre-vyre-1 --filter event=start/);
  r.flag("ctr-pid", "3232"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-add-fails");
  const bad = /** @type {any} */ (await r.run(["space-helper", "watch"], { VYRE_SPACES_WATCH_ONCE: "1" }));
  assert.match(bad.out, /the Space harlow was stopped/);
  assert.ok(!fs.existsSync(path.join(r.F, "running-harlow")), "stopped, not left running with no rule");
  assert.match(fs.readFileSync(path.join(r.UNITS, "vyre-spaces-watch.service"), "utf8"), /ExecStart=.*space-helper watch\nRestart=always/);
});

test("space helper: `admin wipe` needs a terminal and the typed word, and says what it destroys, before it touches anything", opts, async t => {
  const r = rig(t);
  await r.prime();
  let a = /** @type {any} */ (await r.run(["admin", "wipe"], {}, "wipe\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /needs a terminal/);
  a = /** @type {any} */ (await r.run(["admin", "wipe"], { VYRE_ADMIN_NO_TTY: "1" }, "yes\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /destroys everything on this server/); assert.match(a.out, /not the word/);
  assert.ok(!/compose/.test(r.calls()), "no word, no docker call");
});

test("space helper SH-2 and SH-3: a family the network lacks (`invalid IP`) is ignored; firewall-del matches the quoted comment real iptables prints, and never reports success while a rule remains", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  const stopped = r.ask("stop harlow\n"); await r.helper();
  assert.equal(r.status(stopped).state, "ok");
  // The listing shows the quoted form: the delete still finds it and removes it.
  const del = r.ask("firewall-del harlow\n"); await r.helper();
  assert.equal(r.status(del).state, "ok", JSON.stringify(r.status(del)));
  assert.deepEqual(r.rules(), []);
  assert.ok(!/harlow/.test(fs.readFileSync(path.join(r.SP, "status", "subnets"), "utf8")), "the container's wall list forgets it");
  // A rule the helper cannot delete (the fake refuses -D) is a failure, not a success.
  r.ask("up harlow\n"); await r.helper();
  r.ask("stop harlow\n"); await r.helper();
  r.flag("fw-del-fails");
  const stuck = r.ask("firewall-del harlow\n"); await r.helper();
  assert.equal(r.status(stuck).state, "failed"); assert.match(r.status(stuck).message, /still there/);
  assert.equal(r.rules().length, 2);
});

test("space helper SH-1, SH-4, SH-5: the host writes a marker that names this START of the container; the entry holds the daemon back until its own start's marker is there, and fails closed", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  const list = path.join(r.SP, "status", "subnets");
  assert.equal(fs.readFileSync(list, "utf8").trim(), "harlow 172.30.4.0/24");
  const bin = fs.mkdtempSync(path.join(SCRATCH, "wallbin-")); t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  // The entry reads the container's own hostname and start time: a fake `hostname` on PATH and VYRE_WALL_TEST_START stand in for Docker's id and PID 1's start.
  const as = (/** @type {string} */ host, /** @type {number} */ start) => { fs.writeFileSync(path.join(bin, "hostname"), `#!/bin/sh\necho ${host}\n`, { mode: 0o755 }); return spawnSync("sh", [path.join(REPO, "core/spawner/space-wall.sh")], { env: { PATH: `${bin}:${process.env.PATH}`, VYRE_SPACES_STATE: path.join(r.SP, "status"), VYRE_WALL_WAIT: "2", VYRE_WALL_TEST_START: String(start) }, encoding: "utf8" }); };
  const epoch = (/** @type {string} */ s) => Math.floor(Date.parse(s) / 1000);
  const S1 = epoch("2026-10-04T10:00:00Z");
  // A container started and no marker yet: the daemon does not start.
  let w = as("abcdef012345", S1);
  assert.equal(w.status, 1); assert.match(w.stderr, /the daemon is not starting/);
  assert.ok(!/cannot open/.test(w.stderr), "a marker that is not there yet is waited for quietly: " + w.stderr);
  // The helper proves the rules for the running container and names this start.
  const ok = /** @type {any} */ (await r.run(["space-helper", "reattach"])); assert.equal(ok.code, 0, ok.out);
  assert.equal(fs.readFileSync(path.join(r.SP, "status", "wall-ready"), "utf8").trim(), `abcdef012345 ${S1}`);
  assert.equal(as("abcdef012345", S1).status, 0);
  // SH-4: a docker restart keeps the id and starts a new process. The old marker names the old start, so it does not pass.
  w = as("abcdef012345", S1 + 600);
  assert.equal(w.status, 1, "the same container id, a later start: the earlier marker must not pass");
  // The helper sees the new start and writes the new marker.
  r.flag("ctr-start", "2026-10-04T10:10:00Z");
  assert.equal((/** @type {any} */ (await r.run(["space-helper", "reattach"]))).code, 0);
  assert.equal(as("abcdef012345", S1 + 600).status, 0, "after the host proved this start");
  assert.equal(as("abcdef012345", S1).status, 1, "and the earlier start no longer matches");
  // A different container (another id) with the same start time does not pass either.
  assert.equal(as("fedcba543210", S1 + 600).status, 1);
  // The marker goes when the container dies or stops: nothing is left for a later start to find.
  r.flag("events", "die\n");
  assert.equal((/** @type {any} */ (await r.run(["space-helper", "watch"], { VYRE_SPACES_WATCH_ONCE: "1" }))).code, 0);
  assert.ok(!fs.existsSync(path.join(r.SP, "status", "wall-ready")), "removed on die");
  // SH-5: the helper is installed (status/ready) and the list of firewalled stores is missing: closed. An empty list: nothing to wait for. No helper: nothing to wait for.
  const saved = fs.readFileSync(list);
  fs.rmSync(list);
  w = as("abcdef012345", S1); assert.equal(w.status, 1); assert.match(w.stderr, /list of firewalled stores is missing/);
  fs.writeFileSync(list, "");
  assert.equal(as("abcdef012345", S1).status, 0);
  fs.writeFileSync(list, saved);
  fs.rmSync(path.join(r.SP, "status", "ready"));
  assert.equal(as("abcdef012345", S1).status, 0, "no helper on this server");
});
