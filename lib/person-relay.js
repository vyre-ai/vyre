// @ts-check
// One binding for "run this tool as the verified person on this turn": surface label plus the
// session token or kernel facts from meta. Every composer slash, ingress tag, and module ctx.call
// that relays a person must use this; the registry merges proven facts when `as` is a person surface.
//
// Standing rules (owner):
// - Fix the class everywhere — one shared implementation here, every entry point wired through it,
//   and table-driven tests derived from the registry/routes (lib/person-relay-entrypoints.js).
// - Agent-agnostic — slash, member relay, and isolation live tests must behave the same for every
//   registered session adapter (Claude, Grok, Codex, …); use core/sessions/testing/fake-agent-harness.js,
//   not Claude-only env setup in person-scope or switchboard tests.

import { isPerson, personTurn } from "./caller.js";

/** @typedef {{ token?: string, kernelFacts?: Record<string, unknown>, person?: { id?: string } }} ProvenMeta */

/**
 * The session proof on a tool run's meta (token and/or kernelFacts). Pure: safe in tests without a registry.
 * @param {ProvenMeta | null | undefined} meta
 */
export function provenFromMeta(meta) {
  const out = /** @type {Record<string, unknown>} */ ({});
  if (!meta || typeof meta !== "object") return out;
  if (typeof meta.token === "string" && meta.token) out.token = meta.token;
  if (meta.kernelFacts && typeof meta.kernelFacts === "object") out.kernelFacts = meta.kernelFacts;
  if (meta.person && typeof meta.person === "object" && meta.person.id) out.person = meta.person;
  return out;
}

/**
 * Options for `ctx.call` / `deps.call` so a nested tool runs as the caller's person, not the module's chain.
 * Returns null when the caller is not a person's surface.
 * @param {unknown} caller
 * @param {ProvenMeta | null | undefined} [meta]
 */
export function personCallOpts(caller, meta) {
  const c = String(caller || "");
  if (!personTurn(c)) return null;
  return { as: c, ...provenFromMeta(meta) };
}

/**
 * Relay for mentions provider calls when the tool caller is `module:sessions` / `module:assistant`
 * but meta carries the asking person's session proof (ingress, resolveTags).
 * @param {ProvenMeta | null | undefined} meta
 */
export function providerPersonRelay(meta) {
  const direct = personCallOpts(meta && meta.caller, meta);
  if (direct) return direct;
  const proven = provenFromMeta(meta);
  if (proven.token || proven.kernelFacts) return proven;
  return null;
}

/**
 * Like personCallOpts but throws when the caller cannot act as a person (composer gates).
 * @param {unknown} caller
 * @param {ProvenMeta | null | undefined} [meta]
 */
export function requirePersonCallOpts(caller, meta) {
  const o = personCallOpts(caller, meta);
  if (!o) throw Object.assign(new Error("only a person's surface runs this command"), { code: "denied" });
  return o;
}

/**
 * Relay a nested tool through a module context as the verified person on this turn.
 * @param {{ call: (tool: string, input: any, opts?: any) => any }} ctx
 * @param {unknown} caller
 * @param {ProvenMeta | null | undefined} meta
 * @param {string} tool
 * @param {any} input
 */
export function relayPersonTool(ctx, caller, meta, tool, input) {
  return ctx.call(tool, input, requirePersonCallOpts(caller, meta));
}

/** Tools ingress reaches under the person's own access (resolveTags). */
export function ingressRelayTargets() {
  return ["mentions.search", "mentions.resolve", "vault.mention.resolve"];
}

/** Tools ingress and composer routing reach under the person's own access (not an exhaustive gate list). */
export const PERSON_SCOPED_RELAY_TOOLS = new Set([
  ...ingressRelayTargets(),
  "planner.add", "recall.search",
  "threads.remember", "threads.shell",
]);

/**
 * Whether a nested tool must carry the asking person's proven session when relayed with `{ as }`.
 * @param {string} tool
 */
export function personScopedRelayTool(tool) {
  const t = String(tool || "");
  if (PERSON_SCOPED_RELAY_TOOLS.has(t)) return true;
  if (t.startsWith("memory.") || t.startsWith("vault.") || t.startsWith("files.") || t.startsWith("records.")) return true;
  return false;
}

/**
 * For table-driven tests: whether the registry should attach currentCall facts for this relay.
 * @param {unknown} as
 */
export function moduleRelayNeedsProvenCall(as) {
  return Boolean(as && isPerson(String(as)));
}
