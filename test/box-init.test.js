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
  // The watcher wall's entry script runs first and replaces itself with the spawner (core/spawner/wall-entry.sh).
  assert.match(df, /^CMD \["\/bin\/sh", "\/opt\/vyre\/core\/spawner\/wall-entry\.sh"\]$/m);
  assert.match(read("core/spawner/wall-entry.sh"), /exec \/usr\/bin\/setpriv --bounding-set=-net_admin "\$node_bin" "\$here\/main\.js"/);
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

test("box: the watcher wall: iptables is in the image, NET_ADMIN is the vyre service's alone, and the entry script drops it before the spawner serves", () => {
  const df = read("box/Dockerfile");
  assert.match(df, /apt-get install[^\n]*\biptables\b/);
  const all = services(read("box/compose.yml"));
  const capsOf = name => (all[name] || []).filter(l => /cap_add|NET_ADMIN|SETPCAP|SETUID/.test(l)).join("\n");
  assert.match(capsOf("vyre"), /cap_add: \[SETUID, SETGID, KILL, NET_ADMIN, SETPCAP\]/);
  for (const name of Object.keys(all)) if (name !== "vyre" && name !== "tailscale") assert.ok(!/NET_ADMIN|SETPCAP/.test(capsOf(name)), `${name} must not hold NET_ADMIN or SETPCAP`);
  // The step order: install and probe first, then the drop, then the spawner; a container that cannot drop does not run watchers.
  const entry = read("core/spawner/wall-entry.sh");
  assert.ok(entry.indexOf("wall.js") < entry.indexOf("--bounding-set=-net_admin"), "the wall is installed before NET_ADMIN is dropped");
  assert.match(entry, /could not drop NET_ADMIN, so no watcher will be started/);
  // vyred starts under setpriv --inh-caps=-all as uid vyre: no capability reaches it.
  assert.match(read("core/spawner/main.js"), /"--inh-caps=-all", "--",\s*\n?\s*"\/bin\/sh", "-c", 'umask 002; exec "\$@"', "sh", "\/bin\/sh", LOOP/);
});

test("box: /work is closed to every uid but vyre and the shared group (2770), in the image and for a volume made before", () => {
  assert.match(read("box/Dockerfile"), /chown 1000:1002 \/work && chmod 2770 \/work/);
  assert.match(read("core/spawner/main.js"), /chmod", "o-rwx", WORK/);
});

test("box: every base image a Dockerfile builds from is pinned by digest (FROM and COPY --from), so a source build cannot be handed other bytes", () => {
  for (const f of ["box/Dockerfile", "core/computers/image/Dockerfile"]) {
    const text = read(f);
    const refs = [...text.matchAll(/^FROM\s+(\S+)/gm)].map(m => m[1]).concat([...text.matchAll(/^COPY\s+--from=(\S+)/gm)].map(m => m[1]));
    assert.ok(refs.length > 0, `${f} has a FROM`);
    for (const r of refs) if (!/^build\d*$|^[a-z]+$/.test(r) || r.includes("/") || r.includes(":")) assert.match(r, /@sha256:[0-9a-f]{64}$/, `${f}: ${r} is not pinned by digest`);
  }
});

// #43: a fresh install starts an agent's computer with no config.json edit. The stack as installed runs the restricted Docker
// proxy and points vyred at it; the driver is picked from that, and a person is told plainly when there is none.
import os from "node:os";
import { load } from "../core/config/index.js";
const defaults = (/** @type {string} */ root) => load(root);
import { pickDriver } from "../core/computers/index.js";
import { NO_DRIVER } from "../core/computers/pool.js";

test("#43: compose runs docker-api by default and gives vyred its address", () => {
  const compose = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "box", "compose.yml"), "utf8");
  const svc = compose.slice(compose.indexOf("\n  docker-api:"), compose.indexOf("\nvolumes:"));
  assert.ok(svc.includes("dockerproxy/main.js") && !/profiles:/.test(svc), "docker-api is not behind a profile");
  assert.match(compose, /VYRE_COMPUTERS_DOCKER=\$\{VYRE_COMPUTERS_DOCKER-http:\/\/docker-api:2375\}/);
});

test("#43: vyred's computers.docker comes from VYRE_COMPUTERS_DOCKER, config.json wins, and no driver says why without naming a file", () => {
  const old = process.env.VYRE_COMPUTERS_DOCKER;
  try {
    process.env.VYRE_COMPUTERS_DOCKER = "http://docker-api:2375";
    process.env.VYRE_COMPUTERS_NETWORK = "vyre-computers"; process.env.VYRE_COMPUTERS_LABEL_PREFIX = "run.vyre.computers";
    const c = defaults("/nonexistent-home").computers;
    assert.deepEqual([c.docker, c.network, c.labelPrefix], ["http://docker-api:2375", "vyre-computers", "run.vyre.computers"], "the same values the proxy enforces");
    const bearer = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vyre-43-")), "bearer");
    const d = pickDriver({ ...defaults("/nonexistent-home").computers, dockerBearerFile: bearer }, "k");
    assert.ok(d, "a driver is picked");
    delete process.env.VYRE_COMPUTERS_DOCKER;
    assert.equal(defaults("/nonexistent-home").computers.docker, undefined);
    assert.equal(pickDriver(defaults("/nonexistent-home").computers, "k"), null);
  } finally { delete process.env.VYRE_COMPUTERS_NETWORK; delete process.env.VYRE_COMPUTERS_LABEL_PREFIX; if (old === undefined) delete process.env.VYRE_COMPUTERS_DOCKER; else process.env.VYRE_COMPUTERS_DOCKER = old; }
  assert.ok(!/config\.json|edit/i.test(NO_DRIVER), NO_DRIVER);
});
