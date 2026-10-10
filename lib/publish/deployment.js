// @ts-check
// lib/publish/deployment.js: the `deployment` record type (a language definition, SPEC 5.2 and 13) and its state machine.
// Pure: the caller passes the authorize result, the Ask approval and the role lookup; nothing here does I/O.
//
//   Draft -> Preview      action deploy.preview (write)
//   Preview -> Approved   a decision by a person: owner, admin, or a manager of the deployment's project
//   Approved -> Production action deploy.publish (outward.publish), HELD for an Ask approved by a person (a model never approves)
//   Production -> Retired action deploy.retire (write)
//   Retired -> Production rollback: `restore` of the previous Deployment, action deploy.rollback (outward.publish), held
//   Draft | Preview | Approved -> Retired: discard

import { RISKS } from "../../kernel/contracts/index.js";
import { fail, humanDecider, deploymentUrn, NAME_RE, ENV_NAME_RE, SECRET_REF_RE, SPACE_RE, DEPLOYMENT_ID_RE, isSpaceEnvName, deepFreeze } from "./util.js";

/** @typedef {import("../../kernel/contracts/fields.js").TypeDefinition} TypeDefinition */

export const STAGES = Object.freeze(["Draft", "Preview", "Approved", "Production", "Retired"]);
/** The fixed allow list of base images a build may choose from. */
export const BUILD_IMAGES = Object.freeze(["static", "node-20", "node-22", "dockerfile"]);
export const SOURCE_KINDS = Object.freeze(["repo", "drive", "folder"]);

/** Actions this module declares (SPEC 6.1). `deploy.publish` and `deploy.rollback` are outward.publish and are always held. */
export const ACTIONS = deepFreeze({
  "deploy.create": { action: "deploy.create", resource_type: "deployment", risk: "write", label: "prepare a site", gloss: "Create a draft of a site or app from a repo, a Drive folder or a folder on this server." },
  "deploy.preview": { action: "deploy.preview", resource_type: "deployment", risk: "write", label: "build a preview", gloss: "Build the draft and show it at a private preview address." },
  "deploy.publish": { action: "deploy.publish", resource_type: "deployment", risk: "outward.publish", label: "put a site on the internet", gloss: "Make the approved version public at its address. A person approves each time." },
  "deploy.rollback": { action: "deploy.rollback", resource_type: "deployment", risk: "outward.publish", label: "go back to the previous version", gloss: "Put the previous version back on the internet. A person approves each time." },
  "deploy.retire": { action: "deploy.retire", resource_type: "deployment", risk: "write", label: "take a version down", gloss: "Stop serving a version and keep its record." },
  "deploy.domain": { action: "deploy.domain", resource_type: "deployment", risk: "write", label: "connect a domain", gloss: "Add or remove a domain for a site. It serves only after the domain is verified and the site is published." },
  "deploy.secret": { action: "deploy.secret", resource_type: "secret", risk: "grant", label: "let a site use a secret", gloss: "Give one deployment one secret. Nothing is shared with other deployments." },
  "deploy.read": { action: "deploy.read", resource_type: "deployment", risk: "read", label: "see sites", gloss: "See deployments and their status." },
});
for (const a of Object.values(ACTIONS)) if (!RISKS.includes(a.risk)) throw new Error("bad risk " + a.risk);

/** @type {TypeDefinition} */
export const deploymentType = deepFreeze({
  name: "deployment",
  label: "Deployment",
  icon: "rocket",
  fields: [
    { name: "name", kind: "text", label: "Name", required: true, description: "Lowercase letters, digits and hyphens. Names the site; every version of a site shares it." },
    { name: "version", kind: "number", label: "Version", required: true, description: "Set by the kernel: 1 for the first deployment of a name, then up." },
    { name: "source_kind", kind: "choice", label: "Source", required: true, options: SOURCE_KINDS },
    { name: "source_ref", kind: "text", label: "Source reference", required: true, description: "A repo URL and ref, a Drive folder id, or the full path of a folder on this server." },
    { name: "build_command", kind: "text", label: "Build command", description: "Runs in the build sandbox. Empty for a folder of ready files." },
    { name: "build_output", kind: "text", label: "Build output folder", description: "Relative folder the build writes, for example dist." },
    { name: "build_image", kind: "choice", label: "Build image", required: true, options: BUILD_IMAGES },
    { name: "env", kind: "text", label: "Environment", description: "Names only, one per line, each pointing at a granted secret. Values are secret references, never shown." },
    { name: "url", kind: "link", label: "Address" },
    { name: "previous", kind: "link", label: "Replaced version", to: "deployment" },
    { name: "project", kind: "link", label: "Project", to: "project" },
    { name: "created_by", kind: "actor", label: "Created by" },
    { name: "build_digest", kind: "text", label: "Build digest", description: "Set by the kernel when a build passes the sealed-value check." },
    { name: "stage", kind: "stage", label: "Stage", options: STAGES },
  ],
  stages: STAGES.map(name => ({ name })),
  rules: [
    { name: "production_has_address", require: 'stage != "Production" or url != ""' },
    { name: "production_has_build", require: 'stage != "Production" or build_digest != ""' },
  ],
});

