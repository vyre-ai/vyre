// @ts-check
// The Space helper, second half (split from test/space-helper.test.js, which ran past the per-file limit): RH-8 on, the images, repair and the admin acts. The rig is test/space-helper-rig.js.
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
import { REPO, WRAPPER_SRC, rig, UID, opts } from "./space-helper-rig.js";

test("space helper SH-5: an `up` is refused when the vyre container does not mount the helper's state folder, because its entry would then have no wall to wait for", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.flag("no-state-mount");
  const id = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /does not mount the helper state folder/);
  assert.ok(!fs.existsSync(path.join(r.F, "running-harlow")), "the store never started");
});

test("space helper: the vyre container's compose is never privileged and keeps NET_ADMIN only for the entry step, which drops it before the daemon runs", async () => {
  const compose = fs.readFileSync(path.join(REPO, "box/compose.yml"), "utf8");
  const vyre = compose.slice(compose.indexOf("\n  vyre:"), compose.indexOf("\n  docker-api:") > 0 ? compose.indexOf("\n  docker-api:") : undefined);
  assert.ok(!/privileged:\s*true/.test(compose), "no service is privileged");
  assert.ok(!/network_mode:\s*host|pid:\s*host/.test(vyre));
  const entry = fs.readFileSync(path.join(REPO, "core/spawner/wall-entry.sh"), "utf8");
  assert.match(entry, /--bounding-set=-net_admin/, "NET_ADMIN leaves the bounding set before the spawner runs");
  assert.match(entry, /space-wall\.sh"?\s*\|\|\s*exit 1/, "the entry waits for the host's marker and stops when it does not come");
});

test("space helper: the images are pulled and recorded by digest at install; a failed pull stops the install; a refreshed record (an update) changes what `up` runs", opts, async t => {
  const r = rig(t);
  r.flag("pull-fails");
  const bad = /** @type {any} */ (await r.run(["space-helper", "install"]));
  assert.notEqual(bad.code, 0); assert.match(bad.out, /could not pull [a-z0-9]\S*: Error response from daemon: pull access denied/, "the real reference and the registry's reason");
  assert.doesNotMatch(bad.out, /\$\{/, "never the raw compose template");
  fs.rmSync(path.join(r.F, "pull-fails"));
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  const d1 = fs.readFileSync(path.join(r.SP, "private", "spaces", "harlow", "compose.yml"), "utf8").match(/redis@sha256:[0-9a-f]{64}/)[0];
  r.flag("digest-salt", "moved");
  const rec = /** @type {any} */ (await r.run(["space-helper", "install"])); assert.equal(rec.code, 0, rec.out);
  r.ask("up harlow\n"); await r.helper();
  const d2 = fs.readFileSync(path.join(r.SP, "private", "spaces", "harlow", "compose.yml"), "utf8").match(/redis@sha256:[0-9a-f]{64}/)[0];
  assert.notEqual(d1, d2);
});

test("space helper RH-8: a writer that holds the request open and rewrites it after the checks never gets a second line, a path or anything but one valid request through (up to 4000 tries or 40 s)", { ...opts, timeout: 150_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "race-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The two functions, as they are in the wrapper, run in one sh against a file a node process keeps rewriting through its own open descriptor.
  const src = WRAPPER_SRC;
  const fnText = (/** @type {string} */ name, /** @type {string} */ until) => { const a = src.indexOf(`\n${name}() {`); const b = src.indexOf(until, a); return src.slice(a, b); };
  const funcs = fnText("sp_name_ok", "# sp_do ID VERB NAME:");
  const file = path.join(dir, "claimed");
  fs.mkdirSync(path.join(dir, "priv"));
  fs.writeFileSync(file, "up abc\n", { mode: 0o600 });
  const racer = spawn("node", ["-e", `
    const fs = require("fs"); const fd = fs.openSync(process.argv[1], "r+");
    const A = Buffer.from("up abc\\n"), B = Buffer.from("up abc\\n../../zzz\\nup x\\n"), C = Buffer.from("up abc\\n\\n");
    let i = 0; const stop = Date.now() + 25000;
    while (Date.now() < stop) { const b = [A, B, C][i++ % 3]; fs.ftruncateSync(fd, 0); fs.writeSync(fd, b, 0, b.length, 0); }
  `, file], { stdio: "ignore" });
  t.after(() => racer.kill());
  const script = `
    SP_PRIV='${path.join(dir, "priv")}'; DAEMON_UID=${UID}; SP_NAME_RE='[a-z][a-z0-9-]{0,30}'
    ${funcs}
    i=0; ok=0; bad=0; end=$(( $(date +%s) + 40 ))
    while [ $i -lt 4000 ] && [ "$(date +%s)" -lt "$end" ]; do
      i=$((i + 1)); LINE=""; MSG=""
      if sp_read_claimed '${file}'; then
        ok=$((ok + 1))
        case "$LINE" in "up abc") ;; *) bad=$((bad + 1)); printf 'ACCEPTED %s\\n' "$LINE" >&2 ;; esac
        case "$LINE" in *"
"*) bad=$((bad + 1)); echo "ACCEPTED A NEWLINE" >&2 ;; esac
      fi
    done
    echo "tries=$i accepted=$ok bad=$bad"
    [ "$bad" = 0 ]`;
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8", timeout: 100_000 });
  racer.kill();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const tries = Number(/tries=(\d+)/.exec(r.stdout)?.[1]);
  assert.ok(tries >= 500, `only ${tries} tries ran: ${r.stdout}`);
  assert.match(r.stdout, /bad=0/);
});

test("space helper RH-8: names that could reach another path are refused wherever a name is used (a slash, dots, a newline, a NUL, a space, a capital, 32 characters)", opts, async t => {
  const r = rig(t);
  await r.prime();
  const bad = ["up ../../etc", "up a/b", "up ..", "up .", "up a b", "up A", "up -x", "up a\nup b", "up " + "a".repeat(32)];
  const ids = bad.map(x => r.ask(x + "\n"));
  ids.push(r.ask(Buffer.from("up a\0b\n")));
  await r.helper();
  for (const id of ids) assert.equal(r.status(id).state, "failed");
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "spaces")) || fs.readdirSync(path.join(r.SP, "private", "spaces")).length === 0);
  assert.ok(!/compose|network/.test(r.calls()));
  // And a queue entry built by anything else is refused at the top of sp_do: the function is only ever given validated words, and checks again.
  assert.match(WRAPPER_SRC, /Everything is checked again here/);
});

