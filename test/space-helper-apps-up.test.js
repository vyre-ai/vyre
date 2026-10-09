// @ts-check
// The app module half of the Space helper, split into four files (one ran past the per-file time limit): this one is app-up: the walls, the proofs and the setup. The rig and the fakes are test/space-helper-apps-rig.js.
// catalog, walled off the way a Space's store is. Run with sh against a temp folder; docker and nsenter are the fakes of test/space-helper-apps-rig.js (the Space helper's own fakes behind them), the
// generated compose file is the REAL one from core/appmods/host-plan.js. Linux only (stat -c). Real iptables, real Docker and a real DocuSeal need a box: see the live test, VYRE_APPMODS_LIVE=1.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appRig, lineOf } from "./space-helper-apps-rig.js";
import { opts, UID } from "./space-helper-rig.js";

const SECRET = /api_token=tok_|login_password=pw_|hook_token=|SECRET_KEY_BASE=[0-9a-f]{64}/;
/** A rig with the helper installed and the catalog recorded (the real DocuSeal line). */
async function ready(/** @type {import("node:test").TestContext} */ t, over = {}) {
  const r = appRig(t);
  for (const [k, v] of Object.entries(over)) r.flag(k, v);
  await r.prime();
  return r;
}
const read = (/** @type {string} */ p) => fs.readFileSync(p, "utf8");


