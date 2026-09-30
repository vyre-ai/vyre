// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { units, installPlan, uninstallPlan, apply, detect, describe } from "./system.js";
import { tempHome } from "../../test/helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "install-box.sh");
const WRAPPER = path.join(REPO, "box", "vyre");
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
function stubs(dir, log, site, extra = {}) {
  const body = {
    uname: `echo Linux`,
    id: `case "$1" in -u) echo 1000 ;; -un) echo alex ;; -gn) echo alex ;; alex) echo "uid=1000(alex)" ;; *) exit 1 ;; esac`,
    docker: `case "$1 $2" in
  "compose version") echo 2.29.1 ;;
  "volume ls") echo vyre_vyre-home; echo vyre_vyre-work; echo vyre_tailscale-state ;;
esac
# The update's signature check runs Node in the image: docker run ... --entrypoint node IMAGE -e CODE KEY SIG.
if [ "$1" = run ]; then shift; while [ $# -gt 0 ] && [ "$1" != --entrypoint ]; do shift; done; shift 3; exec ${process.execPath} "$@"; fi
exit 0`,
    // Serves https://vyre.run/box/<name> from the fake site folder; 22 is curl -f's 404.
    curl: `url=$2; out=$4; name=\${url#https://vyre.run/box/}; [ -f "${site}/$name" ] || exit 22; cp "${site}/$name" "$out"`,
    sudo: `while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -H|-E|--) shift ;; *) break ;; esac; done; exec "$@"`,
    ...extra,
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(body)) {
    if (text === null) continue;
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${text}\n`, { mode: 0o755 });
  }
}

const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** The release site, as vyre.run/box/ serves it: the box files, a vyre.tgz whose single top folder
 * holds box/Dockerfile and a marker, and SHA256SUMS over all of it. */
function site(folder, version = "0.3.0") {
  const files = { "compose.yml": "box/compose.yml",
    "compose.build.yml": "box/compose.build.yml", "vyre.env.example": "box/vyre.env.example", "vyre": "box/vyre",
    "Dockerfile": "box/Dockerfile", "install-box.sh": "scripts/install-box.sh" };
  for (const [to, from] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, to)), { recursive: true });
    fs.copyFileSync(path.join(REPO, from), path.join(folder, to));
  }
  const src = path.join(folder, "..", "tgz", `vyre-${version}`);
  fs.mkdirSync(path.join(src, "box"), { recursive: true });
  fs.writeFileSync(path.join(src, "box", "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(src, "VERSION"), version + "\n");
  // As npm pack makes it: every mtime pinned to 1985.
  const old = new Date("1985-10-26T08:15:00Z");
  for (const f of [path.join(src, "box", "Dockerfile"), path.join(src, "VERSION"), path.join(src, "box"), src]) fs.utimesSync(f, old, old);
  execFileSync("tar", ["-czf", path.join(folder, "vyre.tgz"), "-C", path.dirname(src), `vyre-${version}`]);
  fs.writeFileSync(path.join(folder, "VERSION"), version + "\n");
  sums(folder);
}

/** Rewrites SHA256SUMS over every file in the site but itself. */
function sums(folder) {
  const names = [];
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(folder, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else if (r !== "SHA256SUMS") names.push(r);
    }
  };
  walk("");
  fs.writeFileSync(path.join(folder, "SHA256SUMS"), names.sort().map(n => `${sha(path.join(folder, n))}  ${n}\n`).join(""));
}

/** A temp box: stubs on PATH, the release site, the stack folder and the wrapper's path. */
/**
 * /usr/bin:/bin, or, when a test takes a command away (a null stub), a folder of links to both
 * without it: a machine that has the real one (the test box has Docker) must not find it there.
 */
function systemPath(base, without) {
  if (!without.length) return "/usr/bin:/bin";
  const dir = path.join(base, "system-bin");
  fs.mkdirSync(dir);
  for (const from of ["/usr/bin", "/bin"]) {
    for (const name of fs.readdirSync(from)) {
      if (without.includes(name) || fs.existsSync(path.join(dir, name))) continue;
      try { fs.symlinkSync(path.join(from, name), path.join(dir, name)); } catch {}
    }
  }
  return dir;
}

function setup(t, extra) {
  const base = tempHome(t);
  const bin = path.join(base, "bin"), log = path.join(base, "calls.log"), www = path.join(base, "site");
  fs.mkdirSync(path.join(base, "srv"));
  const dir = path.join(base, "srv", "vyre"), wrapper = path.join(base, "usr-local-bin", "vyre");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  site(www);
  stubs(bin, log, www, extra);
  fs.writeFileSync(log, "");
  // /dev/null stands in for /dev/net/tun: a character device on every system.
  // No Docker socket unless a test makes one, so no DOCKER_GID line unless a test asks for it.
  const env = { PATH: `${bin}:${systemPath(base, Object.keys(extra || {}).filter(k => extra[k] === null))}`, HOME: base, VYRE_DIR: dir, VYRE_WRAPPER: wrapper, VYRE_TUN: "/dev/null",
    VYRE_DOCKER_SOCK: path.join(base, "no-docker.sock") };
  const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { base, dir, wrapper, site: www, env, calls };
}

/** Runs the installer with stubs on PATH, the stack in a temp folder and the wrapper in another. */
function runScript(t, args, extra, prepare = () => {}, env = {}) {
  const box = setup(t, extra);
  prepare(box);
  const r = spawnSync("sh", [SCRIPT, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...box.env, ...env },
  });
  return { ...r, dir: box.dir, wrapper: box.wrapper, calls: box.calls() };
}

const READ_ONLY = /^(uname|id|docker (--version|compose version|info|volume ls|manifest inspect))/;

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
  assert.match(r.stdout, /^dry run: nothing on this server will change$/m);
  assert.ok(r.stdout.split("\n").includes("would download: https://vyre.run/box/SHA256SUMS"), r.stdout);
  for (const f of ["compose.yml", "compose.build.yml", "vyre.env.example", "vyre"]) {
    assert.ok(r.stdout.split("\n").includes(`would download and verify: https://vyre.run/box/${f}`), `${f}: ${r.stdout}`);
  }
  assert.ok(!r.stdout.includes("vyre.tgz"), "the image can be pulled, so no source");
  assert.ok(!/chat/i.test(r.stdout), "no Chat files");
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
  assert.match(r.stdout, /Compose 2\.24 or newer; this server has 2\.20\.0/);
});

