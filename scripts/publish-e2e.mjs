#!/usr/bin/env node
// Runs the REAL Publish edge once, on a box with Docker: generates the compose project and Caddyfile from lib/publish/edge.js, starts Caddy and one static workload, and fetches the
// site through Caddy over HTTPS. A dev check, never run on the user's Mac. The only change to the generated Caddyfile is `local_certs` (a throwaway local CA instead of ACME, which a test
// host cannot reach); everything else is what a real Space gets.
//   node scripts/publish-e2e.mjs [--dir /path/to/scratch] [--keep]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { siteTar } from "../lib/publish/site-tar.js";
import { joinPageHtml } from "../lib/publish/join.js";
import { edgeCompose, composeText, caddyfile, caddyDockerfile, IMAGES, serviceName, projectName } from "../lib/publish/edge.js";

const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const dir = path.resolve(arg("dir", fs.mkdtempSync(path.join(os.homedir(), "publish-e2e-"))));
const keep = process.argv.includes("--keep");
const SPACE = { id: "spc_pube2e000001", name: "harlow.vyre.run" };
const DEP = "dep_0123456789abcdef";
const work = [{ id: DEP, kind: "static", name: "northwind", stage: "Production" }];
const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, o = {}) => { const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8", ...o }); return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
const log = (/** @type {string} */ m) => console.log(m);

fs.mkdirSync(dir, { recursive: true });
const compose = edgeCompose(SPACE, work);
fs.writeFileSync(path.join(dir, "docker-compose.yml"), composeText(compose));
const cf = caddyfile([], work, { spaceName: SPACE.name }).replace("admin off", "admin off\n\tlocal_certs");
assert.ok(cf.includes("local_certs"), "the Caddyfile has a global block to put the test CA in");
fs.writeFileSync(path.join(dir, "Caddyfile"), cf);
fs.writeFileSync(path.join(dir, "caddy.Dockerfile"), caddyDockerfile());
fs.writeFileSync(path.join(dir, "join.html"), joinPageHtml());
const project = projectName(SPACE.id), svc = serviceName(DEP);
const vol = `${project}_site-${DEP.replace(/^dep_/, "")}`;
log(`project ${project} in ${dir}`);

try {
  const built = run("docker", ["build", "-t", IMAGES.caddy, "-f", "caddy.Dockerfile", "."]);
  assert.equal(built.code, 0, built.out);
  log(`built ${IMAGES.caddy}`);
  assert.equal(run("docker", ["volume", "create", vol]).code, 0);
  // The site is filled the way Publish fills it: the build's files become a tar of regular files only (lib/publish/site-tar.js), extracted into the volume by a throwaway container with no network.
  const put = (/** @type {string} */ html) => {
    run("docker", ["run", "--rm", "-v", `${vol}:/srv`, "alpine:3", "sh", "-c", "rm -rf /srv/* /srv/.[!.]*"]);
    const tar = Buffer.from(siteTar([{ path: "index.html", content: html }, { path: ".hidden", content: "secret" }, { path: "sub/page.html", content: "<p>page</p>" }]));
    return run("docker", ["run", "--rm", "-i", "--network", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "-v", `${vol}:/srv`, "alpine:3", "tar", "x", "-C", "/srv"], { input: tar });
  };
  // links never get that far: each one is refused before an archive exists
  for (const evil of [{ path: "p", type: "symlink", target: "/etc/passwd", content: "" }, { path: "e", symlink: ".env", content: "" }, { path: "g", symlink: "sub/.git/config", content: "" }, { path: "pe", symlink: "/proc/self/environ", content: "" }, { path: "sec", symlink: "/run/secrets/NAME", content: "" }]) {
    assert.throws(() => siteTar([{ path: "index.html", content: "x" }, evil]), /link|only regular files/, evil.path);
  }
  log("links to .env, .git/config, /etc/passwd, /proc/self/environ and /run/secrets/NAME refused before any archive");
  assert.equal(put("<h1>Northwind v1</h1>").code, 0);
  const up = run("docker", ["compose", "-p", project, "up", "-d", "--no-deps", "caddy", svc]);
  log(up.out.trim().split("\n").slice(-6).join("\n"));
  assert.equal(up.code, 0, up.out);
  let body = "", headers = "";
  for (let i = 0; i < 30; i++) {
    const r = run("curl", ["-sk", "-D", "-", "--resolve", "northwind.harlow.vyre.run:443:127.0.0.1", "https://northwind.harlow.vyre.run/"]);
    if (r.out.includes("Northwind v1")) { headers = r.out; body = r.out; break; }
    run("sleep", ["1"]);
  }
  assert.ok(body.includes("<h1>Northwind v1</h1>"), `the site was not served through Caddy:\n${body}`);
  log("served: Northwind v1 through Caddy over HTTPS (local CA)");
  const h = headers.toLowerCase();
  for (const x of ["strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy"]) assert.ok(h.includes(x), `header ${x}`);
  assert.ok(!/^server:/m.test(h), "no Server header");
  log("security headers present, no Server header");
  const other = run("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", "--resolve", "unknown.harlow.vyre.run:443:127.0.0.1", "https://unknown.harlow.vyre.run/"]);
  log(`unknown host answers: ${other.out}`);
  assert.notEqual(other.out, "200", "an unknown host is not served");
  const dot = run("curl", ["-sk", "--resolve", "northwind.harlow.vyre.run:443:127.0.0.1", "https://northwind.harlow.vyre.run/.hidden"]);
  assert.ok(!dot.out.includes("secret"), "a dotfile is served");
  const dotCode = run("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", "--resolve", "northwind.harlow.vyre.run:443:127.0.0.1", "https://northwind.harlow.vyre.run/.hidden"]);
  assert.equal(dotCode.out, "404");
  log("dotfiles answer 404");
  // the join page on the space's own name
  const J = "harlow.vyre.run", tok = "eyJhIjoxfQ.c2lnbmF0dXJl";
  const join = run("curl", ["-sk", "-D", "-", "--resolve", `${J}:443:127.0.0.1`, `https://${J}/join/${tok}`]);
  assert.ok(/^HTTP\/\S+ 200/m.test(join.out) && join.out.includes("Open in Vyre") && /content-type: text\/html/i.test(join.out), join.out.slice(0, 400));
  assert.ok(/referrer-policy: no-referrer/i.test(join.out) && /content-security-policy: default-src 'none'/i.test(join.out) && /cache-control: no-store/i.test(join.out), "join page headers");
  assert.ok(!join.out.includes(tok), "the page never carries the token");
  const notJoin = run("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", "--resolve", `${J}:443:127.0.0.1`, `https://${J}/other`]);
  const badTok = run("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", "--resolve", `${J}:443:127.0.0.1`, `https://${J}/join/nodot`]);
  assert.deepEqual([notJoin.out, badTok.out], ["404", "404"]);
  const logs = run("docker", ["logs", `${project}-caddy-1`]).out;
  assert.ok(logs.includes("/join/redacted") && !logs.includes(tok), "the access log keeps the join token");
  log("join page served on the space's name, other paths 404, token not in the access log");
  // a new version replaces the old: what rollback does is put the previous bytes back
  assert.equal(put("<h1>Northwind v2</h1>").code, 0);
  const v2 = run("curl", ["-sk", "--resolve", "northwind.harlow.vyre.run:443:127.0.0.1", "https://northwind.harlow.vyre.run/"]);
  assert.ok(v2.out.includes("v2"), v2.out);
  assert.equal(put("<h1>Northwind v1</h1>").code, 0);
  const back = run("curl", ["-sk", "--resolve", "northwind.harlow.vyre.run:443:127.0.0.1", "https://northwind.harlow.vyre.run/"]);
  assert.ok(back.out.includes("v1"), back.out);
  log("v2 served, then v1 again (rolled back)");
  log("PUBLISH EDGE OK");
} finally {
  if (!keep) { log(run("docker", ["compose", "-p", project, "down", "-v", "--remove-orphans"]).out.trim().split("\n").slice(-3).join("\n")); run("docker", ["volume", "rm", "-f", vol]); fs.rmSync(dir, { recursive: true, force: true }); }
}
