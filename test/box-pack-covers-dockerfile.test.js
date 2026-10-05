// @ts-check
// box/Dockerfile builds from the pack (`install-box.sh --from` and the release job `npm pack`), so every path its COPY lines read from the
// build context must be in the pack. wink/forwarder was copied by the image (4b78aa958) but missing from package.json "files", and a build
// from a checkout failed. This packs (dry run) and checks each non-stage COPY source.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("box-pack: every COPY source in box/Dockerfile from the build context is in the npm pack", () => {
  const docker = fs.readFileSync(path.join(REPO, "box/Dockerfile"), "utf8").replace(/\\\n/g, " ");
  const sources = [];
  for (const line of docker.split("\n")) {
    const m = /^COPY\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[1].split(/\s+/).filter(Boolean);
    if (parts.some(p => p.startsWith("--from="))) continue;
    const args = parts.filter(p => !p.startsWith("--"));
    for (const src of args.slice(0, -1)) sources.push(src);
  }
  assert.ok(sources.length > 0, "found COPY lines");
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO, encoding: "utf8", maxBuffer: 256 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const files = new Set(JSON.parse(r.stdout)[0].files.map((/** @type {any} */ f) => f.path));
  for (const src of sources) {
    if (src === "." || src === "./") continue;   // the whole pack
    const dir = src.endsWith("/");
    const bare = src.replace(/\/$/, "");
    const hit = files.has(bare) || (dir && [...files].some(f => f.startsWith(bare + "/")));
    assert.ok(hit, `box/Dockerfile copies ${src} but the pack does not carry it (add it to package.json "files")`);
  }
});
