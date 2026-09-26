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

/** A folder of stub executables that log each call; `extra` overrides a stub's body (null removes it). */
function stubs(dir, log, extra = {}) {
  const body = {
    uname: `echo Linux`,
    id: `case "$1" in -u) echo 1000 ;; -un) echo alex ;; -gn) echo alex ;; alex) echo "uid=1000(alex)" ;; *) exit 1 ;; esac`,
    docker: `case "$1 $2" in
  "compose version") echo 2.29.1 ;;
  "volume ls") echo vyre_vyre-home; echo vyre_vyre-work; echo vyre_tailscale-state ;;
esac
exit 0`,
    curl: `exit 0`,
    sudo: `while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -H|-E|--) shift ;; *) break ;; esac; done; exec "$@"`,
    ...extra,
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(body)) {
    if (text === null) continue;
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${text}\n`, { mode: 0o755 });
  }
}

/** Runs the installer with stubs on PATH, the stack in a temp folder and the wrapper in another. */
function runScript(t, args, extra, prepare = () => {}) {
  const base = tempHome(t);
  const bin = path.join(base, "bin"), log = path.join(base, "calls.log");
  fs.mkdirSync(path.join(base, "srv"));
  const dir = path.join(base, "srv", "vyre"), wrapper = path.join(base, "usr-local-bin", "vyre");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  stubs(bin, log, extra);
  fs.writeFileSync(log, "");
  prepare({ dir, wrapper });
  const r = spawnSync("sh", [SCRIPT, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    // /dev/null stands in for /dev/net/tun: a character device on every system.
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base, VYRE_DIR: dir, VYRE_WRAPPER: wrapper, VYRE_TUN: "/dev/null" },
  });
  return { ...r, dir, wrapper, calls: fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

const READ_ONLY = /^(uname|id|docker (compose version|info|volume ls))/;

test("install-box.sh: parses with sh -n", () => {
  execFileSync("sh", ["-n", SCRIPT]);
});

test("install-box.sh: shellcheck is clean when available", t => {
  try { execFileSync("shellcheck", ["--version"], { stdio: "ignore" }); } catch { t.skip("shellcheck not installed"); return; }
  execFileSync("shellcheck", ["-s", "sh", SCRIPT], { stdio: "pipe" });
});

test("install-box.sh: dry run lists every change and makes none", t => {
  const r = runScript(t, ["--dry-run", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^dry run: nothing on this box will change$/m);
  for (const f of ["compose.yml", "compose.chat.yml", "vyre.env.example", "vyre", "chat/compose.yml"]) {
    assert.ok(r.stdout.split("\n").includes(`would download: https://vyre.run/box/${f}`), `${f}: ${r.stdout}`);
  }
  assert.match(r.stdout, new RegExp(`^would run: mkdir -p ${r.dir}$`, "m"));
  assert.match(r.stdout, /^ {2}COMPOSE_PROJECT_NAME=vyre$/m);
  assert.match(r.stdout, /^ {2}COMPOSE_FILE=compose\.yml$/m);
  assert.match(r.stdout, new RegExp(`^would run: sudo install -m 0755 .*/vyre ${r.wrapper}$`, "m"));
  assert.match(r.stdout, new RegExp(`^would run: env VYRE_DIR=${r.dir} SSH_CONNECTION= ${r.wrapper} up$`, "m"));
  assert.ok(!fs.existsSync(r.dir), "the stack folder was created");
  assert.ok(!fs.existsSync(r.wrapper), "the wrapper was installed");
  for (const c of r.calls) assert.match(c, READ_ONLY, `mutating call in a dry run: ${c}`);
});

test("install-box.sh: missing Docker is offered, and --yes installs it (dry run shows how)", t => {
  const r = runScript(t, ["--dry-run", "--yes"], { docker: null });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^would run: sudo sh -c 'curl -fsSL https:\/\/get\.docker\.com \| sh'$/m);
  assert.ok(!r.calls.some(c => c.startsWith("curl")));
});

test("install-box.sh: without --yes and no terminal, it prints the Docker command and stops", t => {
  const r = runScript(t, ["--dry-run"], { docker: null });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^ {2}curl -fsSL https:\/\/get\.docker\.com \| sh$/m);
  assert.ok(!r.calls.some(c => c.startsWith("curl")));
});

test("install-box.sh: an old Compose stops the install", t => {
  const r = runScript(t, ["--dry-run", "--yes"], { docker: `[ "$1 $2" = "compose version" ] && echo 2.20.0; exit 0` });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Compose 2\.24 or newer; this box has 2\.20\.0/);
});

