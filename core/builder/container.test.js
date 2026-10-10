// @ts-check
// The container path of the builder (team/contracts/builder.md): which Dockerfile is allowed, the port, how the build is asked to run, and a build with the process runner stood in. The real build
// (rootless BuildKit, a real image) is core/appmods/published-live.test.js.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import builder, { seam, HEALTH } from "./index.js";
import { checkDockerfile, fromAllowed, instructions, buildArgv, secretsOf, buildImage, BUILDKIT } from "./container.js";
// the Dockerfile path is switched off in the test release unless this is set (core/builder/index.js planOf); these tests are about that path
process.env.VYRE_PUBLISH_SERVERS = "1";

const OK = "FROM node:22-alpine AS build\nWORKDIR /app\nCOPY . .\nRUN npm ci\nFROM node:22-alpine\nCOPY --from=build /app /app\nEXPOSE 8080/tcp\nCMD [\"node\", \"server.js\"]\n";
const refused = (/** @type {string} */ text, /** @type {RegExp} */ words, /** @type {any} */ o) => assert.throws(() => checkDockerfile(text, o), (/** @type {any} */ e) => { assert.equal(e.code, "refused"); assert.match(e.message, words); return true; });

test("a Dockerfile starts from official images or the registries the owner allowed, and from nothing a build argument chooses", () => {
  assert.deepEqual(checkDockerfile(OK), { port: 8080, froms: ["node:22-alpine", "node:22-alpine"] });
  for (const ref of ["alpine", "node:22", "library/nginx:1.27", "python:3.12-slim", "scratch", "debian@sha256:" + "a".repeat(64), "NGINX:Latest"]) assert.equal(fromAllowed(ref, new Set(), []), true, ref);
  for (const ref of ["ghcr.io/evil/img:1", "evil.example/x", "someone/thing:2", "localhost:5000/x", "$BASE", "node:${V}", "-x", ""]) assert.equal(fromAllowed(ref, new Set(), []), false, ref);
  assert.equal(fromAllowed("ghcr.io/vyre-ai/base:1", new Set(), ["ghcr.io/vyre-ai/"]), true, "an allowed registry prefix");
  assert.equal(fromAllowed("ghcr.io/vyre-ai.evil/base", new Set(), ["ghcr.io/vyre-ai/"]), false, "a prefix is a prefix, not a lookalike");
  refused("FROM evil.example/x\nEXPOSE 80", /starts from evil\.example\/x, which is not allowed/);
  refused("ARG B=node\nFROM $B\nEXPOSE 80", /not allowed/);
  refused("EXPOSE 80", /no FROM line/);
  refused("FROM", /no image|no FROM/);
});

test("an image or a frontend pulled in sideways is held to the same rule: COPY --from, RUN --mount from, and # syntax=", () => {
  refused("FROM alpine\nCOPY --from=evil.example/x /a /a\nEXPOSE 80", /takes files from evil\.example\/x/);
  refused("FROM alpine\nRUN --mount=type=bind,from=evil.example/x,target=/m true\nEXPOSE 80", /takes files from evil\.example\/x/);
  refused("# syntax=evil.example/frontend:1\nFROM alpine\nEXPOSE 80", /build frontend/);
  refused("#syntax = docker/dockerfile:1\nFROM alpine", /build frontend/);
  assert.equal(checkDockerfile("FROM alpine AS a\nFROM alpine\nCOPY --from=a /x /x\nEXPOSE 3000").port, 3000, "an earlier stage is fine");
  assert.equal(checkDockerfile("FROM alpine\nRUN --mount=type=cache,target=/root/.cache true\nEXPOSE 3000").port, 3000, "a cache mount is fine");
  assert.equal(checkDockerfile("FROM alpine\n# EXPOSE 1\nEXPOSE \\\n 9090\n").port, 9090, "comments are not instructions and a continued line is one");
  assert.equal(checkDockerfile("FROM alpine\n").port, null);
  assert.deepEqual(instructions("RUN a \\\n  && b\n# c\n\nCMD x"), ["RUN a  && b", "CMD x"]);
});

