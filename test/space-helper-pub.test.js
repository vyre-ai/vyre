// The root side of a site's server on a server that runs its apps through the host helper, first half: pub-build, the verbs, the pinned BuildKit (team/contracts/builder.md). The rig is test/space-helper-pub-rig.js.
// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { opts } from "./space-helper-rig.js";
import { BUILDKIT } from "../core/builder/container.js";
import { DEP, SPC, REQUEST, read, ready } from "./space-helper-pub-rig.js";

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
