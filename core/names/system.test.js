// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { units, installPlan, uninstallPlan, apply, detect, describe } from "./system.js";
import { tempHome } from "../../test/helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "install-box.sh");
const BASE = { user: "alex", group: "alex", home: "/home/alex", node: "/usr/bin/node", pkg: "/usr/lib/node_modules/vyre" };
const NOTHING = { tailscale: { installed: false, device: false, operator: null }, systemd: true };
const READY = { tailscale: { installed: true, device: true, operator: null }, systemd: true };
const lines = steps => steps.map(describe);

test("system: unit files carry the decided lines", () => {
  const u = units(BASE);
  for (const l of ["Description=Vyre tailnet listener", "After=tailscaled.service", "Wants=tailscaled.service", "ListenStream=443",
    "BindToDevice=tailscale0", "FileDescriptorName=tailnet", "NoDelay=true", "WantedBy=sockets.target"]) {
    assert.ok(u["vyre.socket"].split("\n").includes(l), `socket: ${l}`);
  }
  for (const l of ["Description=Vyre", "After=network-online.target tailscaled.service vyre.socket", "Wants=network-online.target",
    "Type=simple", "User=alex", "Group=alex", "Environment=VYRE_SUPERVISOR=systemd", "Environment=VYRE_HOME=/home/alex/.vyre",
    "EnvironmentFile=-/home/alex/.vyre/env", "WorkingDirectory=/home/alex",
    "ExecStart=/usr/bin/node /usr/lib/node_modules/vyre/core/daemon/main.js", "Restart=always", "RestartSec=2",
    "NoNewPrivileges=yes", "LimitNOFILE=65536", "WantedBy=multi-user.target"]) {
    assert.ok(u["vyre.service"].split("\n").includes(l), `service: ${l}`);
  }
  const custom = units({ ...BASE, port: 8443, device: "ts1" });
  assert.match(custom["vyre.socket"], /^ListenStream=8443$/m);
  assert.match(custom["vyre.socket"], /^BindToDevice=ts1$/m);
});

test("system: refuses root and values that would break a unit file", () => {
  assert.throws(() => units({ ...BASE, user: "root" }), /not run as root/);
  assert.throws(() => units({ ...BASE, home: "/home/a b" }), /absolute path/);
  assert.throws(() => units({ ...BASE, pkg: "/x/%h" }), /absolute path/);
  assert.throws(() => units({ ...BASE, node: "node" }), /absolute path/);
  assert.throws(() => units({ ...BASE, user: "alex\nUser=root" }), /not a user name/);
  assert.throws(() => units({ ...BASE, port: 0 }), /not a port/);
});

test("system: plan with nothing installed yet", () => {
  const steps = installPlan({ ...BASE, ...NOTHING, etc: "/etc/systemd/system" });
  assert.deepEqual(lines(steps).map(l => l.split("  #")[0].split(": ")[0]), [
    "mkdir /home/alex/.vyre (0700, owner alex:alex)",
    "write /etc/systemd/system/vyre.service (0644)",
    "write /etc/systemd/system/vyre.socket (0644)",
    "run systemctl daemon-reload",
    "note",
    "run systemctl enable vyre.service",
    "run systemctl restart vyre.service",
  ]);
  assert.match(/** @type {any} */ (steps[4]).text, /tailnet listener is not enabled.*next run after Tailscale is installed/);
});

test("system: plan with Tailscale up sets the operator and enables the socket", () => {
  const argv = installPlan({ ...BASE, ...READY }).filter(s => s.do === "run").map(s => /** @type {any} */ (s).argv.join(" "));
  assert.deepEqual(argv, ["systemctl daemon-reload", "tailscale set --operator=alex", "systemctl enable --now vyre.socket",
    "systemctl enable vyre.service", "systemctl restart vyre.service"]);
});

test("system: plan is idempotent once units match and operator is set", () => {
  const u = units(BASE);
  const steps = installPlan({ ...BASE, ...READY, tailscale: { ...READY.tailscale, operator: "alex" },
    hasUnit: { service: u["vyre.service"], socket: u["vyre.socket"] } });
  assert.ok(!steps.some(s => s.do === "write"));
  assert.deepEqual(steps.filter(s => s.do === "run").map(s => /** @type {any} */ (s).argv.join(" ")),
    ["systemctl enable --now vyre.socket", "systemctl start vyre.service"]);
});

test("system: a changed socket unit is rewritten, reloaded and restarted", () => {
  const u = units(BASE);
  const steps = installPlan({ ...BASE, ...READY, port: 8443, tailscale: { ...READY.tailscale, operator: "alex" },
    hasUnit: { service: u["vyre.service"], socket: u["vyre.socket"] } });
  assert.deepEqual(steps.filter(s => s.do === "write").map(s => path.basename(/** @type {any} */ (s).path)), ["vyre.socket"]);
  assert.deepEqual(steps.filter(s => s.do === "run").map(s => /** @type {any} */ (s).argv.join(" ")), ["systemctl daemon-reload",
    "systemctl enable --now vyre.socket", "systemctl restart vyre.socket", "systemctl enable vyre.service", "systemctl restart vyre.service"]);
});

