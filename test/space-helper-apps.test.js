// @ts-check
// The app module half of the Space helper (box/vyre `app-up|app-stop|app-down`, `sp_app_record`; team/0.3/DESIGN-appmods-helper.md): a third-party app (DocuSeal first) started from root's recorded
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

test("app helper: the catalog is recorded at install, field by field, from the image: the real DocuSeal line, its image pulled by digest", opts, async t => {
  const r = await ready(t);
  const line = r.catalogLine().trim();
  const f = line.split(" ");
  assert.equal(f.length, 13, line);
  assert.deepEqual(f.slice(0, 1).concat(f.slice(2, 7)), ["documents", "3000", "1536", "1.5", "512", "43001"]);
  assert.match(f[1], /^documents\/documents:[0-9.]+@sha256:[0-9a-f]{64}$/);
  assert.deepEqual(f.slice(7), ["docuseal-bootstrap.rb", "bin/rails+runner", "api_token+login_password", "/", "200+302", "120"]);
  assert.ok(!(fs.existsSync(path.join(r.F, "pulled")) && read(path.join(r.F, "pulled")).includes("documents")), "recording the catalog pulls no app image: a server that never installs an app does not carry one");
  assert.equal(fs.statSync(path.join(r.priv, "app-modules")).mode & 0o777, 0o600);
});

test("app helper: a catalog line that fails any field records NO app, and the install still succeeds (Twenty does not wait on an app)", opts, async t => {
  const bad = {
    "an image with no digest": lineOf({ image: "docuseal/docuseal:3.3.1" }), "an uppercase digest": lineOf({ image: "docuseal/docuseal@sha256:" + "E".repeat(64) }),
    "an image with a space": lineOf({ image: "documents/docu seal@sha256:" + "e".repeat(64) }), "a name with a capital": lineOf({ name: "Docuseal" }), "a one letter name": lineOf({ name: "d" }),
    "a port of 0": lineOf({ port: "0" }), "a port over 65535": lineOf({ port: "65536" }), "a port with a leading zero": lineOf({ port: "03000" }),
    "memory under 64": lineOf({ mem: "63" }), "memory over 8192": lineOf({ mem: "8193" }), "cpus of 0": lineOf({ cpus: "0" }), "cpus over 8": lineOf({ cpus: "8.5" }), "cpus in words": lineOf({ cpus: "one" }),
    "pids under 32": lineOf({ pids: "31" }), "a hook port under 43000": lineOf({ hook: "42999" }), "a hook port over 43999": lineOf({ hook: "44000" }),
    "a script with a slash": lineOf({ script: "../x.rb" }), "a script with a capital": lineOf({ script: "Boot.rb" }), "a command word with a quote": lineOf({ exec: "bin/rails+run'ner" }),
    "a command with a dollar": lineOf({ exec: "sh+$HOME" }), "an output name with a dash": lineOf({ outs: "api-token" }), "a script and no command": lineOf({ exec: "-" }),
    "a health path with no slash": lineOf({ hpath: "health" }), "a health code with letters": lineOf({ hok: "2xx" }), "a start time of 0": lineOf({ hstart: "0" }), "a start time over 600": lineOf({ hstart: "601" }),
    "twelve fields": lineOf().split(" ").slice(0, 12).join(" "), "fourteen fields": lineOf() + " x",
  };
  const r = appRig(t);
  for (const [what, line] of Object.entries(bad)) {
    r.flag("hostplan-list", line + "\n");
    const p = /** @type {any} */ (await r.run(["space-helper", "install"]));
    assert.equal(p.code, 0, `${what}: the install still goes through: ${p.out}`);
    assert.equal(r.catalogLine(), "", `${what}: nothing is recorded`);
    assert.match(p.out, /no app modules were recorded/, what);
    const { st } = await r.appUp();
    assert.equal(st.state, "failed", what);
    assert.match(st.message, /no such app/, what);
  }
});

