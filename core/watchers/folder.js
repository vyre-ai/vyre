// @ts-check
// folder: one watcher on disk: ~/.vyre/watchers/<name>/watcher.json and watch.js.
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

/**
 * A watcher's spec. `on` and `where` are for schedule "event": the event type it runs on, and the
 * payload fields that must match for it to run (hook.received needs a route).
 * @typedef {{ name: string, project: string, schedule: string, needs: string[], emits: string, timeout: number,
 *   on: string|null, where: Record<string, string|number|boolean>|null,
 *   net: Record<string, { vault?: string, credential?: string, field?: string, header: string, scheme: string }>|null,
 *   ask: { dailyUsd: number }|null, summary: { when: string, check?: string, do: string }|null,
 *   owner: { kind: "teammate", teammate: string }|null, instruction: string|null, act: boolean, when: string|null }} Spec
 */

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
  // An event trigger: "on" names the event, "where" the payload fields it must carry. The
  // schedule is then "event", written or not.
  const on = raw.on === undefined ? null : raw.on;
  if (on !== null && (typeof on !== "string" || !KIND.test(on))) problems.push(`on "${on}" must be an event type like hook.received`);
  const where = checkWhere(raw.where, on, problems);
  const schedule = typeof raw.schedule === "string" ? raw.schedule.trim() : on !== null ? "event" : "";
  if (!schedule) problems.push('watcher.json needs schedule: cron like "*/15 * * * *", "webhook", or an event to run on with on and where');
  else if (on !== null && schedule !== "event") problems.push(`a watcher with on runs on that event; its schedule must be "event" or left out, not "${schedule}"`);
  else if (schedule === "event" && on === null) problems.push('schedule "event" needs on: the event type to run on, like hook.received');
  else if (schedule !== "webhook" && schedule !== "event") { try { parse(schedule); } catch (e) { problems.push(/** @type {Error} */ (e).message); } }
  if (raw.needs !== undefined && !(Array.isArray(raw.needs) && !raw.needs.length)) problems.push('needs is retired: a watcher never holds a credential. Name the host and the vault item under net, like { "net": { "api.example.com": { "vault": "billing-inbox" } } }, and Vyre attaches it to that host\'s requests');
  const needs = [];
  if (raw.emits !== undefined && (typeof raw.emits !== "string" || !KIND.test(raw.emits))) problems.push(`emits "${raw.emits}" must look like noun.past-verb, like invoice.seen`);
  const timeout = raw.timeout === undefined ? DEFAULT_TIMEOUT_S : raw.timeout;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_S) problems.push(`timeout is seconds, at most ${MAX_TIMEOUT_S}`);
  const net = checkNet(raw.net, problems);
  const owner = checkOwner(raw.owner, problems);
  const summary = checkSummary(raw.summary, problems);
  let ask = null;
  if (raw.ask !== undefined) {
    const a = raw.ask;
    if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).some(k => k !== "dailyUsd") || !(a.dailyUsd > 0 && a.dailyUsd <= 5)) problems.push('ask is { "dailyUsd": 0.25 }: the most this watcher may spend on a model in a day, up to 5');
    else ask = { dailyUsd: Number(a.dailyUsd) };
  }
  if (raw.instruction !== undefined && (typeof raw.instruction !== "string" || !raw.instruction.trim() || raw.instruction.length > 2000)) problems.push("instruction is plain words, at most 2000 characters");
  if (raw.act !== undefined && typeof raw.act !== "boolean") problems.push("act is true or false");
  if (raw.act !== undefined && !owner) problems.push("act is for a teammate's duty: it needs owner");
  const extra = Object.keys(raw).filter(k => !["name", "project", "schedule", "needs", "emits", "timeout", "description", "on", "where", "net", "owner", "instruction", "act", "when", "ask", "summary"].includes(k));
  if (extra.length) problems.push(`watcher.json has keys the runtime does not read: ${extra.join(", ")}. Credentials go in the vault and are named under needs`);
  // A vault item named by net is fetched by the parent and attached to that host's requests only,
  // so it counts as a need: the same per-watcher grant covers it.
  const needed = new Set(Array.isArray(needs) ? needs : []);
  for (const h of Object.values(net || {})) { if (h.vault) needed.add(h.vault); if (h.credential) needed.add(h.credential); }
  return { name, project: String(raw.project || "").trim(), schedule, needs: [...needed], net, ask, summary, owner, when: typeof raw.when === "string" ? raw.when.slice(0, 200) : null, instruction: typeof raw.instruction === "string" ? raw.instruction.trim() : null, act: raw.act === true, emits: raw.emits || "watcher.item", timeout: Number(timeout),
    on: typeof on === "string" ? on : null, where };
}

/**
 * `summary`: the card's words for the parts the runtime cannot read out of code: { when, check?, do }
 * in plain sentences. Descriptive only. What a watcher reads from, whether it can act and what it
 * costs are worked out from the folder itself (runtime.card) and never taken from here.
 * @returns {Spec["summary"]}
 */