test("app helper: app-up makes root's keys and compose, joins and walls BEFORE the app starts, proves both directions, then runs the setup once", opts, async t => {
  const r = await ready(t);
  const { id, st } = await r.appUp();
  assert.equal(st.state, "ok", JSON.stringify(st));
  assert.equal(st.id, id);
  const d = path.join(r.priv, "apps", "documents");
  assert.equal(fs.statSync(path.join(d, "secrets.env")).mode & 0o777, 0o600, "root's keys are root-only");
  assert.match(read(path.join(d, "secrets.env")), /^SECRET_KEY_BASE=[0-9a-f]{64}\n$/);
  const compose = read(path.join(d, "compose.yml"));
  assert.ok(!/privileged|ports:|network_mode|cap_add|env_file|unless-stopped/.test(compose));
  assert.match(compose, /^    image: docuseal\/docuseal:[0-9.]+@sha256:[0-9a-f]{64}$/m);
  assert.match(compose, /^    restart: "no"$/m, "an app never starts by itself");
  assert.match(compose, /^      SECRET_KEY_BASE: \$\{SECRET_KEY_BASE\}$/m);
  assert.match(compose, /^  net:\n    internal: true$/m);
  // the OUTPUT rules, on the app's network, with the app's own comment; and the three INPUT rules in order
  const fw = r.appFw();
  const out = fw.filter((/** @type {any} */ x) => x.ch === "OUTPUT").map((/** @type {any} */ x) => x.r);
  assert.deepEqual(out.map((/** @type {any} */ x) => x.uid).sort(), [`0-${UID - 1}`, `${UID + 1}-4294967294`].sort());
  assert.ok(out.every((/** @type {any} */ x) => x.d === "172.31.7.0/24" && x.c === "vyre-app:documents" && x.j === "REJECT"));
  const inp = fw.filter((/** @type {any} */ x) => x.ch === "INPUT").map((/** @type {any} */ x) => x.r);
  assert.deepEqual(inp, [
    { i: "eth1", ct: "ESTABLISHED,RELATED", c: "vyre-app:documents", j: "ACCEPT" },
    { i: "eth1", s: "172.31.7.0/24", p: "tcp", dp: "43001", c: "vyre-app:documents", j: "ACCEPT" },
    { i: "eth1", c: "vyre-app:documents", j: "DROP" },
  ], "answers, then the hook port from the app's subnet, then drop everything else on that interface");
  assert.match(read(path.join(r.SP, "status", "subnets")), /^app:documents 172\.31\.7\.0\/24$/m, "the wall waits for the app's subnet after a restart");
  // order: create, join, OUTPUT, INPUT, start, health, OUTPUT proof, INPUT proof, setup
  const calls = r.calls();
  const at = (/** @type {RegExp} */ re) => { const m = re.exec(calls); assert.ok(m, `${re} in ${calls}`); return m.index; };
  assert.match(read(path.join(r.F, "pulled")), /docuseal\/docuseal:[0-9.]+@sha256:[0-9a-f]{64}/, "the pinned digest is pulled at app-up");
  const order = [/pull -q docuseal/, /compose .* create/, /network connect --alias vyre-daemon vyre-app-documents_net vyre-vyre-1/, /-I OUTPUT 1 .*vyre-app:documents/, /-I INPUT 1 .*-j DROP/, /compose .* up -d/, /--entrypoint node .*fetch\(/, /setpriv --reuid=2000/, /require\("net"\)/, /exec -i --env-file/];
  const pos = order.map(at);
  assert.deepEqual([...pos].sort((x, y) => x - y), pos, "the order holds");
  // the inbound proof: every port but the hook port was tried and timed out; the hook port was tried too
  const tries = read(path.join(r.F, "tries")).trim().split("\n").map(l => l.split(" "));
  assert.ok(tries.every(x => x[0] === "vyre-app-documents_net" && x[1] === "172.31.7.2"));
  assert.deepEqual(tries.map(x => x[2]).sort((x, y) => Number(x) - Number(y)), ["1", "22", "43001", "443", "80"].sort((x, y) => Number(x) - Number(y)));
  // the setup: the script out of the image on the command's STDIN, an env FILE (0600) with the hook token and url, never on a command line; root never writes into the app's filesystem
  assert.match(read(path.join(r.F, "exec-stdin")), /api_token/, "the script reached the command on stdin");
  assert.ok(!/(^| )cp /m.test(calls), "no docker cp in any command line: a third-party container's filesystem is never written by root");
  assert.equal(read(path.join(r.F, "exec-env-mode")), "600");
  const env = read(path.join(r.F, "exec-env"));
  assert.match(env, /^APP_URL=http:\/\/vyre-app-documents:3000$/m);
  assert.match(env, /^VYRE_HOOK_URL=http:\/\/172\.31\.7\.2:43001\/hook$/m);
  assert.match(env, /^VYRE_HOOK_TOKEN=[0-9a-f]{64}$/m);
  assert.match(read(path.join(r.F, "exec-args")), /exec -i --env-file \S+ -w \/app vyre-app-documents bin\/rails runner -$/);
  assert.ok(!fs.existsSync(path.join(d, "setup.env")) && !fs.existsSync(path.join(d, "setup.out")), "the setup's files are gone");
  assert.ok(!SECRET.test(calls) && !calls.includes(env.match(/VYRE_HOOK_TOKEN=(\S+)/)[1]), "no secret and no token is in any command line");
  // the handoff: a file only the daemon's uid reads, with the token and the setup's outputs
  const hand = path.join(r.SP, "status", "app-documents-secrets");
  assert.equal(fs.statSync(hand).mode & 0o777, 0o400);
  assert.equal(fs.statSync(hand).uid, UID);
  const body = read(hand);
  assert.match(body, /^hook_token=[0-9a-f]{64}\napi_token=tok_a{40}\nlogin_password=pw_b{24}\n$/);
  assert.equal(body.match(/hook_token=(\S+)/)[1], env.match(/VYRE_HOOK_TOKEN=(\S+)/)[1]);
  assert.ok(!read(path.join(r.priv, "log")).match(/tok_|pw_/), "the helper's log holds none of it: " + read(path.join(r.priv, "log")));
  assert.ok(fs.existsSync(path.join(d, "bootstrapped")));
  // the same again: the keys stay, the rules stay one set, the setup is NOT run a second time
  const before = read(path.join(d, "secrets.env"));
  fs.rmSync(hand);
  fs.writeFileSync(path.join(r.F, "exec-env"), "");
  fs.rmSync(path.join(r.F, "pulled"), { force: true });
  const again = await r.appUp();
  assert.ok(!fs.existsSync(path.join(r.F, "pulled")), "an image that is here is not pulled again");
  assert.equal(again.st.state, "ok", JSON.stringify(again.st));
  assert.equal(read(path.join(d, "secrets.env")), before);
  assert.equal(r.appFw().length, 5, "applying twice leaves the same five rules");
  assert.equal(read(path.join(r.F, "exec-env")), "", "no second setup");
  assert.ok(!fs.existsSync(hand), "and no second handoff");
});

test("app helper: app-up refuses when the vyre image is not the one root recorded", opts, async t => {
  const r = await ready(t);
  r.flag("ctr-image", "sha256:" + "c".repeat(64));
  const { st } = await r.appUp();
  assert.equal(st.state, "failed");
  assert.match(st.message, /not the one the helper recorded/);
  assert.ok(!/compose .* (create|up)/.test(r.calls()));
});

test("app helper: each wall is proved and a failed proof stops the app", opts, async t => {
  const cases = [
    ["an agent can reach the app (OUTPUT rule ineffective)", { "fw-ineffective": "1" }, /uid 0 can reach the store/],
    ["the app's network can reach a vyre port (answer: open)", { "try-22": "open" }, /network can reach port 22 of the vyre container, answer open/],
    ["the app's network is REFUSED at a vyre port that has no wall (a listener is there)", { "try-80": "refused" }, /can reach port 80/],
    ["the app's network reaches a port vyre listens on", { listen: "  sl\n   0: 00000000:1F90 00000000:0000 0A 0:0 0:0 0 1000\n", "try-8080": "open" }, /can reach port 8080/],
    ["the hook port is dropped too (the daemon could not be told)", { "try-43001": "timeout" }, /hook port of the vyre container is not reachable/],
    ["the app never answers its health path", { wait: "timeout" }, /did not become healthy/],
  ];
  for (const [what, flags, msg] of cases) {
    const r = await ready(t, flags);
    const { st } = await r.appUp();
    assert.equal(st.state, "failed", what);
    assert.match(st.message, /** @type {RegExp} */ (msg), what);
    assert.ok(!fs.existsSync(path.join(r.F, "app-running-documents")), `${what}: the app was stopped again`);
    assert.ok(!fs.existsSync(path.join(r.priv, "apps", "documents", "bootstrapped")), `${what}: no setup ran`);
  }
  for (const [what, flag, msg] of [["no interface found", "no-iface", /interface .* could not be found/], ["a rule that cannot be added", "fw-add-fails", /firewall rule could not be added/], ["a create that fails", "create-fails", /could not be created/], ["a start that fails", "up-fails", /did not start/]]) {
    const r = await ready(t, { [String(flag)]: "1" });
    const { st } = await r.appUp();
    assert.equal(st.state, "failed", String(what));
    assert.match(st.message, /** @type {RegExp} */ (msg), String(what));
  }
});

test("app helper: a setup that fails or prints no output stops the app and records no handoff; a value outside the short alphabet is never kept", opts, async t => {
  for (const [what, flags, msg] of [
    ["the command fails", { "exec-fails": "1" }, /setting the app up failed/],
    ["an output is missing", { "setup-out": "api_token=tok_" + "a".repeat(40) + "\n" }, /gave no login_password/],
    ["a value with a space", { "setup-out": "api_token=a b\nlogin_password=x\n" }, /gave no api_token/],
    ["a value with a quote", { "setup-out": "api_token=a'b\nlogin_password=x\n" }, /gave no api_token/],
    ["a value over 300 characters", { "setup-out": "api_token=" + "a".repeat(301) + "\nlogin_password=x\n" }, /gave no api_token/],
  ]) {
    const r = await ready(t, /** @type {any} */ (flags));
    const { st } = await r.appUp();
    assert.equal(st.state, "failed", String(what));
    assert.match(st.message, /** @type {RegExp} */ (msg), String(what));
    assert.ok(!fs.existsSync(path.join(r.SP, "status", "app-documents-secrets")), `${what}: nothing handed over`);
    assert.ok(!fs.existsSync(path.join(r.priv, "apps", "documents", "bootstrapped")), `${what}: the setup can run again`);
    assert.ok(!fs.existsSync(path.join(r.priv, "apps", "documents", "setup.env")), `${what}: the environment file is gone`);
    assert.ok(!fs.existsSync(path.join(r.F, "app-running-documents")), `${what}: the app is stopped`);
  }
});