test("the build runs rootless, with the context and the secrets read-only and nothing else of the server mounted", () => {
  const a = buildArgv({ ctx: "/tmp/c/ctx", secrets: "/tmp/c/secrets", secretIds: ["npm_token"], tag: "vyre-pub-x:1", name: "vyre-build-test" });
  assert.deepEqual(a.slice(0, 3), ["run", "--rm", "--name"]);
  assert.ok(a.includes(BUILDKIT) && /rootless@sha256:[0-9a-f]{64}$/.test(BUILDKIT), "the pinned rootless image");
  assert.ok(a.join(" ").includes("--cap-drop ALL --cap-add SETUID --cap-add SETGID"), "everything dropped but the two a user namespace needs");
  assert.ok(a.join(" ").includes("--cap-drop ALL") && a.join(" ").includes("--memory 2g") && a.join(" ").includes("--pids-limit 1024"));
  const mounts = a.flatMap((x, i) => (a[i - 1] === "-v" ? [x] : []));
  assert.deepEqual(mounts, ["/tmp/c/ctx:/ctx:ro", "/tmp/c/secrets:/bsecrets:ro"]);
  assert.ok(!a.includes("--privileged") && !a.some(x => /docker\.sock/.test(x)), "no privilege and no Docker socket");
  assert.ok(a.join(" ").includes("--secret id=npm_token,src=/bsecrets/npm_token"));
  assert.ok(a.join(" ").includes("--output type=docker,name=vyre-pub-x:1"));
  assert.ok(!buildArgv({ ctx: "/c", tag: "t" }).some(x => x.includes("bsecrets")), "no secrets, no secrets mount");
  assert.deepEqual(secretsOf(["--secret", "id=npm_token,src=/p/x/npm_token", "--secret=id=b,src=/p/b", "junk", "--secret", "id=../x"]), [{ id: "npm_token", src: "/p/x/npm_token" }, { id: "b", src: "/p/b" }]);
});

test("buildImage writes the files it was given into a context, passes secrets by id, and answers the image id; its failures say what happened", async t => {
  /** @type {any} */ let seen = null;
  /** @type {string[][]} */ const inspected = [];
  const fakeRun = async (/** @type {string[]} */ argv) => { inspected.push(argv); return { code: 0, stdout: "sha256:" + "b".repeat(64) + "\n", stderr: "" }; };
  const sec = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sec-")), "tok"); fs.writeFileSync(sec, "s3cret-value");
  t.after(() => fs.rmSync(path.dirname(sec), { recursive: true, force: true }));
  const r = await buildImage({
    files: [{ path: "Dockerfile", content: Buffer.from(OK) }, { path: "src/a.js", content: "x" }], tag: "vyre-pub-x:1", secretArgs: ["--secret", `id=tok,src=${sec}`], run: fakeRun,
    pipeline: async argv => {
      const ctx = argv[argv.indexOf("-v") + 1].split(":")[0], sd = argv[argv.lastIndexOf("-v") + 1].split(":")[0];
      seen = { ctx: fs.readdirSync(ctx).sort(), nested: fs.readdirSync(path.join(ctx, "src")), secret: fs.readFileSync(path.join(sd, "tok"), "utf8"), argv, ctxPath: ctx };
      return { code: 0, stderr: "#1 ok\n#2 DONE", loaded: "Loaded image: vyre-pub-x:1" };
    },
  });
  assert.deepEqual([seen.ctx, seen.nested, seen.secret], [["Dockerfile", "src"], ["a.js"], "s3cret-value"]);
  assert.equal(r.image, "sha256:" + "b".repeat(64));
  assert.ok(!r.logs.includes("s3cret-value"));
  assert.equal(fs.existsSync(seen.ctxPath), false, "the temporary context is removed");
  assert.deepEqual(inspected[0].slice(0, 3), ["image", "inspect", "vyre-pub-x:1"]);
  await assert.rejects(buildImage({ files: [{ path: "../x", content: "a" }], tag: "t", run: fakeRun, pipeline: async () => ({ code: 0, stderr: "", loaded: "" }) }), /leaves the folder/);
  await assert.rejects(buildImage({ files: [{ path: "Dockerfile", content: "FROM a" }], tag: "t", run: fakeRun, pipeline: async () => ({ code: 1, stderr: "#5 RUN npm ci\nnpm ERR! 404", loaded: "" }) }), (/** @type {any} */ e) => { assert.equal(e.code, "build_failed"); assert.match(e.message, /the build failed:\n.*npm ERR! 404/s); return true; });
  await assert.rejects(buildImage({ files: [{ path: "Dockerfile", content: "FROM a" }], tag: "t", run: fakeRun, pipeline: async () => ({ code: 127, stderr: "", loaded: "" }) }), (/** @type {any} */ e) => { assert.equal(e.code, "not_available"); assert.match(e.message, /Docker is not available/); return true; });
  await assert.rejects(buildImage({ files: [{ path: "Dockerfile", content: "FROM a" }], tag: "t", run: async () => ({ code: 1, stdout: "", stderr: "" }), pipeline: async () => ({ code: 0, stderr: "", loaded: "" }) }), /not in the container store/);
});

