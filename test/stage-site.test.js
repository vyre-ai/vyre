// @ts-check
// A staging copy of the site points the setup page at another relay and install line, and production is left exactly as it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { setupOverrides } from "../site/setup/config.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEADERS = fs.readFileSync(path.join(REPO, "site", "_headers"), "utf8");

function fakeSite(dir) {
  fs.mkdirSync(path.join(dir, "setup", "relay"), { recursive: true });
  fs.writeFileSync(path.join(dir, "_headers"), HEADERS);
  fs.writeFileSync(path.join(dir, "setup", "index.html"), "<html></html>");
  return dir;
}
const run = (args) => spawnSync("sh", [path.join(REPO, "scripts", "stage-site.sh"), ...args], { encoding: "utf8" });

test("stage-site: the copy carries config.json and a CSP that allows the staging relay; the original site is untouched", t => {
  const home = tempHome(t);
  const site = fakeSite(path.join(home, "site")), out = path.join(home, "out");
  const r = run(["--site", site, "--out", out, "--relay", "wss://relay-staging.vyre.run", "--install-url", "https://staging.vyre-site.pages.dev/i"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "setup", "config.json"), "utf8")), { relay: "wss://relay-staging.vyre.run", installUrl: "https://staging.vyre-site.pages.dev/i" });
  const h = fs.readFileSync(path.join(out, "_headers"), "utf8");
  assert.match(h, /connect-src 'self' https:\/\/relay\.vyre\.run wss:\/\/relay\.vyre\.run https:\/\/relay-staging\.vyre\.run wss:\/\/relay-staging\.vyre\.run;/);
  assert.equal(fs.readFileSync(path.join(site, "_headers"), "utf8"), HEADERS, "the built site is not changed");
  assert.ok(!fs.existsSync(path.join(site, "setup", "config.json")));
  // No options: a plain copy with no config.json, so it behaves as production does.
  const plain = path.join(home, "plain");
  assert.equal(run(["--site", site, "--out", plain]).status, 0);
  assert.ok(!fs.existsSync(path.join(plain, "setup", "config.json")));
  assert.equal(fs.readFileSync(path.join(plain, "_headers"), "utf8"), HEADERS);
});

test("stage-site: a test runner's loopback relay and install URL are accepted, from flags or the environment", t => {
  const home = tempHome(t);
  const site = fakeSite(path.join(home, "site")), out = path.join(home, "out");
  const r = spawnSync("sh", [path.join(REPO, "scripts", "stage-site.sh"), "--site", site, "--out", out], { encoding: "utf8", env: { ...process.env, VYRE_SETUP_RELAY: "ws://127.0.0.1:45123", VYRE_SETUP_INSTALL_URL: "http://127.0.0.1:45124/i" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "setup", "config.json"), "utf8")), { relay: "ws://127.0.0.1:45123", installUrl: "http://127.0.0.1:45124/i" });
  assert.match(fs.readFileSync(path.join(out, "_headers"), "utf8"), /wss:\/\/relay\.vyre\.run http:\/\/127\.0\.0\.1:45123 ws:\/\/127\.0\.0\.1:45123;/);
});

test("stage-site: it refuses a relay that is not wss, an install URL that is not https, and a site that was never built", t => {
  const home = tempHome(t);
  const site = fakeSite(path.join(home, "site"));
  assert.notEqual(run(["--site", site, "--out", path.join(home, "o1"), "--relay", "ws://x.example.com"]).status, 0, "ws only for a loopback relay");
  assert.notEqual(run(["--site", site, "--out", path.join(home, "o2"), "--install-url", "http://x.example.com/i"]).status, 0, "http only for a loopback install URL");
  assert.notEqual(run(["--site", path.join(home, "none"), "--out", path.join(home, "o3")]).status, 0);
  assert.notEqual(run(["--site", site]).status, 0, "--out is required");
});

