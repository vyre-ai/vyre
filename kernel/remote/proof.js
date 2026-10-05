// kernel/remote/proof.js: how a person's presence proof gets from the surface that collected it to the kernel's one verifier.
// A surface (the Deck, a native app) shows the person what will happen, has their device key sign it, and sends the proof beside the request as `kernel_proof`. A
// module never checks it, never keeps it and never reads it: it passes it on with `proofFrom(meta)` as the `{ presence }` option of the kernel call it makes under
// the person's chain, and the kernel's verifier (the sealing process) is the only place it is checked and used up. The legacy `meta.proof` (the daemon's own
// x-vyre-presence header) is a different thing and is never accepted here.
//
//   surface:  const req = proofRequest(space, "setRole", { person, role });   // what to show and sign
//             const proof = await signer.sign(req);                          // a PresenceProof over req.payload_hash
//             call(tool, input, { kernel_proof: proof })                       // beside the request, never inside the input
//   module:   await ctx.kernel.grants.setRole(chain, input, proofFrom(meta))
import { canonical, sha256 } from "../core/canonical.js";
import { payloadHash, chainCtx } from "../seal/wire.js";
import { KernelError } from "../core/errors.js";

const MAX_PROOF_BYTES = 4096;
const urn = (/** @type {string} */ space, /** @type {string} */ type, id = "new") => `vyre://${space}/${type}/${id}`;

/**
 * For each grants call: the action it gates, the resource and the value its input hash covers. Kept beside the calls' own gates (kernel/grants/index.js) and tested
 * against them: every request built here is accepted by the real store.
 * @type {Record<string, (space: string, a: any, b?: any) => { action: string, resource: string, input: any }>}
 */
const CALLS = {
  create: (s, i) => ({ action: i && !i.parent && i.subject && i.subject.kind === "actor" && i.subject.actor && ["agent", "service", "automation"].includes(i.subject.actor.kind) ? "grants.member" : "grants.create", resource: urn(s, "grant"), input: i }),
  revoke: (s, id, reason) => ({ action: "grants.revoke", resource: urn(s, "grant", id), input: { id, reason } }),
  narrow: (s, id, patch) => ({ action: "grants.narrow", resource: urn(s, "grant", id), input: { id, patch } }),
  setRole: (s, m) => ({ action: m && m.role === "owner" ? "grants.role" : "grants.member", resource: urn(s, "member", m.person), input: m }),
  ruleSet: (s, r) => ({ action: "rules.set", resource: urn(s, "rule"), input: r }),
  ruleRemove: (s, id) => ({ action: "rules.remove", resource: urn(s, "rule", id), input: { id } }),
  ruleEnable: (s, id) => ({ action: "rules.enable", resource: urn(s, "rule", id), input: { id } }),
  ruleDisable: (s, id) => ({ action: "rules.disable", resource: urn(s, "rule", id), input: { id } }),
  ruleAccept: (s, id) => ({ action: "rules.accept", resource: urn(s, "rule", id), input: { id } }),
  ruleDismiss: (s, id) => ({ action: "rules.dismiss", resource: urn(s, "rule", id), input: { id } }),
  transferOwner: (s, t) => ({ action: "grants.role", resource: urn(s, "member", t.to), input: { transfer: { to: t.to, demote_to: t.demote_to || "admin" } } }),
  removeMember: (s, m) => ({ action: "grants.member", resource: urn(s, "member", m.person), input: { remove: m.person } }),
  removeActor: (s, actor) => ({ action: "grants.member", resource: urn(s, "member", actor.id), input: { remove_actor: actor } }),
  addActor: (s, actor) => ({ action: "grants.member", resource: urn(s, "member", actor.id), input: { actor } }),
  offer: (s, o) => ({ action: "grants.offer", resource: urn(s, "offer"), input: o }),
  unoffer: (s, id) => ({ action: "grants.unoffer", resource: urn(s, "offer", id), input: { revoke: id } }),
  lend: (s, o) => ({ action: "grants.offer", resource: urn(s, "offer", "lend"), input: { lend: { member: o.member, device: o.device, device_key: o.device_key, network_cap: o.network_cap ?? null } } }),
  unlend: (s, o) => ({ action: "grants.unoffer", resource: urn(s, "offer", "lend"), input: { unlend: { member: o.member, device: o.device } } }),
  inviteCreate: (s, i) => ({ action: "grants.invite", resource: urn(s, "invite"), input: i }),
  moveOut: (s, i) => ({ action: "project.move_out", resource: i.project, input: { to: i.to, plan_hash: i.plan_hash } }),
  inviteConfirm: (s, id, c) => ({ action: "grants.invite", resource: urn(s, "invite", id), input: { confirm: id, words: c && c.words } }),
};

