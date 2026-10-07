// @ts-check
// lib/publish/flow.js: the publish pipeline as a Flow definition (SPEC 5.2, 9.1 and 13), in the stored JSON form.
//
//   build       an `fn` step in the Tier 2 sandbox; declared needs.network is the package registries and nothing else
//   preview     call deploy.preview (write)
//   approve     an `ask` step: a person with the role decides (a model never does)
//   production  call deploy.publish (outward.publish), through Ask
//   rollback    call deploy.rollback (outward.publish), through Ask, when production fails
// The Flow runs as `automation:<id>` with a chain [automation, approver], so it can never do more than the person
// who approved this version.

import { fail, deploymentUrn, DEPLOYMENT_ID_RE, SPACE_RE, deepFreeze } from "./util.js";
import { ACTIONS } from "./deployment.js";
import { REGISTRIES } from "./edge.js";

export const FLOW_STEP_KINDS = Object.freeze(["fn", "ask", "call"]);
/** Step kinds a publish Flow may never use: they could reach a model or an arbitrary destination. */
export const FORBIDDEN_STEP_KINDS = Object.freeze(["http", "agent", "classify", "create", "update", "remove", "upsert", "find", "pick", "assign", "stage", "wait", "repeat", "filter", "decide"]);
const APPROVER_ROLES = Object.freeze(["owner", "admin", "manager"]);

/**
 * Build the Flow for one deployment.
 * @param {{ space: string | { id: string }, deployment: { id: string, name: string, project?: string | null } }} input
 */
export function publishFlow(input) {
  const space = typeof input.space === "string" ? input.space : input.space && input.space.id;
  const d = input.deployment;
  if (!SPACE_RE.test(space) || !d || !DEPLOYMENT_ID_RE.test(d.id)) fail("bad_input", "a space and a deployment are required");
  const urn = deploymentUrn(space, d.id);
  const flow = {
    v: 1,
    kind: "def.flow",
    name: `Publish ${d.name}`,
    authorship: "system",
    on: { manual: { subject: urn } },
    caps: ["deploy.preview", "deploy.publish", "deploy.rollback"],
    steps: [
      {
        id: "build",
        fn: {
          module: "publish.build",
          tier: 2,
          needs: { network: [...REGISTRIES], sealed: false, inference: false },
          input: { deployment: urn },
          // A build holding a sealed value is refused, and its logs are redacted of granted secrets.
          checks: ["sealed_values", "granted_secrets"],
        },
      },
      { id: "preview", call: "deploy.preview", with: { deployment: urn }, after: "build" },
      {
        id: "approve",
        ask: { title: `Approve the preview of ${d.name}`, role: ["owner", "admin", ...(d.project ? ["manager"] : [])], project: d.project ?? null, show: ["url", "version", "secrets", "domains"], output: { decision: true } },
        after: "preview",
      },
      { id: "production", call: "deploy.publish", through: "ask", with: { deployment: urn }, after: "approve", if: 'steps.approve.outcome == "approved"' },
      { id: "rollback", call: "deploy.rollback", through: "ask", with: { deployment: urn }, after: "production", if: 'steps.production.status == "failed"' },
    ],
  };
  const v = validateFlow(flow);
  if (!v.ok) fail("flow_invalid", v.problems[0], { problems: v.problems });
  return deepFreeze(flow);
}

/**
 * The same pipeline in the kernel's stored Flow form (kernel/flows/schema.js, format 1), the one the Flows runner compiles, approves by hash and runs
 * on sessions' runner: build, preview, ask a role, production through the Ask, and a rollback if production reports failed. Every action and
 * resource is written out; the Flow carries the four deploy caps over this one deployment, and the right to ask a person, and nothing else.
 * @param {{ space: string | { id: string }, deployment: { id: string, name: string, project?: string | null } }} input
 */
