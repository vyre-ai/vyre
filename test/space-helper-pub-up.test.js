// The root side of a site's server, second half: pub-up, pub-stop, pub-down and reattach (team/contracts/builder.md). The rig is test/space-helper-pub-rig.js.
// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { opts } from "./space-helper-rig.js";
import { DEP, DEP2, SPC, SPC2, REQUEST, read, ready } from "./space-helper-pub-rig.js";

test("pub-up: root's compose file from root's record, linted, the secrets written by root into root's env file, the server walled with no door in and proved", opts, async t => {
  const r = await ready(t);
  const built = await r.build(DEP, { request: REQUEST({ secrets: "-" }) });
  assert.equal(built.state, "ok");
  const st = await r.up(DEP, { request: REQUEST({ secrets: "GREETING_PHRASE+STRIPE_KEY" }), secrets: { GREETING_PHRASE: "hello there", STRIPE_KEY: "sk_live_abc123" } });
  assert.equal(st.state, "ok", JSON.stringify(st));
  assert.equal(st.message, "the server is up and walled off");
  const d = path.join(r.priv, "apps", "northwind");
  const compose = read(path.join(d, "compose.yml"));
  assert.match(compose, new RegExp(`^    image: vyre-pub/northwind:${DEP.slice(4)}$`, "m"));
  for (const want of ["    read_only: true", "      - /tmp:rw,size=64m,mode=1777", "      GREETING_PHRASE: ${GREETING_PHRASE}", "      STRIPE_KEY: ${STRIPE_KEY}", "    internal: true", '    restart: "no"', "      - data:/data"]) assert.ok(compose.includes(want), want);
  assert.ok(!/ports:|privileged|cap_add|network_mode|env_file/.test(compose));
  assert.equal(fs.statSync(path.join(d, "secrets.env")).mode & 0o777, 0o600);
  assert.equal(read(path.join(d, "secrets.env")), "GREETING_PHRASE='hello there'\nSTRIPE_KEY='sk_live_abc123'\n");
  assert.equal(read(path.join(d, "pubdep")).trim(), `${DEP} ${SPC}`, "the deployment and the Space that run under the name");
  assert.ok(!fs.existsSync(path.join(r.servers, DEP)), "the daemon's folder with the secrets was taken and removed");
  assert.ok(!fs.existsSync(path.join(r.priv, "pub", DEP, "up")));
  // the walls: the answers to what the daemon asked, then drop everything else on that interface; no hook port is open
  const inp = r.appFw().filter((/** @type {any} */ x) => x.ch === "INPUT").map((/** @type {any} */ x) => x.r);
  assert.deepEqual(inp, [{ i: "eth1", ct: "ESTABLISHED,RELATED", c: "vyre-app:northwind", j: "ACCEPT" }, { i: "eth1", c: "vyre-app:northwind", j: "DROP" }]);
  const out = r.appFw().filter((/** @type {any} */ x) => x.ch === "OUTPUT").map((/** @type {any} */ x) => x.r);
  assert.ok(out.length === 2 && out.every((/** @type {any} */ x) => x.c === "vyre-app:northwind" && x.j === "REJECT"));
  // proved: every port tried timed out, and no hook port was expected open
  const tries = read(path.join(r.F, "tries")).trim().split("\n").map(l => l.split(" "));
  assert.ok(tries.length >= 3 && tries.every(x => x[0] === "vyre-app-northwind_net"));
  assert.ok(read(path.join(r.F, "waits")).includes("http://vyre-app-northwind:8080/ 200+404 60"));
  assert.match(read(path.join(r.priv, "..", "status", "subnets")), /^app:northwind /m);
  // order: create, join, OUTPUT, INPUT, start, health
  const calls = r.calls();
  const at = (/** @type {RegExp} */ re) => { const m = re.exec(calls); assert.ok(m, `${re}`); return m.index; };
  const pos = [/compose .*vyre-app-northwind.* create/, /network connect --alias vyre-daemon vyre-app-northwind_net/, /-I OUTPUT 1 .*vyre-app:northwind/, /nsenter .*-I INPUT 1 .*-j DROP/, /compose .*vyre-app-northwind.* up -d/, /fetch\(/].map(at);
  assert.deepEqual([...pos].sort((x, y) => x - y), pos);
});

test("pub-up refuses a secret that cannot be written safely, a settings file that is not the build's, a missing image and a name that became a catalog app", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP, { request: REQUEST({ secrets: "-" }) })).state, "ok");
  const one = async (/** @type {any} */ o) => r.up(DEP, o);
  const fails = (/** @type {any} */ st, /** @type {RegExp} */ words) => { assert.equal(st.state, "failed", JSON.stringify(st)); assert.match(st.message, words); };
  fails(await one({ request: REQUEST({ secrets: "A_KEY" }), secrets: {} }), /secret A_KEY was not given/);
  fails(await one({ request: REQUEST({ secrets: "A_KEY" }), secrets: { A_KEY: "it's" } }), /quote or a line break/);
  fails(await one({ request: REQUEST({ secrets: "A_KEY" }), secrets: { A_KEY: "line\nbreak" } }), /quote or a line break/);
  fails(await one({ request: REQUEST({ secrets: "A_KEY" }), secrets: { A_KEY: "café" } }), /outside printable ASCII/);
  fails(await one({ request: REQUEST({ secrets: "A_KEY" }), secrets: { A_KEY: "x".repeat(5000) } }), /longer than 4096/);
  fails(await one({ request: REQUEST({ secrets: "A_KEY" }), secrets: { A_KEY: "" } }), /empty/);
  fails(await one({ request: REQUEST({ port: "9000" }) }), /not those of the build/);
  fails(await one({ request: REQUEST({ mem: "1024" }) }), /not those of the build/);
  fails(await one({ request: REQUEST({ name: "other" }) }), /not those of the build/);
  assert.ok(!fs.existsSync(path.join(r.F, "app-running-northwind")), "nothing started for a refusal");
  r.flag("pub-image-gone");
  fails(await one({}), /image that was built is not here any more/);
  fs.rmSync(path.join(r.F, "pub-image-gone"));
  fails(await r.ask("pub-up dep_ffffffffffffffff"), /never built here/);
  // the health wait fails: the server is stopped again, never left running
  r.flag("wait", "no");
  fails(await one({}), /did not become healthy/);
  assert.ok(!fs.existsSync(path.join(r.F, "app-running-northwind")));
});

