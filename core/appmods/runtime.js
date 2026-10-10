// @ts-check
// The runtime of an app module: one container per app per Space, started from a pinned image with memory, CPU and process limits, no capabilities, a folder of its own for its data, and no way out
// but the one door the manifest names. A driver is where that happens. This file is the docker-direct driver: vyred reaches Docker itself (a development machine, a Mac server, a test box). A server whose vyred
// runs in a container without Docker has its host helper do the same from root's own copies (a later driver, same interface).
//
//   up(plan)      make the network, volumes and container; start; resolve where the app is reached from vyred -> { origin, gateway }
//   exec(plan, argv, { env, files })   run one command in the running app (the bootstrap)   -> { code, stdout, stderr }
//   status(plan)  -> { state: "running" | "stopped" | "missing", health }
//   stop(plan) / down(plan, { data })    stop; or remove the container, network, rules and (with data) volumes
//
// Everything that touches the machine goes through `runner(args, opt)`, so the whole driver is tested without Docker; test boxes run it for real.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LABEL = "run.vyre.appmod";
const SAFE = /^[a-z][a-z0-9-]{0,60}$/;

/** The names an app uses on the machine. @param {string} space @param {string} module */
export function namesOf(space, module) {
  const s = String(space).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "space";
  const base = `vyre-app-${s}-${module}`;
  if (!SAFE.test(base)) throw Object.assign(new Error(`not a name an app can run under: ${base}`), { code: "bad_name" });
  return { base, container: base, network: `${base}_net`, volume: (/** @type {string} */ v) => `${base}_${v}` };
}

/** Fill {placeholder}s in a value. Unknown ones are left alone (the manifest check refuses them before). @param {string} v @param {Record<string, string>} vars */
export const fill = (v, vars) => String(v).replace(/\{([a-z_]+)\}/g, (m, k) => (k in vars ? vars[k] : m));

/**
 * What `docker run` is given, as an argv, for a plan. No secret is in it: environment values travel in an env file (mode 0600, deleted after the container started).
 * @param {{ names: ReturnType<typeof namesOf>, manifest: any, envFile: string, hostPort?: boolean }} p
 */
export function runArgs(p) {
  const a = p.manifest.app, n = p.names;
  const args = ["run", "-d", "--name", n.container, "--restart", "unless-stopped", "--network", n.network,
    "--label", `${LABEL}=1`, "--label", `${LABEL}.module=${p.manifest.name}`,
    "--memory", `${a.limits.memoryMb}m`, "--memory-swap", `${a.limits.memoryMb}m`, "--cpus", String(a.limits.cpus), "--pids-limit", String(a.limits.pids),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--init",
    "--env-file", p.envFile];
  for (const v of a.volumes || []) args.push("-v", `${n.volume(v.name)}:${v.path}`);
  if (a.readOnly) args.push("--read-only", "--tmpfs", "/tmp:rw,size=64m,mode=1777");
  if (p.hostPort !== false) args.push("-p", `127.0.0.1::${a.port}`);
  args.push(a.image);
  return args;
}

/** The env file's text: plain values filled in, secrets from the Vault. Newlines in a value would make a second variable, so they are refused. @param {any} manifest @param {Record<string, string>} vars @param {Record<string, string>} secrets */
export function envText(manifest, vars, secrets) {
  const lines = [];
  for (const [k, v] of Object.entries(manifest.app.env || {})) lines.push([k, fill(/** @type {string} */ (v), vars)]);
  for (const [k, v] of Object.entries(secrets || {})) lines.push([k, v]);
  for (const [k, v] of lines) if (/[\r\n\0]/.test(v)) throw Object.assign(new Error(`${k} holds a line break`), { code: "bad_env" });
  return lines.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

/** @param {string[]} args @param {{ input?: string, timeoutMs?: number }} [opt] @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
export function dockerRunner(args, opt = {}) {
  return new Promise(resolve => {
    const child = execFile("docker", args, { timeout: opt.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (/** @type {any} */ (err)).code === "number" ? /** @type {number} */ (/** @type {any} */ (err).code) : 1) : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || (err && err.message) || "") });
    });
    // A command that exits before it reads its input (or never reads it) resets the pipe: that is the command's answer (its exit code), not a crash of this process.
    if (child.stdin) child.stdin.on("error", () => {});
    if (opt.input !== undefined && child.stdin) child.stdin.end(opt.input);
  });
}