/**
 * The legal transitions. `held` means the act is outward: it waits for an Ask a person approves.
 * `decider` is who may make the Preview -> Approved decision or approve a held act.
 */
export const TRANSITIONS = deepFreeze([
  { from: "Draft", to: "Preview", action: "deploy.preview", risk: "write", held: false, human: false },
  { from: "Preview", to: "Approved", action: null, risk: "write", held: false, human: true, decider: "owner_admin_or_project_manager" },
  { from: "Approved", to: "Production", action: "deploy.publish", risk: "outward.publish", held: true, human: true, decider: "owner_admin_or_named" },
  { from: "Production", to: "Retired", action: "deploy.retire", risk: "write", held: false, human: false },
  { from: "Retired", to: "Production", action: "deploy.rollback", risk: "outward.publish", held: true, human: true, decider: "owner_admin_or_named", restore: true },
  { from: "Draft", to: "Retired", action: "deploy.retire", risk: "write", held: false, human: false },
  { from: "Preview", to: "Retired", action: "deploy.retire", risk: "write", held: false, human: false },
  { from: "Approved", to: "Retired", action: "deploy.retire", risk: "write", held: false, human: false },
]);

export const EVENT_TYPES = Object.freeze(["deployment.built", "deployment.previewed", "deployment.approved", "deployment.published", "deployment.rolled_back", "deployment.retired"]);

/** Image names, digests, and the `sha256:` build digest a Preview needs. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Validate and normalise the input for a new Draft. Returns a clean object; throws `bad_input`.
 * @param {any} input
 */
export function normalizeDraft(input) {
  if (!input || typeof input !== "object") fail("bad_input", "a deployment description is required");
  // Strict: a key this description does not define refuses it (an `egress` or a `ports` here would otherwise be dropped in silence and look accepted).
  const only = (/** @type {any} */ o, /** @type {string[]} */ keys, /** @type {string} */ where) => { for (const k of Object.keys(o || {})) if (!keys.includes(k)) fail("bad_input", `${where}: ${k} is not a setting a deployment has`); };
  only(input, ["name", "source", "build", "env", "project", "approver"], "deployment");
  if (input.source != null && (typeof input.source !== "object" || Array.isArray(input.source))) fail("bad_input", "source is an object");
  if (input.build != null && (typeof input.build !== "object" || Array.isArray(input.build))) fail("bad_input", "build is an object");
  only(input.source, ["kind", "ref"], "source");
  only(input.build, ["command", "output_dir", "image", "port"], "build");
  const name = String(input.name ?? "");
  if (!NAME_RE.test(name)) fail("bad_input", "name: lowercase letters, digits and hyphens, up to 40 characters");
  const src = input.source || {};
  if (!SOURCE_KINDS.includes(src.kind)) fail("bad_input", "source.kind must be repo, drive or folder");
  if (typeof src.ref !== "string" || !src.ref || src.ref.length > 500 || /[\u0000-\u001f\u007f]/.test(src.ref)) fail("bad_input", "source.ref is required");
  if (src.kind === "folder" && (!/^(?:\/|[A-Za-z]:[\\/])/.test(src.ref) || src.ref.split(/[\\/]/).includes(".."))) fail("bad_input", "a folder source is the folder's full path, with no ..");
  const b = input.build || {};
  const image = b.image ?? "static";
  if (!BUILD_IMAGES.includes(image)) fail("bad_input", `build.image must be one of ${BUILD_IMAGES.join(", ")}`);
  const command = b.command ?? "";
  if (typeof command !== "string" || command.length > 500 || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(command)) fail("bad_input", "build.command is one line, up to 500 characters");
  // "dockerfile": the folder's own Dockerfile is the build and the result is a server (an image), so there is no command and no output folder; the one port may be named (else its EXPOSE)
  if (image === "dockerfile" && (b.command || b.output_dir)) fail("bad_input", "a Dockerfile build takes no command and no output folder: the Dockerfile is the build");
  if (b.port != null && (image !== "dockerfile" || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535)) fail("bad_input", "build.port is the one port a Dockerfile app listens on (1 to 65535), and only a Dockerfile build takes it");
  const output_dir = b.output_dir ?? (image === "static" || image === "dockerfile" ? "." : "dist");
  if (typeof output_dir !== "string" || !/^[A-Za-z0-9._\/-]{1,100}$/.test(output_dir) || output_dir.split("/").includes("..") || output_dir.startsWith("/")) fail("bad_input", "build.output_dir is a relative folder");
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(input.env || {})) {
    if (!ENV_NAME_RE.test(k)) fail("bad_input", `env name ${k} is not valid`);
    if (isSpaceEnvName(k)) fail("bad_input", `env name ${k} looks like one of the space's own; use a different name`);
    if (typeof v !== "string" || !SECRET_REF_RE.test(v)) fail("bad_input", `env ${k} must be a secret reference (vault://...), never a value`);
    env[k] = v;
  }
  if (input.project != null && !(typeof input.project === "string" && /^[A-Za-z0-9._:\/-]{1,200}$/.test(input.project))) fail("bad_input", "project is invalid");
  if (input.approver != null && !(typeof input.approver === "string" && /^[A-Za-z0-9_]{1,64}$/.test(input.approver))) fail("bad_input", "approver is invalid");
  return { name, source: { kind: src.kind, ref: src.ref }, build: { command, output_dir, image, ...(b.port != null ? { port: b.port } : {}) }, env, project: input.project ?? null, approver: input.approver ?? null };
}