test("space helper RH-9: a directory or a link named like a request is removed, never moved, and cannot swallow the next request", opts, async t => {
  const r = rig(t);
  await r.prime();
  const d1 = r.hex(); fs.mkdirSync(r.spool(d1)); fs.writeFileSync(path.join(r.spool(d1), "inner"), "x");
  const good = r.ask("up harlow\n");
  fs.mkdirSync(path.join(r.SP, "private", "claim"), { recursive: true });
  const stuck = r.hex(); fs.mkdirSync(path.join(r.SP, "private", "claim", "req-" + stuck)); fs.writeFileSync(path.join(r.SP, "private", "claim", "req-" + stuck, "f"), "x");
  await r.helper();
  assert.equal(r.status(good).state, "ok");
  assert.equal(r.status(stuck).message, "interrupted");
  assert.deepEqual(fs.readdirSync(path.join(r.SP, "private", "claim")), [], "nothing is left in claim");
  assert.deepEqual(fs.readdirSync(path.join(r.SP, "spool")), []);
});

// publish-fill: the root half of publishing a static site (reviewer-3's conditions, team/0.3/reviews/publish-edge.md).
const SPC = "spc_abcdefghijkl", SITE = "site-aBc123", SLUG = "0123456789abcdef", VOL = `vyre-publish-${SPC}_site-${SLUG}`;
const REQ = `publish-fill ${SPC} ${SITE} ${SLUG}\n`;
/** The daemon's site folder under the fake home (the folder the helper finds from Docker's mount record). @param {ReturnType<typeof rig>} r */
function site(r, /** @type {Record<string, string>} */ files = { "index.html": "<h1>hi</h1>" }) {
  const dir = path.join(r.F, "lend", "publish", SPC, "sites", SITE);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c, { mode: 0o444 }); }
  return dir;
}
const fillCalls = (/** @type {ReturnType<typeof rig>} */ r) => r.calls().split("\n").filter(l => l.startsWith("run ") && l.includes("--network none"));