test("install-box.sh: says what to do on a Mac", t => {
  const mac = runScript(t, ["--dry-run"], { uname: `echo Darwin` });
  assert.equal(mac.status, 0);
  assert.match(mac.stdout, /on a Mac: npm install -g vyre && vyre up/);
  assert.deepEqual(mac.calls, ["uname -s"]);
});

test("install-box.sh: --from DIR copies the checkout's files and builds from it", t => {
  const r = runScript(t, ["--dry-run", "--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^would run: install -m 0644 ${REPO}/box/compose\\.build\\.yml ${r.dir}/compose\\.build\\.yml$`, "m"));
  assert.match(r.stdout, new RegExp(`^would run: install -m 0644 ${REPO}/modules/chat/compose\\.yml ${r.dir}/chat/compose\\.yml$`, "m"));
  assert.match(r.stdout, /^ {2}COMPOSE_FILE=compose\.yml:compose\.build\.yml$/m);
  assert.match(r.stdout, new RegExp(`^ {2}VYRE_SOURCE=${REPO}$`, "m"));
  assert.match(r.stdout, new RegExp(`^would run: sudo install -m 0755 ${REPO}/box/vyre ${r.wrapper}$`, "m"));
  assert.ok(!r.stdout.includes("would download"));
});

test("install-box.sh: a real run writes the stack, never overwrites .env, and starts it", t => {
  const mine = "COMPOSE_PROJECT_NAME=vyre\nCOMPOSE_FILE=compose.yml:chat/compose.yml:compose.chat.yml\n";
  const r = runScript(t, ["--yes", "--from", REPO], {}, ({ dir }) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".env"), mine);
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(path.join(r.dir, ".env"), "utf8"), mine);
  assert.match(r.stdout, /\.env exists; leaving it as it is/);
  assert.match(r.stdout, /does not list compose\.build\.yml/);
  for (const f of ["compose.yml", "compose.chat.yml", "compose.build.yml", "vyre.env.example", "chat/compose.yml"]) {
    assert.ok(fs.existsSync(path.join(r.dir, f)), f);
  }
  assert.equal(fs.readFileSync(r.wrapper, "utf8"), fs.readFileSync(path.join(REPO, "box", "vyre"), "utf8"));
  // The wrapper ran: the stack came up and the CLI's `vyre up` ran in the container.
  assert.ok(r.calls.includes("docker compose up -d"), r.calls.join("\n"));
  assert.ok(r.calls.some(c => /^docker compose exec .*-e VYRE_HOST_USER=alex vyre vyre up$/.test(c)), r.calls.join("\n"));
});

test("install-box.sh: a wrapper that is not ours is not replaced without asking", t => {
  const r = runScript(t, ["--dry-run"], {}, ({ wrapper }) => fs.writeFileSync(wrapper, "#!/bin/sh\necho npm vyre\n"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /left .* alone/);
});

test("install-box.sh: uninstall dry run, and --purge lists the volumes and asks", t => {
  const r = runScript(t, ["--dry-run", "--uninstall"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^would run: docker compose -p vyre down --remove-orphans$/m);
  assert.match(r.stdout, /volumes stay too/);

  const kept = runScript(t, ["--dry-run", "--uninstall", "--purge"], {}, ({ dir, wrapper }) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "compose.yml"), "");
    fs.copyFileSync(path.join(REPO, "box", "vyre"), wrapper);
  });
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, new RegExp(`^would run: sh -c 'cd "\\$1" && docker compose down --remove-orphans' sh ${kept.dir}$`, "m"));
  assert.match(kept.stdout, new RegExp(`^would run: sudo rm -f ${kept.wrapper}$`, "m"));
  assert.match(kept.stdout, /^ {2}vyre_vyre-home$/m);
  // No terminal to ask on, so the answer is no.
  assert.match(kept.stdout, /^kept the volumes$/m);
  assert.ok(!kept.stdout.includes("docker volume rm"));
  for (const c of kept.calls) assert.match(c, READ_ONLY, `mutating call in a dry run: ${c}`);

  const gone = runScript(t, ["--dry-run", "--yes", "--uninstall", "--purge"]);
  assert.match(gone.stdout, /^would run: docker volume rm vyre_vyre-home vyre_vyre-work vyre_tailscale-state$/m);
  assert.ok(fs.existsSync(path.join(REPO, "box", "vyre")));
});