test("install-box.sh: on a Mac it looks for the Mac server's installer on the site, and stops when the site does not list it", t => {
  const mac = runScript(t, ["--dry-run"], { uname: `echo Darwin` });
  assert.equal(mac.status, 1);
  assert.match(mac.stderr, /SHA256SUMS has no line for install-mac-server\.sh/);
  assert.ok(!mac.calls.some(c => /^(docker|sudo)/.test(c)), "nothing of the Linux install ran");
});

test("install-box.sh: --from DIR copies the checkout's files and builds from it", t => {
  const r = runScript(t, ["--dry-run", "--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^would run: install -m 0644 ${REPO}/box/compose\\.build\\.yml ${r.dir}/compose\\.build\\.yml$`, "m"));
  assert.match(r.stdout, /^ {2}COMPOSE_FILE=compose\.yml:compose\.build\.yml$/m);
  assert.match(r.stdout, new RegExp(`^ {2}VYRE_SOURCE=${REPO}$`, "m"));
  assert.match(r.stdout, new RegExp(`^would run: sudo install -m 0755 ${REPO}/box/vyre ${r.wrapper}$`, "m"));
  assert.ok(!r.stdout.includes("would download"));
});

test("install-box.sh: a real run writes the stack, never overwrites .env, and starts it", t => {
  const mine = "COMPOSE_PROJECT_NAME=vyre\nCOMPOSE_FILE=compose.yml\nCOMPOSE_PROFILES=computers\n";
  const r = runScript(t, ["--yes", "--from", REPO], {}, ({ dir }) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".env"), mine);
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(path.join(r.dir, ".env"), "utf8"), mine);
  assert.match(r.stdout, /\.env exists; leaving it as it is/);
  assert.match(r.stdout, /does not list compose\.build\.yml/);
  for (const f of ["compose.yml", "compose.build.yml", "vyre.env.example"]) {
    assert.ok(fs.existsSync(path.join(r.dir, f)), f);
  }
  assert.equal(fs.readFileSync(r.wrapper, "utf8"), fs.readFileSync(path.join(REPO, "box", "vyre"), "utf8"));
  // The wrapper ran: the stack came up and the CLI's `vyre up` ran in the container.
  assert.ok(r.calls.includes("docker compose up -d"), r.calls.join("\n"));
  assert.ok(r.calls.some(c => /^docker compose exec .*-e VYRE_HOST_USER=alex vyre vyre up$/.test(c)), r.calls.join("\n"));
});