test("app helper: names and hook ports are unique across the catalog, and a hook port the vyre container already listens on is refused", opts, async t => {
  const a = lineOf(), b = lineOf({ name: "other", hook: "43002" });
  const cases = {
    "the same name twice": [a, lineOf({ hook: "43002" })], "the same hook port twice": [a, lineOf({ name: "other" })],
  };
  for (const [what, lines] of Object.entries(cases)) {
    const r = appRig(t);
    r.flag("hostplan-list", lines.join("\n") + "\n");
    const p = /** @type {any} */ (await r.run(["space-helper", "install"]));
    assert.equal(p.code, 0, p.out);
    assert.equal(r.catalogLine(), "", `${what}: nothing is recorded`);
    assert.match(p.out, /listed twice|used by two apps/, what);
  }
  const ok = appRig(t);
  ok.flag("hostplan-list", [a, b].join("\n") + "\n");
  await ok.run(["space-helper", "install"]);
  assert.equal(ok.catalogLine().trim().split("\n").length, 2, "two distinct apps are both recorded");
  // vyre listens on 43001 (hex A7F9) already
  const lp = appRig(t);
  lp.flag("hostplan-list", a + "\n");
  lp.flag("listen", "  sl  local_address rem_address   st tx_queue\n   0: 00000000:A7F9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000\n   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000\n");
  const p = /** @type {any} */ (await lp.run(["space-helper", "install"]));
  assert.equal(p.code, 0, p.out);
  assert.equal(lp.catalogLine(), "");
  assert.match(p.out, /hook port 43001 is a port the vyre container already uses/);
  // an app whose image cannot be pulled fails its app-up, with nothing created
  const pf = await ready(t, { "pull-fails-app": "1" });
  const o = await pf.appUp();
  assert.equal(o.st.state, "failed");
  assert.match(o.st.message, /image could not be pulled/);
  assert.ok(!/compose .* (create|up)/.test(pf.calls()));
});