test("system: no systemd means a note and nothing else", () => {
  const steps = installPlan({ ...BASE, ...NOTHING, systemd: false });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].do, "note");
  assert.match(/** @type {any} */ (steps[0]).text, /systemd is required.*vyre daemon/);
});

test("system: uninstall keeps ~/.vyre unless purged", () => {
  const plain = uninstallPlan({ home: "/home/alex" });
  assert.deepEqual(lines(plain).filter(l => !l.startsWith("note")).map(l => l.split("  #")[0]), [
    "run systemctl disable --now vyre.service vyre.socket",
    "remove /etc/systemd/system/vyre.service",
    "remove /etc/systemd/system/vyre.socket",
    "run systemctl daemon-reload",
  ]);
  assert.match(lines(plain).join("\n"), /vyre name release/);
  assert.match(lines(plain).join("\n"), /npm rm -g vyre/);
  assert.ok(!plain.some(s => s.do === "remove" && s.path === "/home/alex/.vyre"));

  const purge = uninstallPlan({ home: "/home/alex", purge: true });
  const i = purge.findIndex(s => s.do === "remove" && s.path === "/home/alex/.vyre");
  assert.ok(i > 0);
  assert.match(/** @type {any} */ (purge[i - 1]).text, /vault goes with it/);
});

test("system: apply is a dry run by default and changes nothing", async t => {
  const etc = path.join(tempHome(t), "etc");
  const home = path.join(path.dirname(etc), "home");
  const calls = [], out = [];
  const steps = installPlan({ ...BASE, home, ...READY, etc });
  const r = await apply(steps, { out: l => out.push(l), exec: argv => calls.push(argv) });
  assert.equal(calls.length, 0);
  assert.ok(!fs.existsSync(etc) && !fs.existsSync(home));
  assert.equal(out.length, steps.length);
  assert.ok(out.every(l => l.startsWith("would ") || l.startsWith("note:")));
  assert.deepEqual(r.lines, out);
});

test("system: apply for real writes into the given root and runs argv", async t => {
  const base = tempHome(t);
  const etc = path.join(base, "etc"), home = path.join(base, "home");
  const calls = [];
  await apply(installPlan({ ...BASE, home, ...READY, etc }), { dryRun: false, out: () => {}, exec: argv => { calls.push(argv); return ""; } });
  assert.equal(fs.readFileSync(path.join(etc, "vyre.service"), "utf8"), units({ ...BASE, home })["vyre.service"]);
  assert.equal(fs.statSync(path.join(etc, "vyre.socket")).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(home, ".vyre")).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(etc).sort(), ["vyre.service", "vyre.socket"], "no temp files");
  assert.deepEqual(calls[0], ["chown", "alex:alex", path.join(home, ".vyre")]);
  assert.deepEqual(calls.slice(1).map(a => a.join(" ")), ["systemctl daemon-reload", "tailscale set --operator=alex",
    "systemctl enable --now vyre.socket", "systemctl enable vyre.service", "systemctl restart vyre.service"]);

  // Uninstall: an optional step that fails does not stop the rest.
  const r = await apply(uninstallPlan({ home, etc, purge: true }), { dryRun: false, out: () => {},
    exec: argv => { if (argv[1] === "disable") throw new Error("Unit vyre.service not loaded."); } });
  assert.deepEqual(r.failed, ["systemctl disable --now vyre.service vyre.socket"]);
  assert.deepEqual(fs.readdirSync(etc), []);
  assert.ok(!fs.existsSync(path.join(home, ".vyre")));
});

test("system: detect reads units, the device and the operator through injected probes", () => {
  const files = { "/run/systemd/system": true, "/sys/class/net/tailscale0": true };
  const fakeFs = /** @type {any} */ ({
    existsSync: p => !!files[p],
    readFileSync: p => { if (p === "/etc/systemd/system/vyre.service") return "unit"; throw Object.assign(new Error("no"), { code: "ENOENT" }); },
  });
  const d = detect({ fs: fakeFs, exec: argv => argv[1] === "debug" ? JSON.stringify({ OperatorUser: "alex" }) : "1.80.0" });
  assert.deepEqual(d, { systemd: true, tailscale: { installed: true, device: true, operator: "alex" }, units: { service: "unit", socket: undefined } });

  const none = detect({ fs: /** @type {any} */ ({ existsSync: () => false, readFileSync: () => { throw new Error("no"); } }),
    exec: () => { throw new Error("not found"); } });
  assert.deepEqual(none.tailscale, { installed: false, device: false, operator: null });
  assert.equal(none.systemd, false);

  const garbled = detect({ fs: fakeFs, exec: argv => argv[1] === "debug" ? "not json" : "" });
  assert.equal(garbled.tailscale.operator, null);
});

