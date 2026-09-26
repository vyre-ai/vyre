// @ts-check
// folder — one watcher on disk: ~/.vyre/watchers/<name>/watcher.json and watch.js.
//
// Claude writes these two files (the write-a-watcher skill); this reads and checks them. The
// checks are written for whoever made the mistake to fix it from the message alone, because
// that is usually Claude reading a tool result.
//
// The hash covers both files. watchers.create records it, and a run refuses a folder whose hash
// has moved on: an edited watcher must be dry-run and turned on again, so nothing the user did
// not see runs on a schedule, and a watcher cannot widen its own `needs` after approval.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "./cron.js";

export const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VAULT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const KIND = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
/** The longest a run may take, whatever watcher.json asks for. */
export const MAX_TIMEOUT_S = 300;
export const DEFAULT_TIMEOUT_S = 60;

/** @typedef {{ name: string, project: string, schedule: string, needs: string[], emits: string, timeout: number }} Spec */

/**
 * Read and check a watcher folder.
 * @param {string} root the watchers folder (~/.vyre/watchers)
 * @param {string} name
 * @returns {{ dir: string, spec: Spec|null, hash: string|null, problems: string[] }}
 */
export function read(root, name) {
  const problems = [];
  if (!NAME.test(String(name || "")) || name.length > 60) return { dir: "", spec: null, hash: null, problems: [`"${name}" is not a watcher name: lowercase words joined by dashes, like harlow-invoices`] };
  const dir = path.join(root, name);
  let json = "", code = "";
  try { json = fs.readFileSync(path.join(dir, "watcher.json"), "utf8"); } catch { problems.push(`${path.join(dir, "watcher.json")} is missing`); }
  try { code = fs.readFileSync(path.join(dir, "watch.js"), "utf8"); } catch { problems.push(`${path.join(dir, "watch.js")} is missing`); }
  if (problems.length) return { dir, spec: null, hash: null, problems };
  let raw;
  try { raw = JSON.parse(json); } catch (e) { return { dir, spec: null, hash: null, problems: ["watcher.json is not JSON: " + /** @type {Error} */ (e).message] }; }
  const spec = check(raw, name, problems);
  if (!/export\s+default\s+(async\s+)?function|export\s+default\s+async\s*\(|export\s*\{[^}]*\bas\s+default\b/.test(code)) {
    problems.push("watch.js must `export default async function watch({ vault, since, emit, log })`");
  }
  const hash = crypto.createHash("sha256").update(json).update("\0").update(code).digest("hex").slice(0, 32);
  return { dir, spec: problems.length ? null : spec, hash, problems };
}

/**
 * @param {any} raw
 * @param {string} name the folder's name
 * @param {string[]} problems
 * @returns {Spec}
 */
function check(raw, name, problems) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { problems.push("watcher.json must be an object"); return /** @type {any} */ (null); }
  if (raw.name !== name) problems.push(`watcher.json name "${raw.name}" must match its folder, "${name}"`);
  if (typeof raw.project !== "string" || !raw.project.trim()) problems.push("watcher.json needs project: the slug of the project items file into (vyre projects lists them)");
  const schedule = typeof raw.schedule === "string" ? raw.schedule.trim() : "";
  if (!schedule) problems.push('watcher.json needs schedule: cron like "*/15 * * * *", or "webhook"');
  else if (schedule !== "webhook") { try { parse(schedule); } catch (e) { problems.push(/** @type {Error} */ (e).message); } }
  const needs = raw.needs === undefined ? [] : raw.needs;
  if (!Array.isArray(needs) || needs.some(n => typeof n !== "string" || !VAULT_NAME.test(n))) problems.push("needs must be a list of vault item names");
  if (raw.emits !== undefined && (typeof raw.emits !== "string" || !KIND.test(raw.emits))) problems.push(`emits "${raw.emits}" must look like noun.past-verb, like invoice.seen`);
  const timeout = raw.timeout === undefined ? DEFAULT_TIMEOUT_S : raw.timeout;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_S) problems.push(`timeout is seconds, at most ${MAX_TIMEOUT_S}`);
  const extra = Object.keys(raw).filter(k => !["name", "project", "schedule", "needs", "emits", "timeout", "description"].includes(k));
  if (extra.length) problems.push(`watcher.json has keys the runtime does not read: ${extra.join(", ")}. Credentials go in the vault and are named under needs`);
  return { name, project: String(raw.project || "").trim(), schedule, needs: Array.isArray(needs) ? [...new Set(needs)] : [], emits: raw.emits || "watcher.item", timeout: Number(timeout) };
}

/** Every folder under the watchers folder, by name, whether valid or not. */
export function names(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name).sort(); }
  catch { return []; }
}
