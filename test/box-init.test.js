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

test("box: the image's ENTRYPOINT is tini, and its CMD the vyred restart loop", () => {
  const df = read("box/Dockerfile");
  assert.match(df, /^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m);
  assert.match(df, /^CMD \["\/opt\/vyre\/core\/daemon\/loop\.sh"\]$/m);
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