test("space helper publish-fill: the folder is claimed, checked as root, copied by a throwaway container with the volume name rebuilt from the tokens, checked after, and put back", opts, async t => {
  const r = rig(t);
  await r.prime();
  const dir = site(r, { "index.html": "<h1>hi</h1>", "a/b.css": "x" });
  const id = r.ask(REQ);
  const h = /** @type {any} */ (await r.helper());
  assert.equal(h.code, 0, h.out);
  assert.equal(r.status(id).state, "ok", JSON.stringify(r.status(id)));
  const fills = fs.readFileSync(path.join(r.F, "filled"), "utf8");
  assert.match(fills, new RegExp(`-v ${VOL}:/srv `), "the volume name is the rebuilt one");
  assert.match(fills, /--network none --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE/);
  assert.match(fills, /-v \S*private\/publish-claim\/fill:\/in:ro/, "the copy reads root's claimed folder, never the daemon's");
  assert.ok(!fills.includes(r.F + "/lend"), "no daemon path reaches the container");
  assert.equal(fillCalls(r).length, 3, "looked at, filled, checked");
  assert.ok(!fs.existsSync(dir), "PF-2: the folder is not moved back through the daemon's path");
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "publish-claim", "fill")), "nothing is left in the claim folder");
  assert.ok(!fs.existsSync(r.spool(id)), "the request was consumed");
  // Asked again, the volume already holds the files: nothing is copied twice, the check still runs.
  site(r);
  const id2 = r.ask(REQ); await r.helper();
  assert.equal(r.status(id2).state, "ok");
  assert.equal(fs.readFileSync(path.join(r.F, "filled"), "utf8").split("\n").filter(Boolean).length, 1, "one copy only");
});

test("space helper publish-fill: only the exact three tokens pass; a path, a volume, a capital, an extra word or another verb's shape never runs a container", opts, async t => {
  const r = rig(t);
  await r.prime();
  site(r);
  const bad = {
    "a path": `publish-fill ${SPC} ../x ${SLUG}\n`, "a path in the space id": `publish-fill ../${SPC} ${SITE} ${SLUG}\n`, "a volume name": `publish-fill ${SPC} ${SITE} ${VOL}\n`,
    "a capital in the slug": `publish-fill ${SPC} ${SITE} 0123456789ABCDEF\n`, "a short slug": `publish-fill ${SPC} ${SITE} 0123\n`, "an extra word": `publish-fill ${SPC} ${SITE} ${SLUG} /etc\n`,
    "no space id": `publish-fill ${SITE} ${SLUG}\n`, "a site name of 7 characters": `publish-fill ${SPC} site-aBc1234 ${SLUG}\n`, "a mount option": `publish-fill ${SPC} ${SITE} ${SLUG}:/etc\n`,
    "two lines": REQ + REQ, "a trailing space": `publish-fill ${SPC} ${SITE} ${SLUG} \n`,
  };
  for (const [why, text] of Object.entries(bad)) {
    const id = r.ask(text);
    await r.helper();
    assert.equal(r.status(id).state, "failed", why);
  }
  assert.equal(fillCalls(r).length, 0, "no container was started for any of them");
});