export function publishFlowKernel(input) {
  const space = typeof input.space === "string" ? input.space : input.space && input.space.id;
  const d = input.deployment;
  if (!SPACE_RE.test(space) || !d || !DEPLOYMENT_ID_RE.test(d.id)) fail("bad_input", "a space and a deployment are required");
  const urn = deploymentUrn(space, d.id);
  const name = `publish_${d.id.replace(/^dep_/, "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  return deepFreeze({
    format: 1,
    name,
    label: `Publish ${String(d.name).slice(0, 80)}`,
    description: "Build, preview, a person approves, production, rollback if production fails.",
    authorship: "builder",
    caps: [...["deploy.build", "deploy.preview", "deploy.publish", "deploy.rollback"].map(action => ({ action, resource: urn })), { action: "ask.request", resource: `vyre://${space}/task/*` }],
    trigger: { on: "manual" },
    steps: [
      { id: "build", kind: "call", action: "deploy.build", resource: urn },
      { id: "preview", kind: "call", action: "deploy.preview", resource: urn },
      // A person with the role decides; a model never does. A manager only for a deployment that belongs to a project.
      { id: "approve", kind: "ask", to: "role:admin", title: `Approve the preview of ${String(d.name).slice(0, 80)}` },
      { id: "decide_publish", kind: "decide", if: 'steps.approve.outcome == "approved"', then: [
        { id: "production", kind: "call", action: "deploy.publish", resource: urn },
        { id: "check_production", kind: "decide", if: 'steps.production.status == "failed"', then: [
          { id: "rollback", kind: "call", action: "deploy.rollback", resource: urn },
        ] },
      ] },
    ],
  });
}

/**
 * Check a publish Flow touches only declared actions and stays inside its limits. Returns the problems.
 * @param {any} flow @returns {{ ok: boolean, problems: string[] }}
 */
export function validateFlow(flow) {
  /** @type {string[]} */ const p = [];
  if (!flow || typeof flow !== "object") return { ok: false, problems: ["not a flow"] };
  if (flow.kind !== "def.flow") p.push("kind must be def.flow");
  if (!flow.authorship) p.push("a Flow carries an authorship label");
  if (flow.authorship === "model") p.push("a model-authored publish Flow is not allowed");
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  if (!steps.length) p.push("no steps");
  const ids = new Set();
  /** @type {Set<string>} */ const called = new Set();
  let askSeen = false;
  for (const s of steps) {
    if (!s || typeof s !== "object" || typeof s.id !== "string") { p.push("a step has no id"); continue; }
    if (ids.has(s.id)) p.push(`step ${s.id} is listed twice`);
    ids.add(s.id);
    for (const k of Object.keys(s)) if (FORBIDDEN_STEP_KINDS.includes(k)) p.push(`step ${s.id}: ${k} steps are not allowed in a publish Flow`);
    const kinds = FLOW_STEP_KINDS.filter(k => k in s);
    if (kinds.length !== 1) { p.push(`step ${s.id}: exactly one of ${FLOW_STEP_KINDS.join(", ")}`); continue; }
    if (s.after && !ids.has(s.after)) p.push(`step ${s.id}: after ${s.after} is not an earlier step`);
    if (s.fn) {
      const n = s.fn.needs || {};
      if (s.fn.tier !== 2) p.push(`step ${s.id}: fn runs only in the Tier 2 sandbox`);
      if (!Array.isArray(n.network) || !n.network.length) p.push(`step ${s.id}: fn must declare needs.network`);
      for (const h of n.network || []) if (!REGISTRIES.includes(h)) p.push(`step ${s.id}: network ${String(h)} is not a listed registry`);
      if (n.sealed !== false) p.push(`step ${s.id}: fn gets no sealed values`);
      if (n.inference !== false) p.push(`step ${s.id}: fn gets no access to the inference door`);
    } else if (s.ask) {
      askSeen = true;
      const roles = Array.isArray(s.ask.role) ? s.ask.role : [s.ask.role];
      if (!roles.length || !roles.every((/** @type {string} */ r) => APPROVER_ROLES.includes(r))) p.push(`step ${s.id}: the approving role must be owner, admin or manager`);
    } else if (s.call) {
      const def = /** @type {any} */ (ACTIONS)[s.call];
      if (!def) { p.push(`step ${s.id}: action ${String(s.call)} is not declared`); continue; }
      called.add(s.call);
      if (def.risk.startsWith("outward.")) {
        if (s.through !== "ask") p.push(`step ${s.id}: ${s.call} is ${def.risk} and must go through ask`);
        if (!askSeen) p.push(`step ${s.id}: an approve step must come before ${s.call}`);
      }
    }
  }
  const caps = Array.isArray(flow.caps) ? flow.caps : [];
  for (const c of caps) if (!(c in ACTIONS)) p.push(`cap ${String(c)} is not a declared action`);
  for (const c of called) if (!caps.includes(c)) p.push(`step calls ${c} which is not in caps`);
  for (const c of caps) if (!called.has(c)) p.push(`cap ${c} is never used`);
  const text = JSON.stringify(flow);
  if (/"http"|"\*"/.test(text)) p.push("no http steps and no wildcards");
  return { ok: p.length === 0, problems: p };
}
