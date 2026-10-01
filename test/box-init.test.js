// @ts-check
// One init in the box (ADR 0029, R4): the image's tini is PID 1, so it reaps and it keeps the
// dtach terminals once vyred is gone. A compose `init: true` on a service that runs the vyre image
// would put docker-init in front of it and make tini a second init. The runtime check (PID 1 is
// tini in a booted container) is ci's box-image smoke; this guards the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = f => fs.readFileSync(path.join(REPO, f), "utf8");

/** Services in a compose file, each with its own lines (two-space indent under `services:`). */
function services(text) {
  const out = {};
  const body = text.split(/^services:\s*$/m)[1] || "";
  let name = null;
  for (const line of body.split("\n")) {
    if (/^\S/.test(line)) break;
    const m = /^  ([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = []; continue; }
    if (name) out[name].push(line);
  }
  return out;
}

test("box: the image's ENTRYPOINT is tini, and its CMD the spawner, which runs the vyred restart loop as vyre", () => {
  const df = read("box/Dockerfile");
  assert.match(df, /^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m);
  // ADR 0032: the spawner (root, capabilities dropped) runs core/daemon/loop.sh as uid vyre.
  assert.match(df, /^CMD \["node", "\/opt\/vyre\/core\/spawner\/main\.js"\]$/m);
  assert.match(read("core/spawner/main.js"), /daemon", "loop\.sh"/);
  assert.match(df, /apt-get install[^\n]*\btini\b/);
});

for (const f of ["box/compose.yml", "box/compose.egress.yml"]) {
  test(`box: no service on the vyre image in ${f} sets init: true, so tini is PID 1`, () => {
    const all = services(read(f));
    const onVyre = Object.entries(all).filter(([, lines]) => lines.some(l => /^\s+image:.*vyre-ai\/vyre/.test(l)));
    assert.ok(onVyre.length > 0, "found the services that run the vyre image");
    for (const [name, lines] of onVyre) assert.ok(!lines.some(l => /^\s+init:\s*true/.test(l)), `${name} sets init: true`);
  });
}

test("box: the image reads the Agent SDK pin from a file that loads on its own", () => {
  // The build copies one file to /tmp and imports it, before the rest of Vyre is in the image.
  const df = read("box/Dockerfile");
  assert.match(df, /^COPY core\/sessions\/sdk-pin\.js \/tmp\/vyre-sdk\.mjs$/m);
  assert.doesNotMatch(read("core/sessions/sdk-pin.js"), /^\s*(import|export .* from)\b/m);
});

test("box: the docker-api bearer's folder is vyre's own in the image, so its new volume mounts that way", () => {
  // A named volume takes its mount point's owner and mode from the image on first mount. With no
  // such folder in the image it mounts root-owned, and vyred (uid 1000) cannot write the bearer:
  // the computers module failed to start on a real stack (e2e, 28 Sep). 700 keeps vyre-agent out.
  const df = read("box/Dockerfile");
  assert.match(df, /mkdir -p \/var\/lib\/vyre-secrets && chown 1000:1000 \/var\/lib\/vyre-secrets && chmod 700 \/var\/lib\/vyre-secrets/);
  const compose = read("box/compose.yml");
  assert.match(compose, /docker-api-bearer:\/var\/lib\/vyre-secrets\n/, "vyre mounts it read-write");
  assert.match(compose, /docker-api-bearer:\/var\/lib\/vyre-secrets:ro/, "docker-api mounts it read-only");
});