/** Check a stored deployment has the shape the state machine needs. @param {any} d */
export function assertDeployment(d) {
  if (!d || typeof d !== "object" || !DEPLOYMENT_ID_RE.test(d.id) || !SPACE_RE.test(d.space) || !STAGES.includes(d.stage)) fail("bad_input", "not a deployment record");
  return d;
}

const eventOf = (/** @type {any} */ d, /** @type {string} */ type, /** @type {Record<string, unknown>} */ extra = {}) => ({
  type,
  subject: deploymentUrn(d.space, d.id),
  // Ids, versions and urls only. Never a secret value, an env value or a build log.
  data: { id: d.id, name: d.name, version: d.version, url: d.url ?? null, ...extra },
});

/**
 * Check the authorize result the caller got for this act. A held act is never satisfied by `allow` alone.
 * @param {any} rule @param {any} d @param {any} authz
 */
function checkAuthz(rule, d, authz) {
  if (!rule.action) return;
  if (!authz || typeof authz !== "object") fail("forbidden", `${rule.action} was not authorized`);
  if (authz.action && authz.action !== rule.action) fail("forbidden", "the authorization was for a different action");
  if (authz.resource && authz.resource !== deploymentUrn(d.space, d.id)) fail("forbidden", "the authorization was for a different deployment");
  if (authz.effect === "deny") fail("forbidden", `not allowed: ${authz.reason || "no_grant"}`, { reason: authz.reason });
  if (!rule.held && authz.effect !== "allow") fail("needs_approval", `${rule.action} needs an approval first`);
  if (authz.effect !== "allow" && authz.effect !== "ask") fail("forbidden", "the authorization is not valid");
}

/**
 * The person who decided must be allowed to. Returns the person's actor id.
 * @param {any} rule @param {any} d @param {any} approval @param {{ roleOf(actorId: string): string | null | undefined, managesProject?(actorId: string, project: string): boolean }} roles
 * @param {string} expectedHash
 */
export function checkApproval(rule, d, approval, roles, expectedHash) {
  if (!approval || approval.outcome !== "approved") fail("needs_approval", "a person has not approved this yet");
  const person = humanDecider(approval.by, d.space);
  if (rule.held && !expectedHash) fail("approval_mismatch", "the approval is not bound to a plan");
  if (expectedHash && approval.payload_hash !== expectedHash) fail("approval_mismatch", "the approval was for something different from what would change now");
  const role = roles && roles.roleOf ? roles.roleOf(person) : null;
  if (!role) fail("not_approver", "the approver is not a member of this space");
  if (rule.decider === "owner_admin_or_project_manager") {
    const ok = role === "owner" || role === "admin" || (role === "manager" && !!d.project && !!roles.managesProject && roles.managesProject(person, d.project));
    if (!ok) fail("not_approver", "only an owner, an admin or the manager of this project can approve a preview");
  } else if (rule.decider === "owner_admin_or_named") {
    if (!(role === "owner" || role === "admin" || (d.approver && d.approver === person))) fail("not_approver", "only an owner, an admin or the named approver can approve going public");
  }
  return person;
}

/**
 * Move a deployment to a stage. Returns the new record and the events to emit; never mutates.
 * @param {any} deployment
 * @param {string} to
 * @param {{
 *   chain: any, now: number, authz?: any, approval?: any, roles?: any, payload_hash?: string,
 *   build?: { digest: string, sealed_checked: boolean }, url?: string, replaces?: any,
 * }} ctx
 * @returns {{ deployment: any, events: Array<{ type: string, subject: string, data: any }>, retired?: any }}
 */