test("install-box.sh: DOCKER_GID is the socket's group, written fresh or added to an .env that lacks it", t => {
  const sock = t => { const f = path.join(tempHome(t), "docker.sock"); fs.writeFileSync(f, ""); return f; };
  const s1 = sock(t), gid = fs.statSync(s1).gid;
  const dry = runScript(t, ["--dry-run", "--yes"], {}, () => {}, { VYRE_DOCKER_SOCK: s1 });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`^ {2}DOCKER_GID=${gid}$`, "m"));
  // An existing .env keeps every line of its own and gains only DOCKER_GID, once.
  const mine = "COMPOSE_PROJECT_NAME=vyre\nCOMPOSE_FILE=compose.yml\nCOMPOSE_PROFILES=computers";
  let dir = "";
  const r = runScript(t, ["--yes", "--from", REPO], {}, box => {
    dir = box.dir;
    fs.mkdirSync(box.dir, { recursive: true });
    fs.writeFileSync(path.join(box.dir, ".env"), mine);
  }, { VYRE_DOCKER_SOCK: s1, VYRE_NO_UP: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /adding DOCKER_GID/);
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), `${mine}\nDOCKER_GID=${gid}\n`);
  const kept = "COMPOSE_PROJECT_NAME=vyre\nDOCKER_GID=4242\n";
  const again = runScript(t, ["--yes", "--from", REPO], {}, box => {
    dir = box.dir;
    fs.mkdirSync(box.dir, { recursive: true });
    fs.writeFileSync(path.join(box.dir, ".env"), kept);
  }, { VYRE_DOCKER_SOCK: s1, VYRE_NO_UP: "1" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), kept, "a DOCKER_GID of theirs is left alone");
});

test("install-box.sh: VYRE_NO_UP=1 installs everything and starts nothing", t => {
  const r = runScript(t, ["--yes", "--from", REPO], {}, () => {}, { VYRE_NO_UP: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(r.dir, "compose.yml")));
  assert.ok(fs.existsSync(r.wrapper));
  assert.match(r.stdout, /not started \(VYRE_NO_UP=1\)/);
  assert.ok(!r.calls.some(c => /docker compose (up|exec)/.test(c)), r.calls.join("\n"));
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
  // The wrapper is the one uninstall (box/vyre): it lists the volumes and asks. Without --yes the
  // installer hands it no answer, so it asks; a dry run only shows that call.
  assert.match(kept.stdout, new RegExp(`^would run: env VYRE_DIR=${kept.dir} VYRE_WRAPPER=${kept.wrapper} ${kept.wrapper} uninstall$`, "m"));
  assert.ok(!kept.stdout.includes("docker volume rm"));
  for (const c of kept.calls) assert.match(c, READ_ONLY, `mutating call in a dry run: ${c}`);

  const gone = runScript(t, ["--dry-run", "--yes", "--uninstall", "--purge"]);
  assert.match(gone.stdout, /^would run: docker compose -p vyre down --remove-orphans$/m, "no wrapper here, so the plain path");
  assert.ok(fs.existsSync(path.join(REPO, "box", "vyre")));
});

// --- downloads are verified, and the image is built from vyre.tgz when it cannot be pulled ---

const NO_IMAGE = { docker: `case "$1 $2" in
  "compose version") echo 2.29.1 ;;
  "manifest inspect") exit 1 ;;
esac
exit 0` };