/** Run a command as root where this process is not (the firewall rules). The test seam is `sudo`. @param {string[]} argv */
function viaSudo(argv) {
  return new Promise(resolve => {
    const root = typeof process.getuid === "function" && process.getuid() === 0;
    execFile(root ? argv[0] : "sudo", root ? argv.slice(1) : ["-n", ...argv], { timeout: 20_000, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || (err && err.message) || "") });
    });
  });
}

/**
 * The docker-direct driver.
 * @param {{ runner?: (args: string[], opt?: any) => Promise<{ code: number, stdout: string, stderr: string }>, firewall?: (argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>, home: string, log?: (m: string) => void }} o
 */
export function createDockerDirect(o) {
  const run = o.runner || dockerRunner;
  const fw = o.firewall || viaSudo;
  const log = o.log || (() => {});
  const must = async (/** @type {string[]} */ args, /** @type {string} */ what, /** @type {any} */ opt) => {
    const r = await run(args, opt);
    if (r.code !== 0) throw Object.assign(new Error(`${what}: ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300) || `docker exited ${r.code}`}`), { code: "runtime" });
    return r;
  };
  const dir = (/** @type {string} */ space, /** @type {string} */ module) => path.join(o.home, "appmods", space, module);

  /** The network's gateway (where the app reaches the host) and subnet. @param {string} net */
  async function networkInfo(net) {
    const r = await must(["network", "inspect", net, "--format", "{{(index .IPAM.Config 0).Gateway}} {{(index .IPAM.Config 0).Subnet}}"], "inspect network");
    const [gateway, subnet] = r.stdout.trim().split(/\s+/);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(gateway || "") || !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet || "")) throw Object.assign(new Error("the app's network has no address"), { code: "runtime" });
    return { gateway, subnet };
  }

  /** The one door in: the host accepts the app's subnet on the hook port and nothing else (the host's own firewall drops the rest). @param {"-I"|"-D"} op @param {string} subnet @param {number} port */
  const doorRule = (op, subnet, port) => ["iptables", op, "INPUT", "-s", subnet, "-p", "tcp", "--dport", String(port), "-m", "comment", "--comment", "vyre-appmod", "-j", "ACCEPT"];

  return {
    kind: "docker-direct",

    /**
     * @param {{ space: string, manifest: any, vars: Record<string, string>, secrets: Record<string, string>, hookPort?: number }} p
     * @returns {Promise<{ origin: string, gateway: string, subnet: string, hookHost: string }>}
     */
    async up(p) {
      const n = namesOf(p.space, p.manifest.name);
      const have = await run(["inspect", n.container, "--format", "{{.State.Running}}"]);
      if (have.code !== 0) {
        // The network does not masquerade: an app on it can reach the host and its neighbours on the bridge, and nothing beyond (its packets leave with an address the world cannot answer).
        const net = await run(["network", "inspect", n.network]);
        if (net.code !== 0) await must(["network", "create", "--driver", "bridge", "-o", "com.docker.network.bridge.enable_ip_masquerade=false", "--label", `${LABEL}=1`, n.network], "create network");
        for (const v of p.manifest.app.volumes || []) await must(["volume", "create", "--label", `${LABEL}=1`, n.volume(v.name)], "create volume");
        const d = dir(p.space, p.manifest.name);
        fs.mkdirSync(d, { recursive: true, mode: 0o700 });
        const envFile = path.join(d, "env");
        fs.writeFileSync(envFile, envText(p.manifest, p.vars, p.secrets), { mode: 0o600 });
        try { await must(runArgs({ names: n, manifest: p.manifest, envFile }), "start the app"); }
        finally { try { fs.rmSync(envFile, { force: true }); } catch { /* gone */ } }
      } else if (have.stdout.trim() !== "true") await must(["start", n.container], "start the app");
      const { gateway, subnet } = await networkInfo(n.network);
      if ((p.manifest.app.egress || []).includes("vyred") && p.hookPort) {
        const chk = await fw(["iptables", "-C", "INPUT", ...doorRule("-I", subnet, p.hookPort).slice(3)]);
        if (chk.code !== 0) {
          const r = await fw(doorRule("-I", subnet, p.hookPort));
          if (r.code !== 0) log(`appmods: could not open the hook door for ${n.container}: ${r.stderr.trim().slice(0, 120)}`);
        }
      }
      const port = await must(["port", n.container, `${p.manifest.app.port}/tcp`], "find the app's port");
      const m = /127\.0\.0\.1:(\d+)/.exec(port.stdout) || /:(\d+)\s*$/m.exec(port.stdout);
      if (!m) throw Object.assign(new Error("the app has no port on this machine"), { code: "runtime" });
      return { origin: `http://127.0.0.1:${m[1]}`, gateway, subnet, hookHost: gateway };
    },

    /** Run one command in the app. Files are copied in first (the bootstrap script), then removed. @param {{ space: string, manifest: any }} p @param {string[]} argv @param {{ env?: Record<string, string>, files?: { name: string, text: string }[], timeoutMs?: number }} [opt] */
    async exec(p, argv, opt = {}) {
      const n = namesOf(p.space, p.manifest.name);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-appmod-"));
      const inside = [];
      try {
        for (const f of opt.files || []) {
          if (!/^[a-z0-9][a-z0-9._-]*$/.test(f.name)) throw Object.assign(new Error("not a file name"), { code: "bad_name" });
          const host = path.join(tmp, f.name);
          // readable by the app's user: a container with no capabilities cannot read a file it does not own through root's power. These are catalog scripts, never secrets.
          fs.writeFileSync(host, f.text, { mode: 0o644 });
          await must(["cp", host, `${n.container}:/tmp/${f.name}`], "copy into the app");
          inside.push(`/tmp/${f.name}`);
        }
        const envArgs = Object.entries(opt.env || {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
        const cmd = argv.map(x => (x === "{file}" ? inside[0] : x));
        const r = await run(["exec", ...envArgs, "-w", "/app", n.container, ...cmd], { timeoutMs: opt.timeoutMs ?? 180_000 });
        for (const f of inside) await run(["exec", n.container, "rm", "-f", f]);
        return r;
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    },

    /** @param {{ space: string, manifest: any }} p */
    async status(p) {
      const n = namesOf(p.space, p.manifest.name);
      const r = await run(["inspect", n.container, "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}"]);
      if (r.code !== 0) return { state: "missing", detail: "" };
      const [st] = r.stdout.trim().split(/\s+/);
      return { state: st === "running" ? "running" : "stopped", detail: st };
    },

    /** @param {{ space: string, manifest: any }} p */
    async stop(p) { await run(["stop", "-t", "20", namesOf(p.space, p.manifest.name).container]); },

    /** Remove the container, the network and the door; with `data`, the volumes too. @param {{ space: string, manifest: any, hookPort?: number }} p @param {{ data?: boolean }} [opt] */
    async down(p, opt = {}) {
      const n = namesOf(p.space, p.manifest.name);
      let subnet = "";
      try { subnet = (await networkInfo(n.network)).subnet; } catch { /* no network */ }
      await run(["rm", "-f", n.container]);
      if (subnet && p.hookPort) await fw(doorRule("-D", subnet, p.hookPort));
      await run(["network", "rm", n.network]);
      if (opt.data) for (const v of p.manifest.app.volumes || []) await run(["volume", "rm", "-f", n.volume(v.name)]);
      try { fs.rmSync(dir(p.space, p.manifest.name), { recursive: true, force: true }); } catch { /* gone */ }
    },

    /** The last lines the app wrote. @param {{ space: string, manifest: any }} p @param {number} [lines] */
    async logs(p, lines = 100) { const r = await run(["logs", "--tail", String(lines), namesOf(p.space, p.manifest.name).container]); return (r.stdout + r.stderr).slice(-8000); },
  };
}