test("app helper: a request is `app-up|app-stop|app-down <module>` for a recorded module and nothing else", opts, async t => {
  const r = await ready(t);
  const bad = {
    "a module that is not recorded": "app-up nothere\n", "a capital": "app-up Docuseal\n", "a dot": "app-up docu.seal\n", "a slash": "app-up ../x\n", "an equals sign": "app-up documents=1\n",
    "a space": "app-up docu seal\n", "two words after": "app-up documents now\n", "one letter": "app-up d\n", "a Space name": "app-up harlow\n", "a Twenty name": "app-up documents-twenty\n",
    "an unknown verb": "app-purge documents\n", "app-up with a flag": "app-up --privileged\n", "a verb in capitals": "APP-UP documents\n", "no newline": "app-up documents", "two lines": "app-up documents\napp-down documents\n",
  };
  const asked = Object.entries(bad).map(([what, text]) => [what, r.ask(text)]);
  await r.helper();
  for (const [what, id] of asked) {
    const st = r.status(id);
    assert.ok(st && st.state === "failed", `${what}: ${JSON.stringify(st)}`);
  }
  assert.ok(!/compose .* (create|up)/.test(r.calls()), "nothing was started by any of them");
  // requests that are not the daemon's: a mode that allows others, a stale one
  const odd = Object.entries({ "a request with group access": { mode: 0o660 }, "a request older than five minutes": { age: 400 } }).map(([what, opt]) => [what, r.ask("app-up documents\n", opt)]);
  await r.helper();
  for (const [what, id] of odd) {
    const st = r.status(id);
    assert.equal(st.state, "failed", what);
    assert.match(st.message, /refused/, what);
  }
  assert.ok(!/compose .* (create|up)/.test(r.calls()), "nor by these");
});

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
  assert.match(compose, /^    image: documents\/documents:[0-9.]+@sha256:[0-9a-f]{64}$/m);
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
  const order = [/pull -q documents/, /compose .* create/, /network connect --alias vyre-daemon vyre-app-documents_net vyre-vyre-1/, /-I OUTPUT 1 .*vyre-app:documents/, /-I INPUT 1 .*-j DROP/, /compose .* up -d/, /--entrypoint node .*fetch\(/, /setpriv --reuid=2000/, /require\("net"\)/, /exec -i --env-file/];
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

test("app helper: the generated compose is linted against the recorded line; each thing the lint refuses is refused and nothing starts", opts, async t => {
  const real = (await (async () => { const { composeFile } = await import("../core/appmods/host-plan.js"); return composeFile("documents"); })());
  const edits = {
    "a privileged service": ["    init: true\n", "    init: true\n    privileged: true\n"],
    "a published port": ["    init: true\n", "    init: true\n    ports:\n      - 3000:3000\n"],
    "an added capability": ["    init: true\n", "    init: true\n    cap_add:\n      - NET_ADMIN\n"],
    "host networking": ["    init: true\n", "    init: true\n    network_mode: host\n"],
    "an env_file": ["    init: true\n", "    init: true\n    env_file: /etc/shadow\n"],
    "a restart policy": ['    restart: "no"\n', "    restart: unless-stopped\n"],
    "another image": [/image: documents\/documents:[^\n]*/, "image: evil/evil@sha256:" + "f".repeat(64)],
    "the image by tag": [/image: documents\/documents:[^\n]*/, "image: docuseal/docuseal:latest"],
    "a bigger memory limit": ["mem_limit: 1536m", "mem_limit: 9000m"],
    "more cpus": ["cpus: 1.5", "cpus: 8"],
    "more pids": ["pids_limit: 512", "pids_limit: 5000"],
    "a host path volume": ["      - data:/data/docuseal\n", "      - /etc:/data/docuseal\n"],
    "a relative host path": ["      - data:/data/docuseal\n", "      - ./x:/data/docuseal\n"],
    "the docker socket": ["      - data:/data/docuseal\n", "      - data:/data/docuseal\n      - docker:/var/run/docker.sock\n"],
    "an undeclared volume": ["      - data:/data/docuseal\n", "      - other:/data/docuseal\n"],
    "a volume over /etc": ["      - data:/data/docuseal\n", "      - data:/etc/x\n"],
    "an env value with a dollar": ['APP_URL: "http://vyre-app-documents:3000"', 'APP_URL: "$(id)"'],
    "an env value with a backtick": ['FORCE_SSL: "false"', 'FORCE_SSL: "`id`"'],
    "another secret reference": ["SECRET_KEY_BASE: ${SECRET_KEY_BASE}", "SECRET_KEY_BASE: ${OTHER}"],
    "a second service": ["networks:\n  net:", "  second:\n    image: x\nnetworks:\n  net:"],
    "a network that is not internal": ["    internal: true", "    internal: false"],
    "an external network": ["networks:\n  net:\n", "networks:\n  net:\n    external: true\n"],
    "a volume named elsewhere": ["name: vyre-app-documents_data", "name: vyre-twenty_data"],
    "a project name that is not the app's": ["name: vyre-app-documents\n", "name: vyre-harlow-twenty\n"],
    "a container name that is not the app's": ["container_name: vyre-app-documents", "container_name: vyre-vyre-1"],
    "a user line": ["    init: true\n", "    init: true\n    user: root\n"],
    "pid host": ["    init: true\n", "    init: true\n    pid: host\n"],
    "a command": ["    init: true\n", "    init: true\n    command: sh\n"],
    "a line outside every block": ["services:\n", "foo: bar\nservices:\n"],
  };
  assert.ok(Object.keys(edits).length >= 25);
  const r = appRig(t);
  await r.prime();
  for (const [what, [from, to]] of Object.entries(edits)) {
    const text = typeof from === "string" ? real.replace(from, /** @type {string} */ (to)) : real.replace(from, /** @type {string} */ (to));
    assert.notEqual(text, real, `${what}: the edit changed the file`);
    r.flag("hostplan-compose", text);
    const { st } = await r.appUp();
    assert.equal(st.state, "failed", what);
    assert.match(st.message, /refused|regenerated/, what);
    assert.ok(!/compose .* (create|up)/.test(r.calls()), `${what}: nothing started`);
  }
  fs.rmSync(path.join(r.F, "hostplan-compose"));
  const { st } = await r.appUp();
  assert.equal(st.state, "ok", "the real file passes the same lint");
  // a generator that prints nothing, or not the marker line, is refused too
  for (const body of ["", "name: vyre-app-documents\n"]) {
    r.flag("hostplan-compose", body || "\n");
    const o = await r.appUp();
    assert.equal(o.st.state, "failed");
    assert.match(o.st.message, /could not be regenerated/);
  }
});

test("app helper: app-stop keeps the walls; app-down removes both chains' rules BEFORE the app leaves the interface, the subnet entry, the join and the app, and keeps the data", opts, async t => {
  const r = await ready(t);
  await r.appUp();
  const s = r.ask("app-stop documents\n");
  await r.helper();
  assert.equal(r.status(s).state, "ok");
  assert.ok(!fs.existsSync(path.join(r.F, "app-running-documents")));
  assert.equal(r.appFw().length, 5, "a stopped app keeps its walls");
  fs.writeFileSync(path.join(r.F, "calls"), "");
  const dn = r.ask("app-down documents\n");
  await r.helper();
  assert.equal(r.status(dn).state, "ok", JSON.stringify(r.status(dn)));
  assert.deepEqual(r.appFw(), [], "every rule with the app's comment is gone, INPUT and OUTPUT");
  assert.ok(!read(path.join(r.SP, "status", "subnets")).includes("app:documents"));
  assert.ok(!fs.existsSync(path.join(r.F, "app-net-documents")), "the network is removed");
  assert.ok(!read(path.join(r.F, "joined")).includes("vyre-app-documents_net"), "the vyre container left it");
  const calls = r.calls();
  assert.ok(calls.search(/-D INPUT/) < calls.search(/network disconnect -f vyre-app-documents_net/), "rules first, then the join");
  assert.ok(calls.search(/network disconnect/) < calls.search(/compose .* down/));
  assert.ok(!/ -v\b|volume rm/.test(calls), "the data is kept");
  assert.ok(!fs.existsSync(path.join(r.priv, "apps", "documents", "bootstrapped")), "the setup runs again on the next install");
  assert.ok(fs.existsSync(path.join(r.priv, "apps", "documents", "secrets.env")), "root keeps the app's keys with its data");
  // down for an app that was never started, stop for one, and a rule the helper cannot read as its own
  const never = appRig(t);
  await never.prime();
  const n = never.ask("app-down documents\n");
  await never.helper();
  assert.equal(never.status(n).state, "failed");
  assert.match(never.status(n).message, /never started/);
});

test("app helper: another app's, and a Space's, rules are never touched by app-down", opts, async t => {
  const r = await ready(t);
  // a second app: the real DocuSeal line and compose under another name and hook port
  const { composeFile } = await import("../core/appmods/host-plan.js");
  const first = r.catalogLine().trim();
  r.flag("hostplan-list", first + "\n" + first.split(" ").map((x, i) => (i === 0 ? "documents-two" : i === 6 ? "43002" : x)).join(" ") + "\n");
  r.flag("hostplan-compose-documents-two", composeFile("documents").replaceAll("vyre-app-documents", "vyre-app-documents-two"));
  await r.run(["space-helper", "install"]);
  assert.equal(r.catalogLine().trim().split("\n").length, 2);
  // a Space with its own rules in the same container
  const sp = r.ask("up harlow\n");
  await r.helper();
  assert.equal(r.status(sp).state, "ok");
  for (const m of ["documents", "documents-two"]) { r.flag("hook-port", m === "documents" ? "43001" : "43002"); const o = await r.appUp(m); assert.equal(o.st.state, "ok", m + ": " + JSON.stringify(o.st)); }
  assert.equal(r.appFw().length, 10);
  const dn = r.ask("app-down documents\n");
  await r.helper();
  assert.equal(r.status(dn).state, "ok");
  const left = r.appFw();
  assert.equal(left.length, 5);
  assert.ok(left.every((/** @type {any} */ x) => x.r.c === "vyre-app:documents-two"), "documents-two keeps all five");
  assert.equal(r.rules().filter(l => l.includes("vyre:harlow")).length, 2, "the Space keeps its two");
});

test("app helper: the handoff file is swept after ten minutes, and `reattach` walls and proves a running app again in a new container, or stops it", opts, async t => {
  const r = await ready(t);
  await r.appUp();
  const hand = path.join(r.SP, "status", "app-documents-secrets");
  assert.ok(fs.existsSync(hand));
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(hand, old, old);
  r.ask("app-stop documents\n");
  r.ask("app-up documents\n");
  await r.helper();
  assert.ok(!fs.existsSync(hand), "an unread handoff does not wait for ever");
  // a new vyre container: new pid, no joins, no rules
  const again = async () => { r.flag("ctr-pid", String(9000 + Math.floor(Math.random() * 900))); fs.writeFileSync(path.join(r.F, "joined"), ""); fs.writeFileSync(path.join(r.F, "app-running-documents"), "1"); return /** @type {any} */ (await r.run(["space-helper", "reattach"], { SP_REWALL_WAIT: "0" })); };
  const ok = await again();
  assert.equal(ok.code, 0, ok.out);
  const pid = read(path.join(r.F, "ctr-pid"));
  assert.equal(r.appFw(pid).length, 5, "joined and walled again in the new container");
  assert.match(read(path.join(r.F, "joined")), /vyre-app-documents_net/);
  // a namespace still settling: a proof that fails twice and then holds does not stop the app
  r.flag("probe-flaky", "2");
  const settling = await again();
  assert.equal(settling.code, 0, settling.out);
  assert.ok(fs.existsSync(path.join(r.F, "app-running-documents")), "two failed proofs and a third that holds: the app stays");
  fs.rmSync(path.join(r.F, "probe-flaky"));
  r.flag("fw-ineffective");
  const bad = await again();
  assert.match(bad.out, /the app documents was stopped/);
  assert.ok(!fs.existsSync(path.join(r.F, "app-running-documents")), "an app that cannot be proved is stopped, never left running unwalled");
});

test("app helper: with no catalog the helper behaves as before (no app directory, no app rule, Twenty's rules unchanged)", opts, async t => {
  const r = appRig(t);
  r.flag("hostplan-list", "\n");
  await r.prime();
  assert.equal(r.catalogLine(), "");
  const id = r.ask("up harlow\n");
  await r.helper();
  assert.equal(r.status(id).state, "ok");
  assert.equal(r.appFw().length, 0);
  assert.equal(r.rules().length, 2);
});

test("app helper: app-up shares the up lane's rate limit with Twenty's up, and app-stop and app-down are never held back by it", opts, async t => {
  const r = await ready(t);
  // every app-up is refused at once (the vyre image is not the recorded one) so the eight land inside one minute; the count is taken before the work, as for Twenty's up
  r.flag("ctr-image", "sha256:" + "c".repeat(64));
  let states = [], stop = "";
  for (let attempt = 0; attempt < 2 && !states.includes("busy"); attempt++) {   // a minute boundary inside the run resets the window: look again once
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(r.ask("app-up documents\n"));
    const s = r.ask("app-stop documents\n");
    const h = /** @type {any} */ (await r.run(["space-helper-run"]));
    assert.equal(h.code, 0, h.out);
    states = ids.map(i => r.status(i).state);
    stop = r.status(s).state;
  }
  assert.ok(states.filter(x => x === "busy").length >= 2, `some are held back: ${states}`);
  assert.notEqual(stop, "busy", "a stop is not an up");
});

test("app helper: `vyre admin purge-app` is an admin act (a terminal, a typed word), never a request: it removes the rules, the app, its volumes and root's folder for it", opts, async t => {
  const r = await ready(t);
  await r.appUp();
  const dir = path.join(r.priv, "apps", "documents");
  assert.ok(fs.existsSync(dir));
  // not a spool verb
  const id = r.ask("app-purge documents\n");
  await r.helper();
  assert.equal(r.status(id).state, "failed");
  assert.ok(fs.existsSync(dir));
  // no terminal, a wrong word, a name that is not an app, an app root never started
  let a = /** @type {any} */ (await r.run(["admin", "purge-app", "documents"], {}, "purge-app documents\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /needs a terminal/);
  a = /** @type {any} */ (await r.run(["admin", "purge-app", "documents"], { VYRE_ADMIN_NO_TTY: "1" }, "y\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /not the word/);
  a = /** @type {any} */ (await r.run(["admin", "purge-app", "Docu.seal"], { VYRE_ADMIN_NO_TTY: "1" }, "x\n"));
  assert.notEqual(a.code, 0);
  a = /** @type {any} */ (await r.run(["admin", "purge-app", "nothere"], { VYRE_ADMIN_NO_TTY: "1" }, "x\n"));
  assert.match(a.out, /no app named nothere/);
  assert.ok(fs.existsSync(dir), "nothing was touched by any of them");
  fs.writeFileSync(path.join(r.F, "calls"), "");
  a = /** @type {any} */ (await r.run(["admin", "purge-app", "documents"], { VYRE_ADMIN_NO_TTY: "1" }, "purge-app documents\n"));
  assert.equal(a.code, 0, a.out);
  assert.deepEqual(r.appFw(), [], "both chains' rules are gone");
  assert.ok(!fs.existsSync(dir), "root's folder for the app is gone");
  assert.match(r.calls(), /compose .* down -v --remove-orphans/);
  assert.match(r.calls(), /image rm documents\/documents:[0-9.]+@sha256:[0-9a-f]{64}/, "the app's image goes with it");
  assert.ok(!read(path.join(r.SP, "status", "subnets")).includes("app:documents"));
  assert.match(read(path.join(r.priv, "log")), /admin purge-app documents/);
});

test("app helper: an install over a running watcher restarts it, so the watcher that re-walls after a restart of the vyre container runs the wrapper that was installed", opts, async t => {
  const r = await ready(t);
  fs.writeFileSync(path.join(r.F, "calls"), "");
  const p = /** @type {any} */ (await r.run(["space-helper", "install"]));
  assert.equal(p.code, 0, p.out);
  assert.match(r.calls(), /systemctl try-restart vyre-spaces-watch\.service/);
});

test("app helper: purge-app keeps an image another app that still has a folder here runs", opts, async t => {
  const r = await ready(t);
  const { composeFile } = await import("../core/appmods/host-plan.js");
  const first = r.catalogLine().trim();
  r.flag("hostplan-list", first + "\n" + first.split(" ").map((x, i) => (i === 0 ? "documents-two" : i === 6 ? "43002" : x)).join(" ") + "\n");
  r.flag("hostplan-compose-documents-two", composeFile("documents").replaceAll("vyre-app-documents", "vyre-app-documents-two"));
  await r.run(["space-helper", "install"]);
  for (const m of ["documents", "documents-two"]) { r.flag("hook-port", m === "documents" ? "43001" : "43002"); assert.equal((await r.appUp(m)).st.state, "ok", m); }
  fs.writeFileSync(path.join(r.F, "calls"), "");
  let a = /** @type {any} */ (await r.run(["admin", "purge-app", "documents"], { VYRE_ADMIN_NO_TTY: "1" }, "purge-app documents\n"));
  assert.equal(a.code, 0, a.out);
  assert.ok(!/image rm/.test(r.calls()), "documents-two still runs that digest");
  a = /** @type {any} */ (await r.run(["admin", "purge-app", "documents-two"], { VYRE_ADMIN_NO_TTY: "1" }, "purge-app documents-two\n"));
  assert.equal(a.code, 0, a.out);
  assert.match(r.calls(), /image rm documents\/documents/, "the last one takes it");
});

test("app helper: APP_URL is the public address (https://<module>.<name>.vyre.run:<port>) when the box has a name on vyre.run, read through the vyre container but kept only if it has that shape; otherwise the internal one", opts, async t => {
  const r = await ready(t);
  const urlOf = () => /APP_URL: "([^"]*)"/.exec(read(path.join(r.priv, "apps", "documents", "compose.yml")))[1];
  assert.equal((await r.appUp()).st.state, "ok");
  assert.equal(urlOf(), "http://vyre-app-documents:3000", "no name on vyre.run: the internal address");
  for (const bad of ["alex.evil 7443", "alex 99999999", "Alex 7443", "alex 7443\nhttp://x", "alex -1", "al$(id) 7443", "alex"]) {
    r.flag("public", bad);
    assert.equal((await r.appUp()).st.state, "ok", bad);
    assert.equal(urlOf(), "http://vyre-app-documents:3000", `${JSON.stringify(bad)} is not a name and a port: the internal address stays`);
  }
  r.flag("public", "alex 7443");
  assert.equal((await r.appUp()).st.state, "ok");
  assert.equal(urlOf(), "https://documents.alex.vyre.run:7443");
  // and the setup (a first start with the same name) is told the same address
  const r2 = await ready(t, { public: "alex 7443" });
  assert.equal((await r2.appUp()).st.state, "ok");
  assert.match(read(path.join(r2.F, "exec-env")), /^APP_URL=https:\/\/documents\.alex\.vyre\.run:7443$/m);
});
