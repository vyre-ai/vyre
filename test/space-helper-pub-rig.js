// @ts-check
// The rig of the published-server half of the Space helper tests: appRig and the daemon's side (the folder it writes for a deployment).
import fs from "node:fs";
import path from "node:path";
import { appRig } from "./space-helper-apps-rig.js";

export const SPC = "spc_abcdefghijkl", SPC2 = "spc_mnopqrstuvwx", DEP = "dep_0123456789abcdef", DEP2 = "dep_fedcba9876543210";
export const REQUEST = (/** @type {Record<string, string>} */ over = {}) => Object.entries({ name: "northwind", version: "3", port: "8080", mem: "512", cpus: "0.5", pids: "256", health_path: "/", health_ok: "200+404", health_start: "60", secrets: "-", ...over }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
export const read = (/** @type {string} */ p) => fs.readFileSync(p, "utf8");

/** A ready helper, and the daemon's side: the folder it writes for a deployment. */
export async function ready(/** @type {import("node:test").TestContext} */ t) {
  const r = appRig(t);
  await r.prime();
  const servers = path.join(r.F, "lend", "publish", SPC, "servers");
  fs.mkdirSync(servers, { recursive: true });
  /** @param {string} dep @param {{ request?: string, files?: Record<string, string>, secrets?: Record<string, string>, space?: string }} [o] */
  const write = (dep, o = {}) => {
    const dirOf = path.join(r.F, "lend", "publish", o.space || SPC, "servers");
    fs.mkdirSync(dirOf, { recursive: true });
    const d = path.join(dirOf, dep);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    if (o.request !== null) fs.writeFileSync(path.join(d, "request"), o.request ?? REQUEST());
    if (o.files) for (const [f, text] of Object.entries(o.files)) { fs.mkdirSync(path.dirname(path.join(d, "ctx", f)), { recursive: true }); fs.writeFileSync(path.join(d, "ctx", f), text); }
    if (o.secrets) { fs.mkdirSync(path.join(d, "secrets")); for (const [n, v] of Object.entries(o.secrets)) fs.writeFileSync(path.join(d, "secrets", n), v); }
    return d;
  };
  const GOOD = { "Dockerfile": "FROM node:22-alpine\nCOPY server.js .\nEXPOSE 8080\nCMD [\"node\", \"server.js\"]\n", "server.js": "x" };
  const ask = async (/** @type {string} */ line) => { const id = r.ask(line + "\n"); await r.helper(); return r.status(id); };
  const build = async (dep = DEP, o = {}) => { write(dep, { files: GOOD, ...o }); return ask(`pub-build ${dep}`); };
  const up = async (dep = DEP, o = {}) => { write(dep, o); return ask(`pub-up ${dep}`); };
  const rec = (dep = DEP) => path.join(r.priv, "pub", dep, "rec");
  return { ...r, write, ask, build, up, rec, servers, GOOD };
}