test("space helper publish-fill: a link, a second hard link, a swapped-in link or a folder that is not the daemon's is refused, nothing is copied, and the claim is deleted", opts, async t => {
  const r = rig(t);
  await r.prime();
  // a symlink inside the site
  let dir = site(r);
  fs.symlinkSync("/etc/passwd", path.join(dir, "link"));
  let id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /not a plain file or folder/);
  assert.ok(!fs.existsSync(dir), "the claim was deleted, not put back");
  fs.rmSync(dir, { recursive: true, force: true });
  // a file with a second link
  dir = site(r);
  fs.linkSync(path.join(dir, "index.html"), path.join(r.F, "outside"));
  id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /second link/);
  fs.rmSync(dir, { recursive: true, force: true });
  // the site folder itself is a link to another folder
  const other = fs.mkdtempSync(path.join(r.root, "other-")); fs.writeFileSync(path.join(other, "index.html"), "x");
  fs.mkdirSync(path.join(r.F, "lend", "publish", SPC, "sites"), { recursive: true });
  fs.symlinkSync(other, path.join(r.F, "lend", "publish", SPC, "sites", SITE));
  id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /no such site folder/);
  fs.rmSync(path.join(r.F, "lend", "publish", SPC, "sites", SITE));
  // no such folder at all
  id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed");
  assert.equal(fs.existsSync(path.join(r.F, "filled")), false, "nothing was ever copied");
});

test("space helper publish-fill: a copy that fails, or a volume that does not pass its check, leaves no volume in use", opts, async t => {
  const r = rig(t);
  await r.prime();
  site(r);
  r.flag("fill-fails");
  let id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /could not be copied/);
  assert.match(fs.readFileSync(path.join(r.F, "vol-rm"), "utf8"), new RegExp(VOL), "the volume was removed");
  fs.rmSync(path.join(r.F, "fill-fails"));
  site(r);
  r.flag("post-dirty");
  id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /did not pass its check, so it was removed/);
  assert.ok(!fs.existsSync(path.join(r.F, "lend", "publish", SPC, "sites", SITE)), "the claim is gone");
});

test("space helper: `vyre uninstall` removes the helper's units too, so nothing keeps running a wrapper that is gone", opts, async t => {
  const r = rig(t);
  await r.prime();
  assert.ok(fs.existsSync(path.join(r.UNITS, "vyre-spaces.path")), "installed");
  const u = /** @type {any} */ (await r.run(["uninstall", "--delete-data", "--yes"], { VYRE_SYSTEMD_SEAM: "1" }));
  assert.ok(!fs.existsSync(path.join(r.UNITS, "vyre-spaces.path")), u.out);
  assert.ok(!fs.existsSync(path.join(r.UNITS, "vyre-spaces-watch.service")), u.out);
});

test("space helper PF-1: a copy that hangs is stopped at the time limit, the container is removed by name, the lock is released and the next request runs", opts, async t => {
  const r = rig(t);
  await r.prime();
  site(r);
  r.flag("fill-hangs");
  const id = r.ask(REQ);
  const h = /** @type {any} */ (await r.run(["space-helper-run"], { VYRE_PUBLISH_TIMEOUT: "2" }));
  assert.equal(h.code, 0, h.out);
  assert.equal(r.status(id).state, "failed");
  assert.match(r.calls(), /rm -f vyre-publish-fill/, "removed by its fixed name");
  assert.match(r.calls(), /--name vyre-publish-fill/);
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "lock-publish-fill")), "the lock is released");
  const id2 = r.ask("firewall-add harlow\n"); await r.helper();
  assert.notEqual(r.status(id2), null, "the next request was handled");
});