/** The presence op a gated action is proved under: grants.invite -> grant.invite, rules.set -> grant.rule_set. The one list of how an action becomes an op (scripts/dev-sign-proof.mjs uses it too). @param {string} action */
export const opOf = action => (String(action).startsWith("rules.") ? `grant.rule_${String(action).split(".")[1]}` : `grant.${String(action).split(".")[1]}`);

/** The names `proofRequest` knows. */
export const PROOF_CALLS = Object.freeze(Object.keys(CALLS));

/**
 * What a surface shows and signs for one grants call: `{ op, space, fields, payload_hash }`. The signer signs `payload_hash` (and the rest of the PresenceProof
 * fields, kernel/contracts/chain.d.ts); the kernel recomputes it. @param {string} space @param {string} call one of PROOF_CALLS @param {any[]} args the call's arguments after the chain
 */
export function proofRequest(space, call, ...args) {
  const f = Object.hasOwn(CALLS, call) ? CALLS[call] : null;
  if (!f) throw new KernelError("bad_input", `${call} is not a call a presence proof covers`);
  const { action, resource, input } = f(space, args[0], args[1]);
  const op = opOf(action);
  const fields = { resource, input_hash: sha256(canonical({ action, input })) };
  return Object.freeze({ op, space, fields, payload_hash: payloadHash(op, space, fields) });
}

/**
 * The `{ presence }` option for a kernel call, from what the surface sent: `meta.kernel_proof`, a plain object no larger than 4 KB. Anything else (a string, an
 * array, an object with functions, the legacy `meta.proof`) is no proof, and the kernel then refuses with `needs_presence`. The kernel verifies; this only carries.
 * @param {{ kernel_proof?: any } | null | undefined} meta
 */
export function proofFrom(meta) {
  const p = meta && meta.kernel_proof;
  if (p === undefined || p === null) return {};
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(p)); } catch { return {}; }
  if (typeof p !== "object" || Array.isArray(p) || size > MAX_PROOF_BYTES || Object.values(p).some(v => typeof v === "function")) return {};
  return { presence: p };
}

/**
 * What a person signs to accept an invite: over the contents the join card showed (the same hash the admin approved). `card` is what `invites.get` returned.
 * @param {string} space @param {{ id: string, role: string, scope?: string[] | null, expires?: number | null, invitee?: string | null }} card @param {string} person
 */
export function acceptProofRequest(space, card, person) {
  const seen = { role: card.role, scope: card.scope ?? null, expires: card.expires ?? null, invitee: card.invitee ?? null };
  const fields = { invite: card.id, hash: sha256(canonical(seen)), person };
  return Object.freeze({ op: "grant.accept", space, fields, seen, payload_hash: payloadHash("grant.accept", space, fields) });
}

/** The chain hash a PresenceProof from `person`'s device must carry for a call the home mints as that person alone (the home recomputes it from the chain it minted). */
export const proofChainHash = (/** @type {string} */ space, /** @type {string} */ person) => chainCtx({ space, hops: [{ actor: { kind: "person", id: person, space }, via: {} }] }).chain_hash;