// ---- builder.build over the folder reader, with the image build stood in
const tmp = (/** @type {import("node:test").TestContext} */ t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-builder-c-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
async function tool(/** @type {import("node:test").TestContext} */ t, config = {}) {
  const tools = new Map();
  const mod = await builder.start({ config, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d) });
  t.after(() => { seam.buildImage = null; return mod.stop(); });
  return (/** @type {any} */ deployment, secretArgs = []) => tools.get("builder.build").run({ deployment, secretArgs });
}
const dep = (/** @type {string} */ ref, /** @type {any} */ build = {}) => ({ id: "dep_a", name: "northwind", source: { kind: "folder", ref }, build: { command: "", output_dir: ".", image: "dockerfile", ...build } });

test("a folder with a Dockerfile builds to an image: no files, the image id, the port, the health it is held to, and the same folder is the same digest", async t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "Dockerfile"), OK); fs.writeFileSync(path.join(d, "server.js"), "x"); fs.writeFileSync(path.join(d, ".env"), "KEY=nope");
  /** @type {any[]} */ const asked = [];
  seam.buildImage = async p => { asked.push({ files: p.files.map(f => f.path), tag: p.tag, secretArgs: p.secretArgs }); return { image: "sha256:" + "c".repeat(64), logs: "#3 DONE" }; };
  const build = await tool(t);
  const r = await build(dep(d), ["--secret", "id=a,src=/p/a"]);
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.runtime, { kind: "image", image: "sha256:" + "c".repeat(64), port: 8080, health: { path: "/", ok: [...HEALTH.ok] } });
  assert.deepEqual(asked[0].files, ["Dockerfile", "server.js"], "the .env is not in the build context");
  assert.match(asked[0].tag, /^vyre-pub-northwind:[0-9a-f]{16}$/);
  assert.deepEqual(asked[0].secretArgs, ["--secret", "id=a,src=/p/a"]);
  assert.match(r.logs, /Built an image from 2 files of .*left out: \.env/);
  assert.ok(!r.logs.includes(d), "the log names the folder, not its path on the disk");
  const again = await build(dep(d));
  assert.equal(again.digest, r.digest);
  assert.equal((await build(dep(d, { port: 3000 }))).runtime.port, 3000, "build.port wins over EXPOSE");
});

