// @ts-check
// lib/publish/secrets.js: deployment secrets are explicit grants, never inherited (SPEC 13), and a build is refused
// if a sealed value appears in its output or logs (SPEC 8.5).
//
// A secret reaches a build only as a BuildKit `--secret` file and reaches a workload only as a runtime secret file,
// both for that one deployment. Never an image layer, never an env value, never another deployment.
// Pure: reading a secret and writing a file are injected.

import { valueForms as scrubForms, compact } from "../scrub.js";
import { fail, humanDecider, assertChain, ENV_NAME_RE, SECRET_REF_RE, isSpaceEnvName, secretUrn, deploymentUrn, safeEqual } from "./util.js";

/** The classes of a secret reference. `secret` always needs a person's approval to grant. */
export const SECRET_CLASSES = Object.freeze(["secret", "config"]);
export const USES = Object.freeze(["build", "runtime"]);

/**
 * Grant one secret to one deployment. Returns the new deployment record (the grant is stored on it, so a later
 * deployment starts with none). Never inherits: nothing is read from `previous`.
 * @param {any} deployment
 * @param {string} secretRef  vault://...
 * @param {{
 *   by: any, name: string, class: string, use?: string[], now: number,
 *   authz: any, approval?: any, roles?: { roleOf(actorId: string): string | null | undefined }, payload_hash?: string,
 * }} opts
 */
export function grantSecret(deployment, secretRef, opts) {
  if (!deployment || typeof deployment !== "object") fail("bad_input", "a deployment is required");
  const chain = assertChain(opts && opts.by);
  if (chain.space !== deployment.space) fail("forbidden", "the chain is not in this space");
  if (typeof secretRef !== "string" || !SECRET_REF_RE.test(secretRef) || secretRef.split("/").includes("..")) fail("bad_secret", "that is not a secret reference");
  const { name } = opts;
  if (!ENV_NAME_RE.test(name) || isSpaceEnvName(name)) fail("bad_secret", "that name belongs to the space or is not a valid name; pick another");
  if (!SECRET_CLASSES.includes(opts.class)) fail("bad_secret", "the secret's class is unknown");
  const use = (opts.use && opts.use.length ? opts.use : ["runtime"]);
  if (!use.every(u => USES.includes(u))) fail("bad_input", "use is build, runtime or both");
  if (deployment.stage === "Retired") fail("illegal_transition", "a retired deployment takes no new secrets");
  const authz = opts.authz;
  if (!authz || authz.effect === "deny" || (authz.effect !== "allow" && authz.effect !== "ask")) fail("forbidden", `not allowed: ${authz && authz.reason || "no_grant"}`);
  if (authz.action && authz.action !== "deploy.secret") fail("forbidden", "the authorization was for a different action");
  if (authz.resource && authz.resource !== secretUrn(deployment.space, secretRef)) fail("forbidden", "the authorization was for a different secret");
  // A grant of a real secret needs a person (and never a model) to approve it.
  if (opts.class === "secret" || authz.effect === "ask") {
    const a = opts.approval;
    if (!a || a.outcome !== "approved") fail("needs_approval", "a person must approve giving this secret to this deployment");
    const person = humanDecider(a.by, deployment.space);
    if (!opts.payload_hash || a.payload_hash !== opts.payload_hash) fail("approval_mismatch", "the approval was for something different");
    const role = opts.roles && opts.roles.roleOf(person);
    if (role !== "owner" && role !== "admin") fail("not_approver", "only an owner or an admin can give out a secret");
  }
  const existing = deployment.secrets || [];
  if (existing.some((/** @type {any} */ s) => s.name === name)) fail("duplicate", `${name} is already granted to this deployment`);
  if (existing.length >= 20) fail("bad_secret", "a deployment can hold at most 20 secrets");
  const entry = { name, ref: secretRef, class: opts.class, use, granted_by: chain.hops[chain.hops.length - 1].actor.id, granted_at: opts.now, resource: deploymentUrn(deployment.space, deployment.id) };
  return { ...deployment, secrets: [...existing, entry], updated_at: opts.now };
}