function checkSummary(v, problems) {
  if (v === undefined) return null;
  const o = /** @type {any} */ (v);
  const ok = o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every(k => ["when", "check", "do"].includes(k))
    && ["when", "do"].every(k => typeof o[k] === "string" && o[k].trim() && o[k].length <= 240) && (o.check === undefined || (typeof o.check === "string" && o.check.length <= 240));
  if (!ok) { problems.push('summary is { "when": "...", "check": "..." (optional), "do": "..." }: one plain sentence each, at most 240 characters'); return null; }
  return { when: o.when.trim(), ...(o.check ? { check: o.check.trim() } : {}), do: o.do.trim() };
}

/** @returns {Spec["owner"]} */
export function checkOwner(owner, problems) {
  if (owner === undefined) return null;
  const o = /** @type {any} */ (owner);
  if (!o || o.kind !== "teammate" || typeof o.teammate !== "string" || !/^[a-z][a-z0-9-]{0,80}$/.test(o.teammate) || Object.keys(o).some(k => k !== "kind" && k !== "teammate")) {
    problems.push('owner is { "kind": "teammate", "teammate": "<role>-<project>" }');
    return null;
  }
  return { kind: "teammate", teammate: o.teammate };
}

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,40}$/;

/**
 * `net`: the hosts a watcher reads, each optionally with the vault item the parent attaches to
 * requests for that host only: { "api.harlow.example": { "vault": "harlow-feed", "header":
 * "Authorization", "scheme": "Bearer" } }, or an api-credential the vault calls the API with
 * itself, reads only: { "gmail.googleapis.com": { "credential": "google-personal" } }. With net, a watcher reaches those hosts
 * exact host names) and no others; without it, no network at all. The watcher's own code
 * never handles the value.
 * @returns {Spec["net"]}
 */
function checkNet(net, problems) {
  if (net === undefined) return null;
  if (!net || typeof net !== "object" || Array.isArray(net) || !Object.keys(net).length) { problems.push('net must be an object of hosts, like { "api.example.com": {} }'); return null; }
  const out = {};
  for (const [host, v] of Object.entries(net)) {
    const h = /** @type {any} */ (v);
    if (!HOST.test(host)) { problems.push(`net host "${host}" must be a plain host name like api.example.com`); continue; }
    if (!h || typeof h !== "object" || Array.isArray(h)) { problems.push(`net.${host} must be an object, {} for no credential`); continue; }
    if (h.vault !== undefined && (typeof h.vault !== "string" || !VAULT_NAME.test(h.vault))) { problems.push(`net.${host}.vault must be a vault item name`); continue; }
    if (h.header !== undefined && (typeof h.header !== "string" || !HEADER.test(h.header))) { problems.push(`net.${host}.header must be a header name like Authorization`); continue; }
    if (h.credential !== undefined && (typeof h.credential !== "string" || !VAULT_NAME.test(h.credential) || h.vault !== undefined)) { problems.push(`net.${host}.credential must be the name of an api-credential, and not together with vault`); continue; }
    const bad = Object.keys(h).filter(k => !["vault", "credential", "field", "header", "scheme"].includes(k));
    if (bad.length) { problems.push(`net.${host} has keys the runtime does not read: ${bad.join(", ")}`); continue; }
    out[host] = { ...(h.vault ? { vault: h.vault } : {}), ...(h.credential ? { credential: h.credential } : {}), ...(h.field ? { field: String(h.field) } : {}), header: h.header || "Authorization", scheme: h.scheme === undefined ? "Bearer" : String(h.scheme) };
  }
  return out;
}

/**
 * `where`: payload fields an event must carry, each a string, number or boolean compared exactly.
 * A hook.received watcher must name its route, so one route's deliveries never reach a watcher
 * written for another.
 * @returns {Record<string, string|number|boolean>|null}
 */
function checkWhere(where, on, problems) {
  if (where === undefined) {
    if (on === "hook.received") problems.push('a hook.received watcher needs where: { "route": "<the hook route>" }');
    return null;
  }
  if (on === null) { problems.push("where is for a watcher with on"); return null; }
  if (!where || typeof where !== "object" || Array.isArray(where)) { problems.push("where must be an object of payload fields"); return null; }
  const out = {};
  for (const [k, v] of Object.entries(where)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) || !["string", "number", "boolean"].includes(typeof v)) { problems.push(`where.${k} must be a string, number or boolean`); continue; }
    out[k] = v;
  }
  if (Object.keys(out).length > 8) problems.push("where takes at most 8 fields");
  if (on === "hook.received" && typeof out.route !== "string") problems.push('a hook.received watcher needs where: { "route": "<the hook route>" }');
  return out;
}

/** Does an event's payload carry every field `where` names, with the same value? */
export function matches(where, payload) {
  if (!where) return true;
  if (!payload || typeof payload !== "object") return false;
  return Object.entries(where).every(([k, v]) => payload[k] === v);
}

/** Every folder under the watchers folder, by name, whether valid or not. */
export function names(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name).sort(); }
  catch { return []; }
}
