// @ts-check
// lib/publish/server-folder.js: how the daemon hands a site's server to the root host helper (box/vyre `pub-build|pub-up|pub-stop|pub-down`, team/contracts/builder.md). The daemon cannot run Docker on a
// server that has the helper, so it writes what the helper needs into a folder it owns, <home>/publish/<space>/servers/<deployment>/ (`ctx/` the build context, `request` the settings, `secrets/NAME` the
// granted runtime secrets), and asks by the deployment's id alone. Root takes the folder by rename and judges every byte of it; nothing here is trusted on the other side. Pure file writing.
import fs from "node:fs";
import path from "node:path";

export const DEP_RE = /^dep_[0-9a-f]{16}$/;
const SPACE_RE = /^spc_[a-z0-9]{12}$/;
/** The helper's request line carries a deployment id and nothing else. */
export const HELPER_NAME = DEP_RE;

/**
 * The settings file: one `key=value` per line, in the keys the helper knows and no others.
 * @param {{ name: string, version: number, port: number, memoryMb: number, cpus: number, pids: number, health: { path: string, ok: number[], startS?: number }, secrets?: string[] }} f
 */
export function requestText(f) {
  const lines = [`name=${f.name}`, `version=${Math.max(1, Math.floor(f.version) || 1)}`, `port=${f.port}`, `mem=${f.memoryMb}`, `cpus=${f.cpus}`, `pids=${f.pids}`,
    `health_path=${f.health.path}`, `health_ok=${f.health.ok.join("+")}`, `health_start=${f.health.startS || 60}`, `secrets=${f.secrets && f.secrets.length ? f.secrets.join("+") : "-"}`];
  return lines.join("\n") + "\n";
}

/**
 * Write the folder the helper takes: replaces any earlier one for the deployment. Every path is rebuilt from the Space's id and the deployment's id, never taken from a caller.
 * @param {{ home: string, space: string, deployment: string, request: string, files?: { path: string, content: Buffer | string }[], secrets?: Record<string, string> }} o
 * @returns {string} the folder
 */
export function writeServerFolder(o) {
  if (!SPACE_RE.test(o.space)) throw Object.assign(new Error("not a Space"), { code: "bad_input" });
  if (!DEP_RE.test(o.deployment)) throw Object.assign(new Error("not a deployment"), { code: "bad_input" });
  const servers = path.join(o.home, "publish", o.space, "servers");
  fs.mkdirSync(servers, { recursive: true, mode: 0o700 });
  const dir = path.join(servers, o.deployment);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "request"), o.request, { mode: 0o600 });
  if (o.files) {
    const ctx = path.join(dir, "ctx");
    fs.mkdirSync(ctx, { mode: 0o755 });
    for (const f of o.files) {
      const to = path.join(ctx, f.path);
      if (!to.startsWith(ctx + path.sep)) throw Object.assign(new Error("a file path leaves the folder"), { code: "refused" });
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
      fs.writeFileSync(to, f.content, { mode: 0o644 });
    }
  }
  if (o.secrets && Object.keys(o.secrets).length) {
    const sd = path.join(dir, "secrets");
    fs.mkdirSync(sd, { mode: 0o700 });
    for (const [n, v] of Object.entries(o.secrets)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(n)) throw Object.assign(new Error(`${n} is not a name an environment variable can have`), { code: "bad_input" });
      fs.writeFileSync(path.join(sd, n), String(v), { mode: 0o600 });
    }
  }
  return dir;
}

/** Take the folder away (the helper normally has, by renaming it; this is for a request that never reached it). @param {{ home: string, space: string, deployment: string }} o */
export function removeServerFolder(o) {
  if (!SPACE_RE.test(o.space) || !DEP_RE.test(o.deployment)) return;
  fs.rmSync(path.join(o.home, "publish", o.space, "servers", o.deployment), { recursive: true, force: true });
}