test("stage-site: a relay or install URL the page would ignore is refused, not written (a lookalike host is not loopback)", t => {
  const home = tempHome(t);
  const site = fakeSite(path.join(home, "site"));
  for (const [flag, value] of [["--relay", "ws://127.0.0.1.evil.example"], ["--relay", "ws://localhost.evil.example:80"], ["--relay", "wss://evil.example.com"], ["--install-url", "http://127.0.0.1.evil.example/i"], ["--install-url", "http://localhost@evil.example/i"], ["--install-url", "https://evil.example.com/i"]]) {
    const out = path.join(home, "o-" + value.replace(/\W/g, ""));
    const r = run(["--site", site, "--out", out, flag, value]);
    assert.notEqual(r.status, 0, `${flag} ${value}`);
    assert.match(r.stderr, /is not one the page would take/);
    assert.ok(!fs.existsSync(out), "nothing was left behind");
  }
  const ok = run(["--site", site, "--out", path.join(home, "ok"), "--relay", "ws://127.0.0.1:45123"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /wrote setup\/config\.json \{"relay":"ws:\/\/127\.0\.0\.1:45123"\}/, "it says what it wrote");
});

test("deploy-site: production refuses a folder with a staging config.json; a preview alias takes it", t => {
  const home = tempHome(t);
  const site = fakeSite(path.join(home, "site"));
  fs.writeFileSync(path.join(site, "setup", "config.json"), '{"relay":"ws://127.0.0.1:1"}\n');
  const log = path.join(home, "wrangler.log");
  const fake = path.join(home, "wrangler");
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >>"${log}"\n`, { mode: 0o755 });
  const deploy = (/** @type {string[]} */ args) => spawnSync("sh", [path.join(REPO, "scripts", "deploy-site.sh"), ...args], { encoding: "utf8", env: { ...process.env, VYRE_WRANGLER: fake } });
  const prod = deploy([site, "--branch", "main"]);
  assert.notEqual(prod.status, 0);
  assert.match(prod.stderr, /staging override; it does not go to production/);
  assert.ok(!fs.existsSync(log), "wrangler was never run");
  assert.equal(deploy([site, "--branch", "staging"]).status, 0);
  assert.match(fs.readFileSync(log, "utf8"), /pages deploy .* --project-name vyre-site --branch staging/);
  // A clean folder goes to main.
  fs.rmSync(path.join(site, "setup", "config.json"));
  assert.equal(deploy([site, "--branch", "main"]).status, 0);
  assert.match(fs.readFileSync(log, "utf8"), /--branch main/);
  assert.notEqual(deploy([site]).status, 0, "--branch is required");
});

test("the setup page hands its own hostname to setupOverrides, so production never reads the file", () => {
  const page = fs.readFileSync(path.join(REPO, "site", "setup", "page.js"), "utf8");
  assert.match(page, /setupOverrides\(await r\.json\(\), location\.hostname\)/);
});

test("setupOverrides: only a plain wss relay and a plain https install URL are taken; the page's defaults otherwise", () => {
  assert.deepEqual(setupOverrides({ relay: "wss://relay-staging.vyre.run:8443", installUrl: "https://staging.vyre-site.pages.dev/i" }, "staging.vyre-site.pages.dev"), { relay: "wss://relay-staging.vyre.run:8443", installUrl: "https://staging.vyre-site.pages.dev/i" });
  // Production never takes the file, whatever it says: nothing put on that origin can change the install line.
  for (const host of ["vyre.run", "www.vyre.run", "VYRE.RUN"]) assert.deepEqual(setupOverrides({ installUrl: "https://staging.vyre-site.pages.dev/i", relay: "wss://relay.vyre.run" }, host), {}, host);
  // Elsewhere, only Vyre's own hosts (or a runner's loopback): an arbitrary https host is not an install line.
  assert.deepEqual(setupOverrides({ installUrl: "https://evil.example.com/i", relay: "wss://evil.example.com" }, "staging.vyre-site.pages.dev"), {});
  assert.deepEqual(setupOverrides({ installUrl: "https://vyre.run.evil.example.com/i" }, "x.pages.dev"), {}, "a suffix trick");
  // pages.dev and workers.dev are shared: only the site's own project host counts, never another name on them.
  assert.deepEqual(setupOverrides({ installUrl: "https://evil.pages.dev/i", relay: "wss://evil.workers.dev" }, "staging.vyre-site.pages.dev"), {});
  assert.deepEqual(setupOverrides({ installUrl: "https://evilvyre-site.pages.dev/i" }, "staging.vyre-site.pages.dev"), {}, "not a dot boundary");
  assert.deepEqual(setupOverrides({ installUrl: "https://feature-x.vyre-site.pages.dev/i" }, "feature-x.vyre-site.pages.dev"), { installUrl: "https://feature-x.vyre-site.pages.dev/i" });
  assert.deepEqual(setupOverrides({ relay: "ws://127.0.0.1:45123", installUrl: "http://localhost:45124/i" }, "127.0.0.1"), { relay: "ws://127.0.0.1:45123", installUrl: "http://localhost:45124/i" });
  for (const bad of [{ relay: "ws://x.example.com" }, { relay: "wss://x.example.com/path" }, { relay: "wss://x.example.com;evil" }, { relay: "https://x.example.com" },
    { relay: "ws://evil.example.com" }, { installUrl: "http://evil.example.com/i" }, { installUrl: "http://127.0.0.1@evil.example.com/i" }, { installUrl: "https://u:p@x.example.com/i" }, { installUrl: "https://x.example.com/i?a=1" }, { installUrl: "https://x.example.com/i#f" },
    { installUrl: "https://127.0.0.1/i" }, { installUrl: 5 }, null, "x", []]) assert.deepEqual(setupOverrides(bad, "staging.vyre-site.pages.dev"), {}, JSON.stringify(bad));
});