test("space helper #90: a first start cut off midway leaves a database with an empty core schema; the next up removes that empty database and starts again, with no manual step", opts, async t => {
  const r = rig(t);
  await r.prime();
  const d = path.join(r.SP, "private", "spaces", "harlow");
  // the first start is cut off: the store never became healthy, and what is left is a database with no core user table
  r.flag("up-fails");
  const a = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(a).state, "failed");
  assert.ok(!fs.existsSync(path.join(d, "ready")), "no completion mark after a start that did not finish");
  fs.rmSync(path.join(r.F, "up-fails")); r.flag("core-empty-harlow");
  // the next up (the daemon's retry) finds it, removes it and starts again
  const b = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(b).state, "ok", JSON.stringify(r.status(b)));
  assert.match(fs.readFileSync(path.join(r.F, "purged"), "utf8"), /harlow/, "the empty database's volumes were removed");
  assert.match(fs.readFileSync(path.join(r.SP, "private", "log"), "utf8"), /repair: empty core schema from a cut off first start/, "the log says what was repaired");
  assert.ok(fs.existsSync(path.join(d, "ready")), "and the Space has its mark now");
  assert.ok(!fs.existsSync(path.join(r.F, "core-empty-harlow")));
});

test("space helper #90: a Space with its mark is never touched, a Space with data and no mark is marked and kept, and a Space that cannot be looked at is left as it is", opts, async t => {
  const r = rig(t);
  await r.prime();
  const d = path.join(r.SP, "private", "spaces", "harlow");
  const a = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(a).state, "ok");
  assert.ok(fs.existsSync(path.join(d, "ready")));
  // marked: even a database that looks empty (it is not asked about) keeps its volumes
  r.flag("core-empty-harlow");
  const b = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(b).state, "ok");
  assert.ok(!fs.existsSync(path.join(r.F, "purged")), "a Space with its mark is never purged");
  // data and no mark (a Space made before the mark existed): kept, and marked after it starts
  fs.rmSync(path.join(d, "ready")); fs.rmSync(path.join(r.F, "core-empty-harlow"));
  const c = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(c).state, "ok");
  assert.ok(!fs.existsSync(path.join(r.F, "purged")) && fs.existsSync(path.join(d, "ready")));
  // no mark and the database cannot be asked: left alone, and nothing is purged
  fs.rmSync(path.join(d, "ready")); r.flag("core-empty-harlow"); r.flag("exec-fails");
  const e = r.ask("up harlow\n"); await r.helper();
  assert.ok(!fs.existsSync(path.join(r.F, "purged")), "a Space that cannot be looked at is not purged");
  void e;
});

/** A saved database for the pinned Twenty image, as the vyre image carries it: the fake `docker run` of the generator reads it from this folder. */
const goldenIn = (/** @type {ReturnType<typeof rig>} */ r) => {
  const g = path.join(r.F, "golden-src"); fs.mkdirSync(g, { recursive: true });
  const tag = TWENTY_TESTED_REF.split("@")[0].split(":").pop();
  fs.writeFileSync(path.join(g, `${tag}.dump`), "PGDMP-fake");
  fs.writeFileSync(path.join(g, `${tag}.json`), JSON.stringify({ image: TWENTY_TESTED_REF, email: "service@golden.vyre.invalid", workspaceId: "w", builtAt: "t", sha256: crypto.createHash("sha256").update("PGDMP-fake").digest("hex") }));
  r.flag("golden-dir", g);
  return g;
};

