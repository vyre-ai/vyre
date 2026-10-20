// @ts-check
// Whose AI account a Flow's AI steps run on ("Runs on"). Every AI turn runs on the account of the PERSON it is for: a Flow runs as its maker (the person who wrote its first version), or as the person its
// Runs on names, and on the account that person picked there (else their default key account). The definition holds it as `runs_on: { person, account?, provider? }`, part of the version the approver reads.
//
//   - A person sets Runs on only to their OWN account: the person is always stamped from who wrote the version, never taken from what was sent.
//   - Only the Flow's maker, or the owner acting for themselves, changes it. A version that leaves it out keeps the one before (an edit in the builder or as text never drops it).
//   - A run never acts for nobody, and never for someone who did not turn this version on: the runs-as person must be the approver (the person whose authority the run has, who also assigns its agents' tasks).
//   - No account: the step stops with NO_ACCOUNT, nothing is sent, and the runs-as person gets a card.
// The host's `model` port (core/daemon/flow-model.js) resolves the account and the key for that person only, and calls the inference door as that person's chain.

import { StepFail } from "./runner-faults.js";
import { runsOnProblem } from "./schema.js";

export const NO_ACCOUNT = "Connect an AI account to run this Flow";

/** The maker of a stored Flow: the person who wrote its first version, or null. @param {any} store @param {string} id */
export async function makerOf(store, id) {
  const row = store && typeof store.flowRow === "function" ? await store.flowRow(id).catch(() => null) : null;
  const first = row && Array.isArray(row.versions) && row.versions.length ? row.versions[0] : null;
  return first && first.by && first.by.kind === "person" ? String(first.by.id) : null;
}

/** The person a Flow version's AI turns are for: Runs on's person, else the maker, else the approver. @param {any} store @param {any} view { id, flow, approver } */
export async function runsAsOf(store, view) {
  const set = view && view.flow && view.flow.runs_on;
  if (set && typeof set.person === "string" && set.person) return set.person;
  const maker = view && view.id ? await makerOf(store, view.id) : null;
  if (maker) return maker;
  return view && view.approver && view.approver.kind === "person" ? String(view.approver.id) : null;
}

/**
 * Settle a new version's Runs on before it is stored. Returns { flow } with runs_on settled, or { errors }.
 * @param {{ before: any, flow: any, by: any, id: string | null, store: any, isOwner: (person: string) => Promise<boolean>, accountOk?: (q: { person: string, account: string, provider?: string }) => Promise<boolean> }} o
 */
export async function settleRunsOn(o) {
  const was = o.before && o.before.flow && o.before.flow.runs_on ? o.before.flow.runs_on : null;
  const asked = o.flow && o.flow.runs_on;
  // left out: the version before's stands
  if (asked === undefined || asked === null) return { flow: was ? { ...o.flow, runs_on: was } : o.flow };
  const no = (/** @type {string} */ path, /** @type {string} */ message) => ({ errors: [{ path, message }] });
  const bad = runsOnProblem(asked);
  if (bad) return no("runs_on", bad);
  // the same account as before (with or without the person): unchanged
  if (was && asked.account === was.account && asked.provider === was.provider && (asked.person === undefined || asked.person === was.person)) return { flow: { ...o.flow, runs_on: was } };
  if (!o.by || o.by.kind !== "person") return no("runs_on", "only a person sets what a Flow runs on, for themselves");
  const me = String(o.by.id);
  if (asked.person !== undefined && asked.person !== me) return no("runs_on.person", "Runs on is always your own account: a Flow cannot be set to run on someone else's");
  const maker = (o.id ? await makerOf(o.store, o.id) : null) || me;
  if (maker !== me && !(await o.isOwner(me))) return no("runs_on", "only the person who made this Flow, or the owner for themselves, changes what it runs on");
  if (asked.account !== undefined && !(o.accountOk && (await o.accountOk({ person: me, account: asked.account, ...(asked.provider ? { provider: asked.provider } : {}) }).catch(() => false))))
    return no("runs_on.account", "that is not one of your own AI accounts");
  return { flow: { ...o.flow, runs_on: { person: me, ...(asked.account !== undefined ? { account: asked.account } : {}), ...(asked.provider !== undefined ? { provider: asked.provider } : {}) } } };
}

/**
 * The runs-as person of a run's AI work (a model step, an agent's task), checked: there is one, and it is the person who turned this version on (the run's authority, and the assigner of its tasks, whose
 * account an agent's job runs on). Throws the step's failure otherwise; nothing is sent.
 * @param {any} store @param {any} ctx @returns {Promise<string>}
 */
export async function runsAsChecked(store, ctx) {
  const who = await runsAsOf(store, ctx.view);
  if (!who) throw new StepFail("no_person", "this Flow has no person to run as, so nothing was sent");
  const approver = ctx.run.approver;
  if (!approver || approver.kind !== "person" || String(approver.id) !== who) throw new StepFail("runs_as", "This Flow runs as a person who did not turn this version on, so its AI work did not run and nothing was sent. The person it runs as turns it on, or the owner picks their own account under Runs on and turns it on.");
  return who;
}

/**
 * One model call of a step, as the Flow's runs-as person, on their account. With no `model` port (an in-memory kernel in a test) the kernel's own model door is called as the run's chain, as before.
 * @param {{ ports: any, k: any, store: any, ctx: any, chain: any, alert: (title: string, form: any, idem: string) => Promise<any>, purpose: string, max_tokens: number, messages: any[], day: string, expect?: any }} o   expect: what the step reads its answer as (lib/model-answer.js), handed to the driver
 */
export async function modelCall(o) {
  const { ctx } = o;
  if (typeof o.ports.model !== "function") {
    const m = o.ports.model || { provider: "default", model: "default" };
    return o.k.model.call({ chain: o.chain, purpose: o.purpose, provider: m.provider, model: m.model, max_tokens: o.max_tokens, messages: o.messages, ...(o.expect ? { expect: o.expect } : {}) });
  }
  const who = await runsAsChecked(o.store, ctx);
  const set = ctx.view.flow.runs_on || {};
  try {
    return await o.ports.model({ person: who, ...(set.account ? { account: set.account } : {}), ...(set.provider ? { provider: set.provider } : {}), purpose: o.purpose, max_tokens: o.max_tokens, messages: o.messages, ...(o.expect ? { expect: o.expect } : {}), run: ctx.run.id });
  } catch (e) {
    const code = e && /** @type {any} */ (e).code;
    // a sign-in that has expired is the same kind of thing: the person fixes it in Settings, AI accounts, and is told so on a card
    if (code === "no_account" || code === "no_credential" || code === "signin_expired") {
      const name = ctx.view.flow.label || ctx.view.flow.name;
      // the runs-as person (the approver, checked above) is told once a day per Flow, in the Needs-you list
      await o.alert(`${name}: ${code === "no_account" ? NO_ACCOUNT : String(/** @type {any} */ (e).message)}`, { kind: "no_ai_account", flow: ctx.run.flow, run: ctx.run.id }, `no-account:${ctx.run.flow}:${o.day}`).catch(() => {});
      throw new StepFail(code, code === "no_account" ? NO_ACCOUNT : String(/** @type {any} */ (e).message));
    }
    throw e;
  }
}
