// @ts-check
// A stand-in for the kernel handle's `chain(meta)` and `owner`, for tests of modules that take the person from the call's chain (bridges, publish). The real thing is exercised on a real
// daemon in test/walk-identity-space.test.js. Here the test's caller label stands for what the daemon proved: a person's surface is the home's person, `<x>:agent:<name>` is a session
// token's chain (the person plus the agent), and everything else (a module, a guest, anonymous) has no person chain, so it gets the module's own service chain.
export const FAKE_OWNER = "per_kernelowner";

/** @param {any} [meta] */
export function fakeChain(meta) {
  const caller = String((meta && meta.caller) || "");
  const person = { actor: { kind: "person", id: FAKE_OWNER } };
  const agent = /:agent:([A-Za-z0-9_.-]+)/.exec(caller);
  if (/^(deck|cli|local|capsule|mobile)$/.test(caller)) return { hops: [person] };
  if (agent) return { hops: [person, { actor: { kind: "agent", id: agent[1] } }] };
  return { hops: [{ actor: { kind: "service", id: "module" } }] };
}

/** The `kernelFor` dep for a Registry. */
export const fakeKernelFor = () => ({ owner: FAKE_OWNER, chain: async (/** @type {any} */ meta) => fakeChain(meta) });

/**
 * The same stand-in where the plugin's hook counts as the person's own terminal: the daemon proves the hook's socket client is the person typing at their Claude Code, so a call labelled `harness` with no thread
 * or agent is one person. (The real kernel's chain for a hook call is exercised on a real daemon; a model's `mcp`, an agent label and a module stay without a person.)
 */
export const fakeKernelForHooks = () => ({ owner: FAKE_OWNER, chain: async (/** @type {any} */ meta) => {
  const caller = String((meta && meta.caller) || "");
  if (caller === "harness" && !(meta && (meta.agent || meta.thread))) return { hops: [{ actor: { kind: "person", id: FAKE_OWNER } }] };
  return fakeChain(meta);
} });