test("space helper golden: a NEW Space starts from the saved database in the image; the dump is taken out once, read-only, and every Space's restore reads it from there; the password stays root's and the daemon's", opts, async t => {
  const r = rig(t); await r.prime(); goldenIn(r);
  const id = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(id).state, "ok", JSON.stringify(r.status(id)));
  const priv = path.join(r.SP, "private"), d = path.join(priv, "spaces", "harlow");
  assert.equal(fs.statSync(path.join(priv, "golden", "golden.dump")).mode & 0o777, 0o444, "one read-only copy for every Space");
  const envAtCreate = fs.readFileSync(path.join(r.F, "env-at-create-harlow"), "utf8");
  const pw = /ADMIN_PASSWORD=([0-9a-f]{64})/.exec(envAtCreate)?.[1];
  assert.ok(pw && envAtCreate.includes(`GOLDEN_DUMP=${path.join(priv, "golden", "golden.dump")}`), "the first start's secrets carry the password and the dump path: " + envAtCreate.replace(/=[0-9a-f]{64}/g, "=<secret>"));
  const sec = fs.readFileSync(path.join(d, "secrets.env"), "utf8");
  assert.ok(!/ADMIN_PASSWORD|GOLDEN_DUMP/.test(sec), "and once the restore is over they are gone from root's copy: " + sec.replace(/=[0-9a-f]{64}/g, "=<secret>"));
  assert.match(sec, /^PG_PASSWORD=[0-9a-f]{64}\nREDIS_PASSWORD=[0-9a-f]{64}\nAPP_SECRET=[0-9a-f]{64}\nENCRYPTION_KEY=[0-9a-f]{64}\n$/, "the Space's own secrets are untouched");
  const adm = path.join(r.SP, "status", "admin-harlow");
  assert.equal(fs.readFileSync(adm, "utf8").trim(), pw, "the daemon can read the one password it signs in with");
  assert.equal(fs.statSync(adm).mode & 0o777, 0o600, "and only the daemon's uid can");
  const atCreate = fs.readFileSync(path.join(r.F, "compose-at-create-harlow"), "utf8");
  assert.match(atCreate, /\n  restore:\n/, "the first start restores the saved database");
  assert.match(atCreate, /^      - \$\{GOLDEN_DUMP:-\.\/golden\.dump\}:\/golden\.dump:ro$/m);
  assert.ok(!/ports:/.test(atCreate), "and still publishes no port");
  const after = fs.readFileSync(path.join(d, "compose.yml"), "utf8");
  assert.ok(!/restore/.test(after), "after it the compose file has no restore step");
  assert.match(after, /DISABLE_DB_MIGRATIONS: "true"/, "and the server skips its migration steps");
  assert.ok(fs.existsSync(path.join(d, "migrated")) && !fs.existsSync(path.join(d, "golden")));
  // a second Space reuses the one dump: the image is asked and copied from once
  const id2 = r.ask("up northwind\n"); await r.helper();
  assert.equal(r.status(id2).state, "ok", JSON.stringify(r.status(id2)));
  assert.equal(fs.readFileSync(path.join(r.F, "created"), "utf8").trim().split("\n").length, 1, "the dump was taken out of the image once");
  assert.notEqual(/ADMIN_PASSWORD=([0-9a-f]{64})/.exec(fs.readFileSync(path.join(r.F, "env-at-create-northwind"), "utf8"))?.[1], pw, "each Space has its own password");
  // the same up again is a plain up: no second password, no restore
  const id3 = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(id3).state, "ok");
  assert.equal(fs.readFileSync(path.join(d, "secrets.env"), "utf8"), sec, "an existing Space is not given a new password or a restore");
});

test("space helper golden: an image with no saved database, or a copy that fails, is the slow path: a plain compose file and no password", opts, async t => {
  const r = rig(t); await r.prime();
  const a = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(a).state, "ok");
  const d = path.join(r.SP, "private", "spaces", "harlow");
  assert.ok(!/restore|golden/i.test(fs.readFileSync(path.join(d, "compose.yml"), "utf8")) && !/ADMIN_PASSWORD/.test(fs.readFileSync(path.join(d, "secrets.env"), "utf8")));
  assert.ok(!fs.existsSync(path.join(r.SP, "status", "admin-harlow")) && !fs.existsSync(path.join(d, "golden")));
  assert.ok(!/DISABLE_DB_MIGRATIONS/.test(fs.readFileSync(path.join(d, "compose.yml"), "utf8").split("\n  worker:")[0]), "the server migrates as before");
  goldenIn(r); r.flag("cp-fails");
  const b = r.ask("up northwind\n"); await r.helper();
  assert.equal(r.status(b).state, "ok", "a failed copy does not stop the Space coming up: " + JSON.stringify(r.status(b)));
  assert.ok(!fs.existsSync(path.join(r.SP, "status", "admin-northwind")) && !fs.existsSync(path.join(r.SP, "private", "spaces", "northwind", "golden")));
});