test("pub-stop and pub-down take the rules away and keep the data; a deployment that is not the one running under the name cannot take it down", opts, async t => {
  const r = await ready(t);
  await r.build(DEP, {}); await r.up(DEP, {});
  assert.ok(fs.existsSync(path.join(r.F, "app-running-northwind")));
  assert.equal((await r.ask(`pub-stop ${DEP}`)).state, "ok");
  assert.ok(!fs.existsSync(path.join(r.F, "app-running-northwind")));
  assert.equal(r.appFw().length, 4, "a stopped server keeps its walls");
  // the next version: built under another deployment, the same name; the old one cannot be taken down by the new one's id
  await r.build(DEP2, { request: REQUEST({ version: "4" }) });
  const mism = await r.ask(`pub-down ${DEP2}`);
  assert.equal(mism.state, "failed");
  assert.match(mism.message, /not the server running under that name/);
  const dn = await r.ask(`pub-down ${DEP}`);
  assert.equal(dn.state, "ok", JSON.stringify(dn));
  assert.deepEqual(r.appFw(), [], "every rule with the server's comment is gone");
  assert.match(dn.message, /data is kept/);
  assert.ok(!/ -v\b|volume rm/.test(r.calls().split("\n").filter(l => /compose .* down/.test(l)).join("\n")), "the data volume is kept");
  const up2 = await r.up(DEP2, { request: REQUEST({ version: "4" }) });
  assert.equal(up2.state, "ok", JSON.stringify(up2));
  assert.equal(read(path.join(r.priv, "apps", "northwind", "pubdep")).trim(), `${DEP2} ${SPC}`);
});