test("install-box.sh: with no image to pull, it builds from a verified vyre.tgz in DIR/src", t => {
  // A release with no signed image digests only installs when asked to build from source (fail closed).
  const r = runScript(t, ["--yes"], NO_IMAGE, () => {}, { VYRE_BUILD: "tgz" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /building the image from vyre\.tgz \(VYRE_BUILD=tgz\)/);
  assert.equal(fs.readFileSync(path.join(r.dir, "src", "VERSION"), "utf8"), "0.3.0\n");
  assert.ok(fs.existsSync(path.join(r.dir, "src", "box", "Dockerfile")));
  assert.ok(!fs.existsSync(path.join(r.dir, "src.new")));
  // npm pack's 1985 mtimes are replaced, so BuildKit sees every changed file.
  for (const f of ["VERSION", "box/Dockerfile"]) assert.ok(Date.now() - fs.statSync(path.join(r.dir, "src", f)).mtimeMs < 10 * 60_000, `${f} kept its packed mtime`);
  const env = fs.readFileSync(path.join(r.dir, ".env"), "utf8");
  assert.match(env, /^COMPOSE_FILE=compose\.yml:compose\.build\.yml$/m);
  assert.equal(env.match(/^VYRE_SOURCE=(.*)$/m)?.[1], path.join(r.dir, "src"));
  assert.equal((fs.statSync(path.join(r.dir, ".env")).mode & 0o777), 0o600);
  for (const f of ["compose.yml", "compose.build.yml"]) assert.ok(fs.existsSync(path.join(r.dir, f)), f);
  assert.equal(fs.readFileSync(r.wrapper, "utf8"), fs.readFileSync(WRAPPER, "utf8"));
  // SHA256SUMS comes first, before any file it vouches for.
  assert.match(r.calls.find(c => c.startsWith("curl")) ?? "", /^curl -fsSL https:\/\/vyre\.run\/box\/SHA256SUMS /);
});

test("install-box.sh: VYRE_BUILD=tgz builds from source even when the image exists, and a dry run says so", t => {
  const dry = runScript(t, ["--dry-run", "--yes"], {}, () => {}, { VYRE_BUILD: "tgz" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^would download and verify: https:\/\/vyre\.run\/box\/vyre\.tgz$/m);
  assert.match(dry.stdout, /--strip-components=1$/m);
  assert.match(dry.stdout, new RegExp(`^would run: find ${dry.dir}/src\\.new -exec touch '\\{\\}' \\+$`, "m"));
  assert.match(dry.stdout, new RegExp(`^ {2}VYRE_SOURCE=${dry.dir}/src$`, "m"));
  assert.ok(!fs.existsSync(dry.dir));
  assert.ok(!dry.calls.some(c => c.startsWith("curl")));
});

test("install-box.sh: a changed file stops the install before anything is written", t => {
  const r = runScript(t, ["--yes"], {}, box => fs.appendFileSync(path.join(box.site, "compose.yml"), "# changed\n"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /checksum mismatch for https:\/\/vyre\.run\/box\/compose\.yml/);
  assert.ok(!fs.existsSync(path.join(r.dir, "compose.yml")));
  assert.ok(!fs.existsSync(r.wrapper));
});

test("install-box.sh: a file with no line in SHA256SUMS stops the install", t => {
  const r = runScript(t, ["--yes"], NO_IMAGE, box => {
    const f = path.join(box.site, "SHA256SUMS");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\n").filter(l => !l.endsWith("  vyre.tgz")).join("\n"));
  }, { VYRE_BUILD: "tgz" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SHA256SUMS has no line for vyre\.tgz/);
  assert.ok(!fs.existsSync(path.join(r.dir, "src")));
});

test("install-box.sh: a web page where SHA256SUMS should be is refused", t => {
  const r = runScript(t, ["--yes"], {}, box =>
    fs.writeFileSync(path.join(box.site, "SHA256SUMS"), "<!doctype html><title>Not found</title>\n"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SHA256SUMS is not a checksum list/);
  assert.ok(!fs.existsSync(r.wrapper));
});

/** A box built from $DIR/src, ready for `vyre update`. */
function builtBox(t) {
  const box = setup(t);
  fs.mkdirSync(path.join(box.dir, "src", "box"), { recursive: true });
  fs.writeFileSync(path.join(box.dir, "src", "VERSION"), "0.2.0\n");
  fs.writeFileSync(path.join(box.dir, "compose.yml"), "");
  fs.writeFileSync(path.join(box.dir, ".env"),
    `COMPOSE_PROJECT_NAME=vyre\nCOMPOSE_FILE=compose.yml:compose.build.yml\nVYRE_SOURCE=${box.dir}/src\n`);
  // The release is signed, as a real one is: SHA256SUMS.sig over the domain line and SHA256SUMS, with a key of this test's own, which the
  // wrapper is told is the release key (VYRE_RELEASE_KEY is for tests only).
  const keys = crypto.generateKeyPairSync("ed25519");
  const signSums = () => fs.writeFileSync(path.join(box.site, "SHA256SUMS.sig"),
    crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), fs.readFileSync(path.join(box.site, "SHA256SUMS"))]), keys.privateKey).toString("base64") + "\n");
  signSums();
  const env = { ...box.env, VYRE_RELEASE_KEY: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  const update = () => spawnSync("sh", [WRAPPER, "update"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  return { ...box, env, update };
}

test("box/vyre: update refetches a verified vyre.tgz into DIR/src, then builds", t => {
  const box = builtBox(t);
  const r = box.update();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(box.dir, "src", "VERSION"), "utf8"), "0.3.0\n");
  assert.ok(!fs.existsSync(path.join(box.dir, "src.new")) && !fs.existsSync(path.join(box.dir, "src.old")));
  assert.ok(Date.now() - fs.statSync(path.join(box.dir, "src", "VERSION")).mtimeMs < 10 * 60_000, "npm pack's 1985 mtime is replaced");
  const calls = box.calls();
  const fetched = calls.findIndex(c => c.startsWith("curl -fsSL https://vyre.run/box/vyre.tgz"));
  const built = calls.indexOf("docker compose build --pull");
  assert.ok(fetched >= 0 && built > fetched, calls.join("\n"));
  assert.ok(calls.includes("docker compose up -d"));
});

test("box/vyre: update with a tampered vyre.tgz keeps DIR/src and does not build", t => {
  const box = builtBox(t);
  fs.appendFileSync(path.join(box.site, "vyre.tgz"), "x");
  const r = box.update();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /checksum mismatch for https:\/\/vyre\.run\/box\/vyre\.tgz/);
  assert.equal(fs.readFileSync(path.join(box.dir, "src", "VERSION"), "utf8"), "0.2.0\n");
  assert.ok(!box.calls().some(c => c.startsWith("docker compose build")));
});

test("box/vyre: update of a checkout build leaves the source alone", t => {
  const box = builtBox(t);
  fs.writeFileSync(path.join(box.dir, ".env"), `COMPOSE_FILE=compose.yml:compose.build.yml\nVYRE_SOURCE=${REPO}\n`);
  const r = box.update();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!box.calls().some(c => c.startsWith("curl")));
  assert.ok(box.calls().includes("docker compose build --pull"));
});