test("space helper golden: the lint allows the restore step's one mount and nothing else; a mount of another path is refused and nothing is started", opts, async t => {
  const r = rig(t); await r.prime(); goldenIn(r); r.flag("bad-restore");
  const a = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(a).state, "failed");
  assert.match(r.status(a).message, /refused: lint: a volume entry/);
  assert.ok(!/ create/.test(r.calls()), "compose never ran: " + r.calls());
});

test("space helper golden: the admin password file is removed after ten minutes", opts, async t => {
  const r = rig(t); await r.prime(); goldenIn(r);
  const a = r.ask("up harlow\n"); await r.helper();
  const adm = path.join(r.SP, "status", "admin-harlow");
  assert.ok(fs.existsSync(adm));
  const old = new Date(Date.now() - 11 * 60 * 1000); fs.utimesSync(adm, old, old);
  await r.helper();
  assert.ok(!fs.existsSync(adm), "a password nobody read does not stay");
  void a;
});

test("space helper: a Space that a request is bringing up is left alone by the watcher's reattach (its server is not running yet while a restore comes first); without the lock it is stopped as before", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  r.flag("ctr-pid", "9393"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-ineffective");
  const lock = path.join(r.SP, "private", "lock-harlow"); fs.mkdirSync(lock);
  const held = /** @type {any} */ (await r.run(["space-helper", "reattach"]));
  assert.ok(!/was stopped/.test(held.out), held.out);
  assert.ok(fs.existsSync(path.join(r.F, "running-harlow")), "still running: the request that holds the lock proves it");
  fs.rmdirSync(lock);
  const free = /** @type {any} */ (await r.run(["space-helper", "reattach"]));
  assert.match(free.out, /the Space harlow was stopped/);
});

test("space helper: a lock left by a run that is gone does not leave its Space unwatched; a lock whose run is alive, or one with no run named that is fresh, still does", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  const lock = path.join(r.SP, "private", "lock-harlow");
  const again = async () => { r.flag("ctr-pid", String(9000 + Math.floor(Math.random() * 900))); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-ineffective"); fs.writeFileSync(path.join(r.F, "running-harlow"), "1"); return /** @type {any} */ (await r.run(["space-helper", "reattach"])); };
  // a live run (this test's own process) holds it: left alone
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
  assert.ok(!/was stopped/.test((await again()).out), "a live run's lock is respected");
  // a run that is gone (a pid nothing has): the Space is watched again, and stopped when it cannot be proved
  fs.writeFileSync(path.join(lock, "pid"), "2147483646");
  assert.match((await again()).out, /the Space harlow was stopped/, "a dead run's lock does not count");
  // no run named: fresh counts, two hours old does not
  fs.rmSync(path.join(lock, "pid"));
  assert.ok(!/was stopped/.test((await again()).out), "a fresh lock with no pid is respected");
  const old = new Date(Date.now() - 3 * 3600 * 1000); fs.utimesSync(lock, old, old);
  assert.match((await again()).out, /the Space harlow was stopped/, "a lock older than two hours does not count");
});

test("space helper: a dead lock is taken over by renaming it away first (two runs cannot both take it or delete each other's fresh lock)", () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "box", "vyre"), "utf8");
  assert.match(src, /sp_reap_lock\(\) \{ _d="\$1\.dead\.\$\$"; if mv "\$1" "\$_d"/, "the takeover renames the lock to a name of its own run");
  const handler = src.slice(src.indexOf("lk=$SP_PRIV/lock-$n"), src.indexOf("lk=$SP_PRIV/lock-$n") + 1800);
  assert.ok(!/rm -rf "\$\{lk:\?\}" 2>\/dev\/null \|\| true; sp_log "took over/.test(handler), "no plain rm -rf of a lock another run may be taking too");
});