test("reattach walls a running published server again in a new vyre container, with no door in, or stops it", opts, async t => {
  const r = await ready(t);
  await r.build(); await r.up();
  const again = async () => { r.flag("ctr-pid", String(9000 + Math.floor(Math.random() * 900))); fs.writeFileSync(path.join(r.F, "joined"), ""); fs.writeFileSync(path.join(r.F, "app-running-northwind"), "1"); return /** @type {any} */ (await r.run(["space-helper", "reattach"], { SP_REWALL_WAIT: "0" })); };
  const ok = await again();
  assert.equal(ok.code, 0, ok.out);
  const inp = r.appFw(read(path.join(r.F, "ctr-pid"))).filter((/** @type {any} */ x) => x.ch === "INPUT").map((/** @type {any} */ x) => x.r);
  assert.equal(inp.length, 2, "answers and drop, nothing else");
  assert.ok(!inp.some((/** @type {any} */ x) => x.dp), "no hook port");
  assert.match(read(path.join(r.F, "joined")), /vyre-app-northwind_net/);
  r.flag("fw-ineffective");
  const bad = await again();
  assert.match(bad.out, /the app northwind was stopped/);
  assert.ok(!fs.existsSync(path.join(r.F, "app-running-northwind")), "an app that cannot be proved is stopped, never left running unwalled");
});


test("pub-up refuses a compose file that is not read-only or has lost its tmpfs, and starts nothing", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP, { request: REQUEST({ secrets: "-" }) })).state, "ok");
  for (const [flag, what] of [["pubcompose-no-readonly", "read_only"], ["pubcompose-no-tmpfs", "tmpfs"]]) {
    r.flag(flag);
    const st = await r.up(DEP, { request: REQUEST({ secrets: "-" }) });
    assert.equal(st.state, "failed", `${what}: ${JSON.stringify(st)}`);
    assert.match(st.message, /the compose file was refused: lint: a published server must keep its root read-only with the one tmpfs/);
    assert.ok(!fs.existsSync(path.join(r.F, "app-running-northwind")), "nothing started");
    assert.ok(!fs.existsSync(path.join(r.priv, "apps", "northwind", "compose.yml")), "the refused file was not kept");
    fs.rmSync(path.join(r.F, flag));
  }
  assert.equal((await r.up(DEP, { request: REQUEST({ secrets: "-" }) })).state, "ok", "the real generator passes");
});

test("pub-up takes away a hook door left from before: a tag that once had a hook port ends with only the answers and the drop", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP, { request: REQUEST({ secrets: "-" }) })).state, "ok");
  assert.equal((await r.up(DEP, { request: REQUEST({ secrets: "-" }) })).state, "ok");
  const file = path.join(r.F, "appfw-4242");
  const rules = JSON.parse(read(file));
  rules.unshift({ ch: "INPUT", r: { i: "eth1", s: "172.31.9.0/24", p: "tcp", dp: "43001", c: "vyre-app:northwind", j: "ACCEPT" } });
  fs.writeFileSync(file, JSON.stringify(rules));
  assert.equal(r.appFw().filter((/** @type {any} */ x) => x.r.dp).length, 1, "the stale door is there");
  assert.equal((await r.up(DEP, { request: REQUEST({ secrets: "-" }) })).state, "ok");
  const inp = r.appFw().filter((/** @type {any} */ x) => x.ch === "INPUT").map((/** @type {any} */ x) => x.r);
  assert.ok(!inp.some((/** @type {any} */ x) => x.dp), "no hook port");
  assert.deepEqual(inp, [{ i: "eth1", ct: "ESTABLISHED,RELATED", c: "vyre-app:northwind", j: "ACCEPT" }, { i: "eth1", c: "vyre-app:northwind", j: "DROP" }]);
});

