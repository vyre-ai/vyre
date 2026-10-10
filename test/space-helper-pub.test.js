// The root side of a site's server on a server that runs its apps through the host helper, first half: pub-build, the verbs, the pinned BuildKit (team/contracts/builder.md). The rig is test/space-helper-pub-rig.js.
// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { opts } from "./space-helper-rig.js";
import { BUILDKIT } from "../core/builder/container.js";
import { DEP, DEP2, SPC, REQUEST, read, ready } from "./space-helper-pub-rig.js";

test("pub-build: the folder is taken, judged, built by an unprivileged rootless BuildKit with the context read-only, and recorded; the answer is the image id", opts, async t => {
  const r = await ready(t);
  const st = await r.build();
  assert.equal(st.state, "ok", JSON.stringify(st));
  const id = /^built (sha256:[0-9a-f]{64})$/.exec(st.message);
  assert.ok(id, st.message);
  assert.ok(!fs.existsSync(path.join(r.servers, DEP)), "the daemon's folder was taken by rename and is gone");
  assert.equal(fs.statSync(r.rec()).mode & 0o777, 0o600, "root's record is root's alone");
  assert.equal(read(r.rec()).trim(), `northwind vyre-pub/northwind:${DEP.slice(4)} ${id[1]} 8080 512 0.5 256 / 200+404 60 3 - ${SPC}`);
  // the build: the pinned image, the context and the output the only mounts, nothing privileged, only the two capabilities a user namespace needs
  const b = read(path.join(r.F, "pub-builds")).trim();
  assert.ok(b.includes(BUILDKIT));
  assert.ok(/ --cap-drop ALL --cap-add SETUID --cap-add SETGID /.test(b) && !/--privileged|docker\.sock|--network host/.test(b));
  const mounts = b.split(" ").filter((x, i, a) => a[i - 1] === "-v");
  assert.equal(mounts.length, 2);
  assert.ok(mounts[0].endsWith("/build/ctx:/ctx:ro") && mounts[1].endsWith("/out"), mounts.join(" "));
  assert.match(b, /--output type=docker,name=vyre-pub\/northwind:0123456789abcdef,dest=\/out\/image\.tar/);
  assert.ok(!b.includes(path.join(r.F, "lend")), "no path of the daemon's is on the build's command line");
  assert.ok(!fs.existsSync(path.join(r.priv, "pub", DEP, "out")), "the build's folder is gone");
  // the judging ran in the recorded image, unprivileged and cut off, with the context read-only
  const calls = r.calls();
  assert.match(calls, /run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 .* -v .*\/build\/ctx:\/ctx:ro --entrypoint node sha256:/);
  assert.ok(read(path.join(r.F, "pubplans")).includes("check northwind 8080 512 0.5 256 / 200+404 60"));
});

test("pub-build refuses what the daemon's own rules refuse, and what is not a plain folder, and says so without touching Docker's build", opts, async t => {
  const r = await ready(t);
  const refused = async (/** @type {any} */ st, /** @type {RegExp} */ words, /** @type {string} */ why) => { assert.equal(st.state, "failed", why + " " + JSON.stringify(st)); assert.match(st.message, words, why); };
  const builds = () => (fs.existsSync(path.join(r.F, "pub-builds")) ? read(path.join(r.F, "pub-builds")).trim().split("\n").filter(Boolean).length : 0);
  await refused(await r.build(DEP, { files: { "Dockerfile": "FROM evil.example/x\nEXPOSE 80\n" } }), /starts from evil\.example.x/, "a base that is not allowed");
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

test("the pinned BuildKit the helper runs is the one the daemon's builder names, and the catalog verbs still refuse a published name", opts, async t => {
  const src = read(new URL("../box/vyre", import.meta.url).pathname);
  assert.ok(src.includes(`PUB_BUILDKIT="${BUILDKIT}"`), "one image, named in two places and kept equal here");
  const r = await ready(t);
  await r.build(); await r.up();
  const st = await r.ask("app-up northwind");
  assert.equal(st.state, "failed");
  assert.match(st.message, /no such app/);
});

test("the build runs on a network of its own: the metadata address, the private ranges and the host are dropped, public egress is left, and a probe from that network must find them closed (trust row 37)", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP)).state, "ok");
  const calls = r.calls();
  assert.match(fs.readFileSync(path.join(r.F, "pubnet-create"), "utf8"), /network create --driver bridge --opt com\.docker\.network\.bridge\.name=vyrepub0 --opt com\.docker\.network\.bridge\.enable_icc=false --label run\.vyre=1 vyre-pub-build/);
  const fw = r.hostFw();
  for (const cidr of ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8"]) {
    assert.ok(fw.some((/** @type {any} */ x) => x.ch === "DOCKER-USER" && x.rule === `-i vyrepub0 -d ${cidr} -j DROP`), `${cidr} is dropped for the build's bridge`);
  }
  assert.ok(fw.some((/** @type {any} */ x) => x.ch === "INPUT" && x.rule === "-i vyrepub0 -j DROP"), "the host itself is dropped");
  assert.ok(!fw.some((/** @type {any} */ x) => /-j ACCEPT/.test(x.rule) && !/--dport 53/.test(x.rule)), "nothing but DNS to the host's own resolvers is accepted: the public internet is left alone, not opened by a rule");
  // the probe asked about the metadata address and the bridge's gateway, and it came before the build
  const probes = fs.readFileSync(path.join(r.F, "pubnet-probes"), "utf8").split("\n").filter(Boolean);
  assert.ok(probes.includes("169.254.169.254") && probes.includes("172.40.0.1"), probes.join(","));
  assert.match(fs.readFileSync(path.join(r.F, "pub-builds"), "utf8"), /--name vyre-pub-build --network vyre-pub-build /, "the build container is on that network");
  assert.ok(calls.indexOf("nc -w 2 -z 169.254.169.254") < calls.indexOf("--name vyre-pub-build") || fs.existsSync(path.join(r.F, "pubnet-probes")), "probed first");
  // a second build reuses the network and its rules
  assert.equal((await r.build(DEP2, { request: REQUEST({ version: "4" }) })).state, "ok");
  assert.equal(fs.readFileSync(path.join(r.F, "pubnet-create"), "utf8").trim().split("\n").length, 1, "the network is made once");
  assert.equal(r.hostFw().length, fw.length, "and the rules are not added again");
});

test("a build whose network can reach the metadata address, or whose rules cannot be added, or whose network is not ours, is refused before any Dockerfile step runs", opts, async t => {
  for (const [flag, value, words] of [["pubnet-leaky", "1", /the build's network can reach 169\.254\.169\.254/], ["hostfw-add-fails", "1", /the build's network rules could not be added/], ["pubnet-bridge", "docker0", /not the one this helper made/]]) {
    const r = await ready(t);
    r.flag(flag, value);
    const st = await r.build(DEP);
    assert.equal(st.state, "failed", `${flag}: ${JSON.stringify(st)}`);
    assert.match(st.message, words);
    assert.ok(!fs.existsSync(path.join(r.F, "pub-builds")), `${flag}: no build container was started`);
  }
});
