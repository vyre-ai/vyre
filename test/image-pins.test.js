import "../scripts/mac-test-guard.mjs";
// @ts-check
// Every container image Vyre runs as root on a box, or builds an edge from, is pinned by digest (reviewer-3 SC-1, SC-2): a moved or hijacked tag must never run over the box's data volumes or become the public edge.
// The two files that name them: core/cli/commands/box.js (backup and restore copy the data volumes) and lib/publish/edge.js (the edge's Caddy and BuildKit, and the Dockerfile of its derived Caddy).
// This reads the files and fails on any image reference in them that is not `name@sha256:<64 hex>` (or `name:tag@sha256:<64 hex>`). A local derived image the box builds itself (vyre-publish-caddy) is exempt.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_IMAGE } from "../core/cli/commands/box.js";
import { IMAGES, caddyDockerfile } from "../lib/publish/edge.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const PINNED = /^[a-z0-9][a-z0-9._\/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;
const LOCAL = /^vyre-publish-[a-z0-9-]+:[0-9.]+$/;

test("the helper image the backup and restore run is pinned by digest, and every docker run in box.js uses it", () => {
  assert.match(HELPER_IMAGE, PINNED);
  const src = read("core/cli/commands/box.js");
  const lines = src.split("\n").filter(l => /docker run/.test(l) && !/^\s*\/\//.test(l));
  assert.equal(lines.length, 3, "the backup and both restore runs are there");
  for (const l of lines) assert.match(l, /docker run .*\$\{HELPER_IMAGE\} tar [xc]zf/, `docker run uses the pinned helper image: ${l.trim().slice(0, 90)}`);
  assert.ok(!/docker run[^`"\n]*\balpine\b(?!:3\.20@)/.test(src.replace(/\$\{HELPER_IMAGE\}/g, "")), "no bare alpine in a docker run");
});

test("the edge's images are pinned by digest: Caddy's base, BuildKit, and every FROM in the derived Caddy's Dockerfile", () => {
  for (const [name, ref] of Object.entries(IMAGES)) assert.ok(PINNED.test(ref) || LOCAL.test(ref), `IMAGES.${name} is pinned by digest or is the box's own derived image: ${ref}`);
  const froms = [...caddyDockerfile().matchAll(/^FROM\s+(\S+)/gim)].map(m => m[1]);
  assert.equal(froms.length, 2, "the derived Caddy builds from the official image and a plain alpine");
  for (const f of froms) assert.match(f, PINNED, `FROM ${f}`);
  // and nothing else in the file names an unpinned image outside a comment
  const code = read("lib/publish/edge.js").split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  for (const m of code.matchAll(/["'`]((?:moby\/)?(?:caddy|alpine|buildkit|busybox|node|nginx|ubuntu|debian)[:@][^"'`\s]*)["'`]/g)) assert.match(m[1], PINNED, `an unpinned image reference in edge.js: ${m[1]}`);
});
