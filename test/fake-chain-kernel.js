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

/** The kernel's `mint` handle for a first-party module with `needs.kernel.mints`: grants made, listed by source, ended by id. */
export function fakeMint() {
  /** @type {Map<string, any>} */ const made = new Map();
  let n = 0;
  return {
    made,
    make: async (/** @type {any} */ i) => { const id = `gr_fake${++n}`; made.set(id, { ...i, id, status: "active", created_at: Date.now() }); return id; },
    list: async (/** @type {{ source?: string }} */ q) => [...made.values()].filter(g => g.status === "active" && g.source.startsWith(String((q && q.source) || ""))),
    end: async (/** @type {{ id?: string }} */ q) => { const g = q.id ? made.get(q.id) : null; if (g) made.set(g.id, { ...g, status: "revoked" }); return g ? [g.id] : []; },
  };
}

/** The `kernelFor` dep for a Registry. */
export const fakeKernelFor = () => ({ owner: FAKE_OWNER, chain: async (/** @type {any} */ meta) => fakeChain(meta), mint: fakeMint() });