/** @param {any} deployment @param {string} name */
export function revokeSecret(deployment, name, now) {
  const existing = deployment.secrets || [];
  if (!existing.some((/** @type {any} */ s) => s.name === name)) fail("not_found", `${name} is not granted`);
  return { ...deployment, secrets: existing.filter((/** @type {any} */ s) => s.name !== name), updated_at: now };
}

/** Names of the secrets this deployment may use, by use. Reads only the deployment's own grants. @param {any} d @param {"build"|"runtime"} use */
export const grantedFor = (d, use) => (d.secrets || []).filter((/** @type {any} */ s) => s.use.includes(use));

/** Env entries a deployment declares but nobody granted: they will be absent, and the plan says so. @param {any} d */
export const ungrantedEnv = d => Object.entries(d.env || {}).filter(([k, ref]) => !(d.secrets || []).some((/** @type {any} */ s) => s.name === k && s.ref === ref)).map(([k]) => k);

/**
 * Write this deployment's secrets as files for BuildKit (`--secret id=NAME,src=FILE`) or the workload.
 * Only this deployment's grants are read. Returns the CLI args and the values (for redaction), never logs a value.
 * @param {any} deployment
 * @param {"build"|"runtime"} use
 * @param {{ dir: string, readSecret(ref: string, ctx: { deployment: string, purpose: string }): Promise<string>, writeFile(path: string, value: string, opts: { mode: number }): Promise<void> }} io
 */
export async function prepareSecrets(deployment, use, io) {
  const args = [], files = [], values = new Map();
  for (const s of grantedFor(deployment, use)) {
    const path = `${io.dir}/${deployment.id}/${s.name}`;
    const value = await io.readSecret(s.ref, { deployment: deployment.id, purpose: use });
    if (typeof value !== "string" || value.length === 0) fail("bad_secret", `${s.name} could not be read`);
    await io.writeFile(path, value, { mode: 0o400 });
    args.push("--secret", `id=${s.name},src=${path}`);
    files.push({ name: s.name, path });
    values.set(s.name, value);
  }
  return { args, files, values };
}

// ---- value forms, redaction, scanning ----

const MIN_FUZZY = 6;

export { compact };

/** @param {string} s @returns {string[]} the encodings a value is commonly seen in (lib/scrub.js, the wide set) */
export const valueForms = s => scrubForms(s, { wide: true });

/**
 * Replace every secret value (and its common encodings) in a log with a name tag.
 * @param {string} text @param {Map<string, string> | Record<string, string>} secrets name to value
 */
export function redact(text, secrets) {
  let out = String(text);
  const entries = secrets instanceof Map ? [...secrets] : Object.entries(secrets);
  for (const [name, value] of entries) {
    if (!value) continue;
    const tag = `[secret:${name}]`;
    const forms = new Set(valueForms(value));
    // Multi-line values (keys): also redact each long line on its own.
    for (const line of value.split(/\r?\n/)) if (line.trim().length >= 8) forms.add(line.trim());
    for (const f of [...forms].sort((a, b) => b.length - a.length)) if (out.includes(f)) out = out.split(f).join(tag);
  }
  return out;
}

const printable = (/** @type {string} */ s) => { if (!s.length) return false; let p = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) p++; } return p / s.length >= 0.85; };