test("what a Dockerfile build cannot do is refused in words: no Dockerfile, no port, a base that is not allowed, no Docker", async t => {
  const d = tmp(t);
  let built = 0;
  seam.buildImage = async () => { built++; return { image: "sha256:" + "d".repeat(64), logs: "" }; };
  const build = await tool(t, { builder: { from: ["ghcr.io/vyre-ai/"] } });
  fs.writeFileSync(path.join(d, "index.html"), "<p>x</p>");
  await assert.rejects(build(dep(d)), /no Dockerfile at its top/);
  fs.writeFileSync(path.join(d, "Dockerfile"), "FROM nginx\n");
  await assert.rejects(build(dep(d)), /name the port/);
  fs.writeFileSync(path.join(d, "Dockerfile"), "FROM evil.example/x\nEXPOSE 80\n");
  await assert.rejects(build(dep(d)), /not allowed here/);
  fs.writeFileSync(path.join(d, "Dockerfile"), "FROM ghcr.io/vyre-ai/base:1\nEXPOSE 80\n");
  assert.equal((await build(dep(d))).runtime.port, 80, "the owner's allowed registry");
  assert.equal(built, 1, "nothing was built for a refused Dockerfile");
  await assert.rejects(build({ ...dep(d), source: { kind: "repo", ref: "https://x.test/r.git" } }), /container builder, which is not installed/);
});

test("on a server that builds through its host helper: the context and the settings go into the deployment's folder, `pub-build <deployment>` is asked, and the answer is the image id; a build secret is refused; the folder is removed", async t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "Dockerfile"), OK); fs.writeFileSync(path.join(d, "server.js"), "x"); fs.writeFileSync(path.join(d, ".env"), "KEY=nope");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const SPC = "spc_abcdefghijkl", DEP = "dep_0123456789abcdef";
  /** @type {any[]} */ const asked = [];
  seam.helper = { present: () => true, ask: /** @type {any} */ (async (/** @type {string} */ verb, /** @type {string} */ name, /** @type {any} */ o) => {
    const dir = path.join(home, "publish", SPC, "servers", name);
    asked.push({ verb, name, o, files: fs.readdirSync(path.join(dir, "ctx")).sort(), request: fs.readFileSync(path.join(dir, "request"), "utf8") });
    return { state: "ok", message: "built sha256:" + "9".repeat(64) };
  }) };
  const tools = new Map();
  const mod = await builder.start({ config: {}, paths: { root: home }, tool: (/** @type {string} */ n, /** @type {any} */ def) => tools.set(n, def) });
  t.after(() => { seam.helper = null; return mod.stop(); });
  const build = (/** @type {string[]} */ secretArgs = []) => tools.get("builder.build").run({ deployment: { id: DEP, space: SPC, name: "northwind", version: 3, source: { kind: "folder", ref: d }, build: { command: "", output_dir: ".", image: "dockerfile" } }, secretArgs });
  const r = await build();
  assert.deepEqual(r.runtime, { kind: "image", image: "sha256:" + "9".repeat(64), port: 8080, health: { path: "/", ok: [...HEALTH.ok] } });
  assert.deepEqual([asked[0].verb, asked[0].name, asked[0].files], ["pub-build", DEP, ["Dockerfile", "server.js"]], "the .env is not in the context");
  assert.match(asked[0].request, /^name=northwind\nversion=3\nport=8080\nmem=512\n/);
  assert.ok(asked[0].o.timeoutMs >= 15 * 60_000);
  assert.ok(!fs.existsSync(path.join(home, "publish", SPC, "servers", DEP)), "the folder is removed");
  await assert.rejects(build(["--secret", "id=a,src=/p/a"]), /build secrets are not supported/);
  seam.helper = { present: () => true, ask: /** @type {any} */ (async () => ({ state: "ok", message: "built something" })) };
  await assert.rejects(build(), /did not say which/);
  seam.helper = { present: () => true, ask: /** @type {any} */ (async () => { throw Object.assign(new Error("the server could not pub-build this site's image: the build failed: npm ERR"), { code: "failed" }); }) };
  await assert.rejects(build(), (/** @type {any} */ e) => { assert.equal(e.code, "build_failed"); assert.match(e.message, /npm ERR/); return true; });
  assert.ok(!fs.existsSync(path.join(home, "publish", SPC, "servers", DEP)), "and nothing is left after a failure");
});