// --- `vyre up --print-link`: one machine-readable line for `vyre box add` ---

/** docker whose `compose exec ... vyre up` prints the file named by VYRE_TEST_UP. */
const UP_PRINTS = { docker: `case "$1 $2" in
  "compose version") echo 2.29.1 ;;
  "compose exec") for a; do last=$a; done; [ "$last" = up ] && [ -n "\${VYRE_TEST_UP:-}" ] && cat "$VYRE_TEST_UP" ;;
esac
exit 0` };

const E = "\u001b";
const ONBOARDING = [
  "", `  vyred ${E}[32mrunning${E}[0m ${E}[2m· 0.3.0 · box${E}[0m`, "",
  `  Open this link to set up Vyre ${E}[2m(it works once, for an hour)${E}[0m:`, "",
  `    ${E}[32mhttp://127.0.0.1:7300/onboard?t=abc123${E}[0m`, "",
  "  This box is headless. On your own computer, run this first, then open the link there:",
  "    ssh -N -L 7300:127.0.0.1:7300 alex@203.0.113.4", "",
].join("\n");

function linkBox(t, printed) {
  const box = setup(t, UP_PRINTS);
  fs.mkdirSync(box.dir, { recursive: true });
  fs.writeFileSync(path.join(box.dir, "compose.yml"), "");
  const up = path.join(box.base, "up.txt");
  fs.writeFileSync(up, printed);
  return { ...box, env: { ...box.env, VYRE_TEST_UP: up } };
}

test("box/vyre: up --print-link prints only VYRE_LINK and VYRE_SSH", t => {
  const box = linkBox(t, ONBOARDING);
  for (const [args, env] of [[["up", "--print-link"], {}], [["up"], { VYRE_LINK_ONLY: "1" }]]) {
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...box.env, ...env } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "VYRE_LINK=http://127.0.0.1:7300/onboard?t=abc123\nVYRE_SSH=ssh -N -L 7300:127.0.0.1:7300 alex@203.0.113.4\n");
  }
});

test("box/vyre: up --print-link after onboarding gives the address, and fails with no link", t => {
  const done = linkBox(t, `  vyred is already running · 0.3.0 · box\n  your address: ${E}[32mhttps://alex.vyre.run${E}[0m\n`);
  const r = spawnSync("sh", [WRAPPER, "up", "--print-link"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: done.env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "VYRE_LINK=https://alex.vyre.run\n");

  const none = linkBox(t, "  onboarding is not available: something broke\n");
  const bad = spawnSync("sh", [WRAPPER, "up", "--print-link"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: none.env });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /something broke[\s\S]*vyre up printed no link/);
});

test("install-box.sh: --print-link ends with only the machine-readable lines on stdout", t => {
  const up = path.join(tempHome(t), "up.txt");
  fs.writeFileSync(up, ONBOARDING);
  const r = runScript(t, ["--yes", "--print-link", "--from", REPO], UP_PRINTS, () => {}, { VYRE_TEST_UP: up });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "VYRE_LINK=http://127.0.0.1:7300/onboard?t=abc123\nVYRE_SSH=ssh -N -L 7300:127.0.0.1:7300 alex@203.0.113.4\n");
  assert.match(r.stderr, /the stack goes in/);
  assert.ok(r.calls.includes("docker compose exec -T -e SSH_CONNECTION= -e VYRE_HOST_USER=alex vyre vyre up"), r.calls.join("\n"));
});
