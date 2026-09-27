// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tempHome } from "../../test/helpers.js";
import { build, label, swWithBuild } from "./build.js";
import { start } from "./index.js";
import { request, call } from "./client.js";

const pkg = dir => fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "vyre", version: "9.9.9" }));

test("build: a release's stamp wins, a checkout asks git, and neither is nulls", t => {
  const stamped = tempHome(t);
  pkg(stamped);
  fs.writeFileSync(path.join(stamped, "build.json"), JSON.stringify({ version: "9.9.9", commit: "1a2b3c4d5e6f", dirty: false }));
  assert.deepEqual(build(stamped), { version: "9.9.9", commit: "1a2b3c4d5e6f", dirty: false, stamped: true });
  assert.equal(label(build(stamped)), "9.9.9 · 1a2b3c4");

  const checkout = tempHome(t);
  pkg(checkout);
  const git = (...a) => execFileSync("git", ["-C", checkout, "-c", "user.name=alex", "-c", "user.email=alex@example.com", ...a], { stdio: "pipe" }).toString().trim();
  git("init", "-q"); git("add", "package.json"); git("commit", "-qm", "one");
  const head = git("rev-parse", "HEAD");
  assert.deepEqual(build(checkout), { version: "9.9.9", commit: head, dirty: false });
  fs.appendFileSync(path.join(checkout, "package.json"), "\n");
  assert.equal(build(checkout).dirty, true);
  assert.equal(label(build(checkout)), `9.9.9 · ${head.slice(0, 7)}+dirty`);

  const bare = tempHome(t);
  pkg(bare);
  assert.deepEqual(build(bare), { version: "9.9.9", commit: null, dirty: null });
  assert.equal(label(build(bare)), "9.9.9");
});

test("build: /v1/health and system.info report version and commit", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [] }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const h = (await request("GET", "/v1/health", undefined, { root })).data;
  const i = (await call("system.info", {}, { root })).data;
  const b = build();
  assert.deepEqual([h.version, h.commit, h.dirty], [b.version, b.commit, b.dirty]);
  assert.deepEqual([i.version, i.commit, i.dirty], [b.version, b.commit, b.dirty]);
  assert.ok("commit" in h && "commit" in i);
  assert.deepEqual(i.network, { origins: ["https://app.vyre.run"] }, "the hosted app's origin, when config names none");
});

test("build: the Deck's service worker carries the build, so a release is a new sw.js", () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "deck", "sw.js"), "utf8");
  assert.match(src, /const BUILD = "dev";/, "deck/sw.js has the placeholder vyred replaces");
  const a = swWithBuild(src, { version: "0.0.1", commit: "1a2b3c4d5e6f7a8b", dirty: false });
  assert.match(a, /const BUILD = "1a2b3c4d5e6f";/);
  assert.match(swWithBuild(src, { version: "0.0.1", commit: "1a2b3c4d5e6f7a8b", dirty: true }), /const BUILD = "1a2b3c4d5e6f-dirty";/);
  assert.match(swWithBuild(src, { version: "0.0.2", commit: null, dirty: null }), /const BUILD = "v0.0.2";/);
  assert.notEqual(a, swWithBuild(src, { version: "0.0.1", commit: "9f8e7d6c5b4a3210", dirty: false }), "two builds, two service workers");
});