test("a name is one server on this box: another Space cannot take over a running server's compose, secrets and data volume, nor stop it, and a newer deployment of the same Space still replaces it", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP, { request: REQUEST({ secrets: "GREETING_PHRASE" }) })).state, "ok");
  assert.equal((await r.up(DEP, { request: REQUEST({ secrets: "GREETING_PHRASE" }), secrets: { GREETING_PHRASE: "first-owner-secret" } })).state, "ok");
  const dir = path.join(r.priv, "apps", "northwind");
  const before = { compose: read(path.join(dir, "compose.yml")), secrets: read(path.join(dir, "secrets.env")), pubdep: read(path.join(dir, "pubdep")), rules: JSON.stringify(r.appFw()) };
  // a second hosted Space builds the same name (its own deployment) and asks to start it
  assert.equal((await r.build(DEP2, { space: SPC2 })).state, "ok", "building is allowed: it takes nothing of the first server");
  const taken = await r.up(DEP2, { space: SPC2, secrets: { GREETING_PHRASE: "the-other-space" } });
  assert.equal(taken.state, "failed", JSON.stringify(taken));
  assert.match(taken.message, /another Space already has a server with that name/);
  assert.deepEqual({ compose: read(path.join(dir, "compose.yml")), secrets: read(path.join(dir, "secrets.env")), pubdep: read(path.join(dir, "pubdep")), rules: JSON.stringify(r.appFw()) }, before, "nothing of the first Space's server changed");
  assert.ok(!read(path.join(dir, "secrets.env")).includes("the-other-space"));
  // it cannot stop or take it down either
  for (const verb of ["pub-stop", "pub-down"]) {
    const st = await r.ask(`${verb} ${DEP2}`);
    assert.equal(st.state, "failed", `${verb}: ${JSON.stringify(st)}`);
    assert.match(st.message, /not the server running under that name/);
  }
  assert.ok(fs.existsSync(path.join(r.F, "app-running-northwind")), "the first Space's server still runs");
  // a folder for a start has to be in the Space the build was made for
  assert.equal((await r.build(DEP2, { request: REQUEST({ version: "4" }), space: SPC })).state, "ok");
  const elsewhere = await r.up(DEP2, { request: REQUEST({ version: "4" }), space: SPC2 });
  assert.equal(elsewhere.state, "failed", JSON.stringify(elsewhere));
  assert.match(elsewhere.message, /not in the Space the server was built for/);
  // the same Space replaces its own server with the newer deployment
  const next = await r.up(DEP2, { request: REQUEST({ version: "4" }), space: SPC });
  assert.equal(next.state, "ok", JSON.stringify(next));
  assert.equal(read(path.join(dir, "pubdep")).trim(), `${DEP2} ${SPC}`);
});

test("pub-stop of a deployment that is not the one running under the name is refused", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP)).state, "ok");
  assert.equal((await r.up(DEP)).state, "ok");
  assert.equal((await r.build(DEP2, { request: REQUEST({ version: "4" }) })).state, "ok");
  const st = await r.ask(`pub-stop ${DEP2}`);
  assert.equal(st.state, "failed", JSON.stringify(st));
  assert.match(st.message, /not the server running under that name/);
  assert.ok(fs.existsSync(path.join(r.F, "app-running-northwind")), "the running server was not stopped");
});

test("two starts of one name at once: the second is told to wait and writes nothing, and a lock left by a process that is gone does not block the name", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP)).state, "ok");
  const lock = path.join(r.priv, "lock-pub-name.northwind");
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
  const busy = await r.up(DEP);
  assert.equal(busy.state, "failed", JSON.stringify(busy));
  assert.match(busy.message, /another start, stop or removal of that name is running/);
  assert.ok(!fs.existsSync(path.join(r.priv, "apps", "northwind", "compose.yml")), "nothing of the second start was written");
  for (const verb of ["pub-stop", "pub-down"]) assert.match((await r.ask(`${verb} ${DEP}`)).message, /another start, stop or removal/, verb);
  // the process that held it is gone: the lock is stale and cleaned
  fs.writeFileSync(path.join(lock, "pid"), "999999");
  const ok = await r.up(DEP);
  assert.equal(ok.state, "ok", JSON.stringify(ok));
  assert.ok(!fs.existsSync(lock), "the lock is released when the start is over");
});

test("the build network's DNS exception falls back to systemd-resolved's upstream list when /etc/resolv.conf is only the local stub", opts, async t => {
  const src = fs.readFileSync(new URL("../box/vyre", import.meta.url), "utf8");
  assert.match(src, /\/run\/systemd\/resolve\/resolv\.conf/, "the fallback is in the helper");
  void t;
});
