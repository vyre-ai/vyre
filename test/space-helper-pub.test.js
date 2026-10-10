// @ts-check
// The root side of a site's server on a server that runs its apps through the host helper (box/vyre `pub-build|pub-up|pub-stop|pub-down`, team/contracts/builder.md): the folder the daemon writes is
// taken by rename and judged as root, the image is built by an unprivileged rootless BuildKit, the compose file is root's own from root's record, linted, and the server is walled with no door in.
// docker and nsenter are the fakes of test/space-helper-apps-rig.js; the Dockerfile and settings are judged by the REAL core/appmods/host-pub.js. Linux only.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appRig } from "./space-helper-apps-rig.js";
import { opts, UID } from "./space-helper-rig.js";
import { BUILDKIT } from "../core/builder/container.js";

const SPC = "spc_abcdefghijkl", DEP = "dep_0123456789abcdef", DEP2 = "dep_fedcba9876543210";
const REQUEST = (/** @type {Record<string, string>} */ over = {}) => Object.entries({ name: "northwind", version: "3", port: "8080", mem: "512", cpus: "0.5", pids: "256", health_path: "/", health_ok: "200+404", health_start: "60", secrets: "-", ...over }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
const read = (/** @type {string} */ p) => fs.readFileSync(p, "utf8");

/** A ready helper, and the daemon's side: the folder it writes for a deployment. */
async function ready(/** @type {import("node:test").TestContext} */ t) {
  const r = appRig(t);
  await r.prime();
  const servers = path.join(r.F, "lend", "publish", SPC, "servers");
  fs.mkdirSync(servers, { recursive: true });
  /** @param {string} dep @param {{ request?: string, files?: Record<string, string>, secrets?: Record<string, string> }} [o] */
  const write = (dep, o = {}) => {
    const d = path.join(servers, dep);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    if (o.request !== null) fs.writeFileSync(path.join(d, "request"), o.request ?? REQUEST());
    if (o.files) for (const [f, text] of Object.entries(o.files)) { fs.mkdirSync(path.dirname(path.join(d, "ctx", f)), { recursive: true }); fs.writeFileSync(path.join(d, "ctx", f), text); }
    if (o.secrets) { fs.mkdirSync(path.join(d, "secrets")); for (const [n, v] of Object.entries(o.secrets)) fs.writeFileSync(path.join(d, "secrets", n), v); }
    return d;
  };
  const GOOD = { "Dockerfile": "FROM node:22-alpine\nCOPY server.js .\nEXPOSE 8080\nCMD [\"node\", \"server.js\"]\n", "server.js": "x" };
  const ask = async (/** @type {string} */ line) => { const id = r.ask(line + "\n"); await r.helper(); return r.status(id); };
  const build = async (dep = DEP, o = {}) => { write(dep, { files: GOOD, ...o }); return ask(`pub-build ${dep}`); };
  const up = async (dep = DEP, o = {}) => { write(dep, o); return ask(`pub-up ${dep}`); };
  const rec = (dep = DEP) => path.join(r.priv, "pub", dep, "rec");
  return { ...r, write, ask, build, up, rec, servers, GOOD };
}

test("pub-build: the folder is taken, judged, built by an unprivileged rootless BuildKit with the context read-only, and recorded; the answer is the image id", opts, async t => {
  const r = await ready(t);
  const st = await r.build();
  assert.equal(st.state, "ok", JSON.stringify(st));
  const id = /^built (sha256:[0-9a-f]{64})$/.exec(st.message);
  assert.ok(id, st.message);
  assert.ok(!fs.existsSync(path.join(r.servers, DEP)), "the daemon's folder was taken by rename and is gone");
  assert.equal(fs.statSync(r.rec()).mode & 0o777, 0o600, "root's record is root's alone");
  assert.equal(read(r.rec()).trim(), `northwind vyre-pub/northwind:${DEP.slice(4)} ${id[1]} 8080 512 0.5 256 / 200+404 60 3 -`);
  // the build: the pinned image, the context and the output the only mounts, nothing privileged, only the two capabilities a user namespace needs
  const b = read(path.join(r.F, "pub-builds")).trim();
  assert.ok(b.includes(BUILDKIT));
  assert.ok(/ --cap-drop ALL --cap-add SETUID --cap-add SETGID /.test(b) && !/--privileged|docker\.sock|--network host/.test(b));
  const mounts = b.split(" ").filter((x, i, a) => a[i - 1] === "-v");
  assert.equal(mounts.length, 2);
  assert.ok(mounts[0].endsWith("/claim/ctx:/ctx:ro") && mounts[1].endsWith("/out"), mounts.join(" "));
  assert.match(b, /--output type=docker,name=vyre-pub\/northwind:0123456789abcdef,dest=\/out\/image\.tar/);
  assert.ok(!b.includes(path.join(r.F, "lend")), "no path of the daemon's is on the build's command line");
  assert.ok(!fs.existsSync(path.join(r.priv, "pub", DEP, "out")), "the build's folder is gone");
  // the judging ran in the recorded image, unprivileged and cut off, with the context read-only
  const calls = r.calls();
  assert.match(calls, /run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 .* -v .*\/claim\/ctx:\/ctx:ro --entrypoint node sha256:/);
  assert.ok(read(path.join(r.F, "pubplans")).includes("check northwind 8080 512 0.5 256 / 200+404 60"));
});

test("pub-build refuses what the daemon's own rules refuse, and what is not a plain folder, and says so without touching Docker's build", opts, async t => {
  const r = await ready(t);
  const refused = async (/** @type {any} */ st, /** @type {RegExp} */ words, /** @type {string} */ why) => { assert.equal(st.state, "failed", why + " " + JSON.stringify(st)); assert.match(st.message, words, why); };
  const builds = () => (fs.existsSync(path.join(r.F, "pub-builds")) ? read(path.join(r.F, "pub-builds")).trim().split("\n").filter(Boolean).length : 0);
  await refused(await r.build(DEP, { files: { "Dockerfile": "FROM evil.example/x\nEXPOSE 80\n" } }), /starts from evil\.example\/x/, "a base that is not allowed");
  await refused(await r.build(DEP, { files: { "Dockerfile": "# syntax=evil/x\nFROM alpine\n" } }), /build frontend/, "a syntax line");
  await refused(await r.build(DEP, { files: { "Dockerfile": "FROM alpine\nCOPY --from=evil.example/x /a /a\n" } }), /takes files from/, "a copy from another image");
  await refused(await r.build(DEP, { files: { "index.html": "x" } }), /no Dockerfile/, "no Dockerfile");
  await refused(await r.build(DEP, { files: r.GOOD, request: REQUEST({ name: "documents" }) }), /documents is the name of an app that ships with Vyre/, "a catalog name");
  await refused(await r.build(DEP, { files: r.GOOD, request: REQUEST({ name: "www" }) }), /keeps for itself/, "a reserved name");
  await refused(await r.build(DEP, { files: r.GOOD, request: REQUEST({ mem: "4096" }) }), /memoryMb is at most 2048/, "memory past the ceiling");
  await refused(await r.build(DEP, { files: r.GOOD, request: REQUEST({ extra: "1" }) }), /a setting this helper does not know/, "an unknown setting");
  await refused(await r.build(DEP, { files: r.GOOD, request: REQUEST({ port: "99999" }) }), /port is not one/, "a bad port");
  await refused(await r.build(DEP, { files: r.GOOD, request: "name=northwind\nname=other\n" }), /given twice/, "a setting twice");
  await refused(await r.build(DEP, { files: r.GOOD, request: REQUEST({ health_path: "/a b" }) }), /health path is not a path/, "a health path with a space");
  await refused(await r.build(DEP, { files: r.GOOD, request: null }), /settings are missing/, "no settings");
  await refused(await r.build(DEP, { files: r.GOOD, request: "name=northwind\n" }), /a setting is missing/, "missing settings");
  assert.equal(builds(), 0, "nothing was built for a refusal");
  // what is not a plain folder
  const d = r.write(DEP, { files: r.GOOD });
  fs.symlinkSync("/etc/passwd", path.join(d, "ctx", "leak"));
  await refused(await r.ask(`pub-build ${DEP}`), /not a plain file or folder/, "a link in the context");
  const d2 = r.write(DEP, { files: r.GOOD });
  fs.linkSync(path.join(d2, "ctx", "server.js"), path.join(d2, "ctx", "again.js"));
  await refused(await r.ask(`pub-build ${DEP}`), /second link/, "a hard link");
  const d3 = r.write(DEP, { files: r.GOOD });
  fs.writeFileSync(path.join(d3, "extra"), "x");
  await refused(await r.ask(`pub-build ${DEP}`), /more than a build context/, "a stray entry");
  fs.rmSync(path.join(r.servers, DEP), { recursive: true, force: true });
  await refused(await r.ask(`pub-build ${DEP}`), /no such server folder/, "no folder");
  // a folder that is a link to somewhere else is not the daemon's folder
  const other = path.join(r.F, "elsewhere"); fs.mkdirSync(path.join(other, "ctx"), { recursive: true });
  fs.symlinkSync(other, path.join(r.servers, DEP));
  await refused(await r.ask(`pub-build ${DEP}`), /not where it should be|no such server folder/, "a link for the folder");
  assert.equal(builds(), 0);
  // a failed build says why in its own last lines and leaves no record
  r.flag("build-fails");
  fs.rmSync(path.join(r.servers, DEP), { force: true });
  const bad = await r.build();
  assert.equal(bad.state, "failed");
  assert.match(bad.message, /^the build failed: .*npm ci/);
  assert.ok(!fs.existsSync(r.rec()));
  r.flag("build-fails", "");
  fs.rmSync(path.join(r.F, "build-fails"));
  r.flag("load-fails");
  assert.match((await r.build()).message, /image could not be loaded/);
  fs.rmSync(path.join(r.F, "load-fails"));
});

test("a request that is not a deployment id is refused before anything is claimed; only the four verbs exist", opts, async t => {
  const r = await ready(t);
  r.write(DEP, { files: r.GOOD });
  for (const line of ["pub-build ../../etc", "pub-build dep_xyz", "pub-build dep_0123456789ABCDEF", "pub-build dep_0123456789abcdef extra", "pub-up spc_abcdefghijkl", "pub-nuke dep_0123456789abcdef", "pub-build documents"]) {
    const st = await r.ask(line);
    assert.equal(st.state, "failed", line);
    assert.match(st.message, /refused: not a request the helper knows|not a request the helper knows/, line);
  }
  assert.ok(fs.existsSync(path.join(r.servers, DEP)), "the folder was not touched");
});

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
  assert.equal(read(path.join(d, "pubdep")).trim(), DEP);
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
  const pos = [/compose .*vyre-app-northwind.* create/, /network connect --alias vyre-daemon vyre-app-northwind_net/, /-I OUTPUT 1 .*vyre-app:northwind/, /-I INPUT 1 .*-j DROP/, /compose .*vyre-app-northwind.* up -d/, /fetch\(/].map(at);
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
  const up2 = await r.up(DEP2, {});
  assert.equal(up2.state, "ok", JSON.stringify(up2));
  assert.equal(read(path.join(r.priv, "apps", "northwind", "pubdep")).trim(), DEP2);
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

test("the pinned BuildKit the helper runs is the one the daemon's builder names, and the catalog verbs still refuse a published name", opts, async t => {
  const src = read(new URL("../box/vyre", import.meta.url).pathname);
  assert.ok(src.includes(`PUB_BUILDKIT="${BUILDKIT}"`), "one image, named in two places and kept equal here");
  const r = await ready(t);
  await r.build(); await r.up();
  const st = await r.ask("app-up northwind");
  assert.equal(st.state, "failed");
  assert.match(st.message, /no such app/);
});