// --- the installer script, run against stub commands ---

/** A folder of stub executables that log each call; `extra` overrides a stub's body. */
function stubs(dir, log, extra = {}) {
  const body = {
    uname: `echo Linux`,
    id: `case "$1" in -u) echo 1000 ;; -un) echo alex ;; alex) echo "uid=1000(alex)" ;; *) exit 1 ;; esac`,
    node: `echo v22.9.0`,
    npm: `case "$1" in view) echo 0.3.0 ;; ls) exit 1 ;; esac`,
    tailscale: `exit 0`, claude: `exit 0`, systemctl: `exit 0`, curl: `exit 0`, useradd: `exit 0`,
    sudo: `while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -H|-E|--) shift ;; *) break ;; esac; done; exec "$@"`,
    vyre: `echo "vyre $*"`,
    ...extra,
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(body)) {
    if (text === null) continue;
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${text}\n`, { mode: 0o755 });
  }
}

function runScript(t, args, extra) {
  const base = tempHome(t);
  const bin = path.join(base, "bin"), log = path.join(base, "calls.log");
  stubs(bin, log, extra);
  fs.writeFileSync(log, "");
  const r = spawnSync("sh", [SCRIPT, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base },
  });
  return { ...r, calls: fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

test("install-box.sh: parses with sh -n", () => {
  execFileSync("sh", ["-n", SCRIPT]);
});

test("install-box.sh: shellcheck is clean when available", t => {
  try { execFileSync("shellcheck", ["--version"], { stdio: "ignore" }); } catch { t.skip("shellcheck not installed"); return; }
  execFileSync("shellcheck", ["-s", "sh", SCRIPT], { stdio: "pipe" });
});

test("install-box.sh: dry run prints every change and makes none", t => {
  const r = runScript(t, ["--dry-run", "--yes", "--user", "alex"]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.split("\n");
  assert.ok(out.includes("would run: sudo npm install -g vyre@0.3.0"), r.stdout);
  assert.ok(out.includes("vyre up --system --user alex --dry-run"), r.stdout);
  assert.ok(out.includes("vyre up --dry-run"), r.stdout);
  // Only read-only calls reached the stubs.
  for (const c of r.calls) {
    assert.ok(/^(uname|id|node --version|npm (view|ls)|vyre .*--dry-run$)/.test(c), `mutating call in a dry run: ${c}`);
  }
});

test("install-box.sh: missing tools are offered, and --yes installs them (dry run shows how)", t => {
  const r = runScript(t, ["--dry-run", "--yes", "--user", "alex"], { tailscale: null, claude: null });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^would run: sudo sh -c 'curl -fsSL https:\/\/tailscale.com\/install.sh \| sh'$/m);
  assert.match(r.stdout, /^would run: sudo sh -c 'npm install -g @anthropic-ai\/claude-code'$/m);
});

test("install-box.sh: without --yes and no terminal, it prints the install command and stops", t => {
  const r = runScript(t, ["--dry-run", "--user", "alex"], { tailscale: null });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /curl -fsSL https:\/\/tailscale.com\/install.sh \| sh/);
  assert.ok(!r.calls.some(c => c.startsWith("curl")));
});

test("install-box.sh: old Node stops the install with the generic line off Debian", t => {
  const r = runScript(t, ["--dry-run", "--yes", "--user", "alex"], { node: `echo v20.11.0` });
  if (fs.existsSync("/etc/debian_version")) { assert.match(r.stdout, /deb\.nodesource\.com\/setup_22\.x/); return; }
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Install Node 22\.5\+/);
});

test("install-box.sh: refuses root as the user, and says what to do on a Mac", t => {
  const root = runScript(t, ["--dry-run", "--yes", "--user", "root"]);
  assert.equal(root.status, 1);
  assert.match(root.stderr, /does not run as root/);
  const mac = runScript(t, ["--dry-run"], { uname: `echo Darwin` });
  assert.equal(mac.status, 0);
  assert.match(mac.stdout, /on a Mac: npm install -g vyre && vyre up/);
});

test("install-box.sh: as root with no SUDO_USER it creates the vyre login", t => {
  const r = runScript(t, ["--dry-run", "--yes"], { id: `case "$1" in -u) echo 0 ;; -un) echo root ;; *) exit 1 ;; esac` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^would run: useradd --create-home --home-dir \/home\/vyre --shell \/bin\/bash vyre$/m);
  assert.match(r.stdout, /vyre up --system --user vyre --dry-run/);
  assert.match(r.stdout, /would run \(as vyre\): vyre up/);
  assert.match(r.stdout, /ssh as vyre/);
});

test("install-box.sh: uninstall dry run", t => {
  const r = runScript(t, ["--dry-run", "--uninstall", "--purge"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^vyre uninstall --system --purge --dry-run$/m);
  assert.match(r.stdout, /^would run: sudo npm rm -g vyre$/m);
});