export function transition(deployment, to, ctx) {
  const d = assertDeployment(deployment);
  if (!ctx || !ctx.chain || ctx.chain.space !== d.space) fail("forbidden", "the chain is not in this space");
  const rule = TRANSITIONS.find(r => r.from === d.stage && r.to === to);
  if (!rule) fail("illegal_transition", `a deployment cannot go from ${d.stage} to ${to}`, { from: d.stage, to });
  if (rule.restore) fail("illegal_transition", "going back to a retired version is a rollback; use rollback()");
  checkAuthz(rule, d, ctx.authz);
  /** @type {any} */
  const next = { ...d, stage: to, updated_at: ctx.now };
  const events = [];
  /** @type {any} */
  let retired;
  if (to === "Preview") {
    if (!ctx.build || !DIGEST_RE.test(ctx.build.digest || "")) fail("bad_input", "a build digest (sha256:...) is required to preview");
    if (ctx.build.sealed_checked !== true) fail("sealed_in_build", "the build was not checked for sealed values");
    if (typeof ctx.url !== "string" || !/^https:\/\//.test(ctx.url)) fail("bad_input", "a preview address is required");
    next.build_digest = ctx.build.digest;
    next.url = ctx.url;
    events.push(eventOf(next, "deployment.built", { digest: ctx.build.digest }), eventOf(next, "deployment.previewed"));
  } else if (to === "Approved") {
    const person = checkApproval(rule, d, ctx.approval, ctx.roles, ctx.payload_hash);
    next.approved_by = person;
    next.approved_at = ctx.now;
    events.push(eventOf(next, "deployment.approved", { by: person }));
  } else if (to === "Production") {
    const person = checkApproval(rule, d, ctx.approval, ctx.roles, ctx.payload_hash);
    if (typeof ctx.url !== "string" || !/^https:\/\//.test(ctx.url)) fail("bad_input", "a public address is required");
    if (!d.approved_by) fail("needs_approval", "the preview was never approved");
    next.url = ctx.url;
    next.published_by = person;
    next.published_at = ctx.now;
    const cur = ctx.replaces;
    if (cur) {
      assertDeployment(cur);
      if (cur.stage !== "Production" || cur.name !== d.name || cur.space !== d.space || cur.id === d.id) fail("bad_input", "only the live version of the same site can be replaced");
      next.previous = cur.id;
      retired = { ...cur, stage: "Retired", retired_at: ctx.now, updated_at: ctx.now };
    }
    events.push(eventOf(next, "deployment.published", { by: person, replaces: cur ? { id: cur.id, version: cur.version } : null }));
    if (retired) events.push(eventOf(retired, "deployment.retired", { replaced_by: next.id }));
  } else if (to === "Retired") {
    next.retired_at = ctx.now;
    events.push(eventOf(next, "deployment.retired"));
  }
  return retired ? { deployment: next, events, retired } : { deployment: next, events };
}

/**
 * Rollback: `restore` the previous Deployment record to Production and retire the live one. An outward.publish act, held.
 * @param {any} current the live deployment @param {any} previous the retired one it replaced
 * @param {{ chain: any, now: number, authz?: any, approval?: any, roles?: any, payload_hash?: string }} ctx
 * @returns {{ current: any, restored: any, events: Array<{ type: string, subject: string, data: any }> }}
 */
export function rollback(current, previous, ctx) {
  const cur = assertDeployment(current), prev = assertDeployment(previous);
  if (!ctx || !ctx.chain || ctx.chain.space !== cur.space) fail("forbidden", "the chain is not in this space");
  if (cur.stage !== "Production") fail("not_production", "only the live version can be rolled back");
  if (!cur.previous || cur.previous !== prev.id || prev.space !== cur.space || prev.name !== cur.name) fail("no_previous", "there is no previous version to go back to");
  if (prev.stage !== "Retired" || !prev.published_at || !prev.build_digest) fail("no_previous", "the previous version was never live, or is not retired");
  const rule = TRANSITIONS.find(r => r.from === "Retired" && r.to === "Production");
  checkAuthz(rule, prev, ctx.authz);
  const person = checkApproval(rule, prev, ctx.approval, ctx.roles, ctx.payload_hash);
  const retired = { ...cur, stage: "Retired", retired_at: ctx.now, updated_at: ctx.now };
  const { retired_at, ...rest } = prev;
  const restored = { ...rest, stage: "Production", restored_at: ctx.now, restored_by: person, updated_at: ctx.now };
  return {
    current: retired,
    restored,
    events: [
      eventOf(restored, "deployment.rolled_back", { by: person, from: { id: cur.id, version: cur.version } }),
      eventOf(retired, "deployment.retired", { replaced_by: restored.id, reason: "rollback" }),
    ],
  };
}
