// @ts-check
// The hub file (ADR 0035): <home>/hub.json, the one place a person edits Vyre's own settings by
// hand. It mirrors what is in effect (the settings_values table): every write here goes through
// write(), which adds 1 to rev and replaces the file atomically. A person's own edit is read back
// by the settings module, checked, and applied or held (index.js). Pure file helpers, no state.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HUB_FILE = "hub.json";

/** @typedef {{ rev: number, account: Record<string, any>, projects: Record<string, Record<string, any>>, devices: Record<string, Record<string, any>> }} Hub */

/** @param {string} root */
export const hubPath = root => path.join(root, HUB_FILE);

/** An empty hub. @returns {Hub} */
export const empty = () => ({ rev: 0, account: {}, projects: {}, devices: {} });

const plain = (/** @type {any} */ o) => (o && typeof o === "object" && !Array.isArray(o) ? o : {});

/**
 * The hub as the file says, or null when there is none. A file that isn't a JSON object throws,
 * with code "bad_hub", naming why; the caller keeps what is in effect.
 * @param {string} root @returns {Hub|null}
 */
export function readHub(root) {
  let text;
  try { text = fs.readFileSync(hubPath(root), "utf8"); } catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return null; throw e; }
  let o;
  try { o = JSON.parse(text); } catch (e) { throw Object.assign(new Error(`hub.json is not valid JSON: ${/** @type {Error} */ (e).message}`), { code: "bad_hub" }); }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw Object.assign(new Error("hub.json must be one JSON object"), { code: "bad_hub" });
  const projects = Object.fromEntries(Object.entries(plain(o.projects)).map(([k, v]) => [k, plain(v)]));
  const devices = Object.fromEntries(Object.entries(plain(o.devices)).map(([k, v]) => [k, plain(v)]));
  return { rev: Number.isInteger(o.rev) && o.rev >= 0 ? o.rev : 0, account: plain(o.account), projects, devices };
}

/** A digest of the file's bytes, so the watcher can tell its own writes from a person's. @param {string} text */
export const digest = text => crypto.createHash("sha256").update(text).digest("hex");

/**
 * Write the hub: `change` edits a copy, rev becomes `rev` (or the file's plus 1), and the file is
 * replaced in one rename. Key order is kept. Returns the new rev and the digest of what was written.
 * @param {string} root @param {(h: Hub) => void} change @param {{ rev?: number }} [o]
 * @returns {{ rev: number, digest: string }}
 */
export function writeHub(root, change, o = {}) {
  let h;
  try { h = readHub(root) || empty(); } catch { h = empty(); }
  change(h);
  h.rev = o.rev ?? h.rev + 1;
  // Empty project and device sections go; the file stays as small as what was set.
  for (const g of ["projects", "devices"]) for (const [k, v] of Object.entries(h[g])) if (!Object.keys(v).length) delete h[g][k];
  const text = JSON.stringify({ rev: h.rev, account: h.account, projects: h.projects, devices: h.devices }, null, 2) + "\n";
  const file = hubPath(root);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { rev: h.rev, digest: digest(text) };
}

/**
 * One level's values in a hub: account, or a project's.
 * @param {Hub} h @param {"account"|"project"} level @param {string|null} project
 */
export const levelOf = (h, level, project) => (level === "project" ? (h.projects[String(project)] ||= {}) : h.account);