/** @param {string} text @returns {Array<{ form: string, text: string }>} the text and its decoded readings (url, base64, hex), two levels deep */
export function readings(text) {
  /** @type {Array<{ form: string, text: string }>} */
  const out = [{ form: "raw", text }];
  const seen = new Set([text]);
  const add = (/** @type {string} */ form, /** @type {string} */ t) => { if (t && !seen.has(t) && out.length < 16) { seen.add(t); out.push({ form, text: t }); } };
  const decoders = {
    url: (/** @type {string} */ t) => t.includes("%") || t.includes("+") ? t.replace(/(?:%[0-9a-fA-F]{2})+/g, m => { try { return decodeURIComponent(m); } catch { return m; } }).replace(/\+/g, " ") : "",
    base64: (/** @type {string} */ t) => {
      const parts = [];
      for (const m of t.matchAll(/[A-Za-z0-9+\/_-]{10,}={0,2}/g)) {
        const d = Buffer.from(m[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
        if (printable(d)) parts.push(d);
      }
      return parts.join("\n");
    },
    hex: (/** @type {string} */ t) => {
      const parts = [];
      for (const m of t.matchAll(/(?:[0-9a-fA-F]{2}){6,}/g)) { const d = Buffer.from(m[0], "hex").toString("latin1"); if (printable(d)) parts.push(d); }
      return parts.join("\n");
    },
  };
  for (let depth = 0; depth < 2; depth++) {
    for (const r of [...out]) for (const [form, fn] of Object.entries(decoders)) add(r.form === "raw" ? form : `${r.form}+${form}`, fn(r.text));
  }
  return out;
}

const asText = (/** @type {any} */ c) => typeof c === "string" ? c : Buffer.from(c).toString("latin1");

/**
 * @typedef {{ files?: Array<{ path: string, content: string | Uint8Array }>, logs?: string }} BuildOutput
 * @typedef {{ lengths(): number[], has(candidate: string): boolean | string }} SealLedger
 *   `has` receives lowercase letters and digits only (the normalised form); a string result names the class.
 */

const WINDOW_CAP = 6_000_000;

/**
 * Refuse a build whose output or logs contain a sealed value the ledger knows, in its exact form or any of: other
 * case, spaces or separators, base64, hex, url-encoding (SPEC 8.5). Findings carry the place and form, never the value.
 * @param {BuildOutput} output @param {SealLedger} ledger
 * @returns {{ ok: boolean, findings: Array<{ where: "file" | "log" | "path", path?: string, form: string, class?: string }>, unverifiable?: boolean }}
 */
export function checkBuildForSealed(output, ledger) {
  const lengths = [...new Set((ledger && ledger.lengths ? ledger.lengths() : []).filter(n => Number.isInteger(n) && n >= 4 && n <= 128))].sort((a, b) => a - b);
  /** @type {Array<{ where: "file" | "log" | "path", path?: string, form: string, class?: string }>} */
  const findings = [];
  let windows = 0, unverifiable = false;
  if (!lengths.length) return { ok: true, findings };
  /** @param {"file"|"log"|"path"} where @param {string | undefined} path @param {string} text */
  const scan = (where, path, text) => {
    for (const r of readings(text)) {
      const c = compact(r.text);
      let hit = false;
      for (const L of lengths) {
        if (c.length < L) continue;
        windows += c.length - L + 1;
        if (windows > WINDOW_CAP) { unverifiable = true; return; }
        for (let i = 0; i + L <= c.length; i++) {
          const h = ledger.has(c.slice(i, i + L));
          if (h) { findings.push({ where, ...(path ? { path } : {}), form: r.form, ...(typeof h === "string" ? { class: h } : {}) }); hit = true; break; }
        }
        if (hit) break;
      }
      if (hit) return; // one finding per place is enough to refuse
    }
  };
  for (const f of output.files || []) {
    scan("path", f.path, f.path);
    scan("file", f.path, asText(f.content));
    if (unverifiable) break;
  }
  if (!unverifiable && output.logs) scan("log", undefined, output.logs);
  if (unverifiable) return { ok: false, findings, unverifiable: true };
  return { ok: findings.length === 0, findings };
}

/**
 * Refuse a build whose output holds one of the deployment's own secret values (a key baked into a public bundle).
 * @param {BuildOutput} output @param {Map<string, string>} values name to value
 */
export function checkBuildForSecrets(output, values) {
  /** @type {Array<{ where: "file" | "log", path?: string, name: string, form: string }>} */
  const findings = [];
  const targets = [...(output.files || []).map(f => ({ where: /** @type {const} */ ("file"), path: f.path, text: asText(f.content) })), ...(output.logs ? [{ where: /** @type {const} */ ("log"), path: undefined, text: output.logs }] : [])];
  for (const [name, value] of values) {
    if (!value) continue;
    const cv = compact(value), fuzzy = cv.length >= MIN_FUZZY;
    const forms = valueForms(value);
    for (const t of targets) {
      for (const r of readings(t.text)) {
        const c = fuzzy ? compact(r.text) : "";
        if ((fuzzy && c.includes(cv)) || r.text.includes(value) || (r.form === "raw" && forms.some(f => r.text.includes(f)))) {
          findings.push({ where: t.where, ...(t.path ? { path: t.path } : {}), name, form: r.form });
          break;
        }
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

export { safeEqual };
