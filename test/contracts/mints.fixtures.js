// @ts-check
// Fixtures for team/contracts/mints.md (v1): the manifest line a module declares, the grant it makes through `ctx.kernel.mint`, and what the kernel refuses. test/contracts/mints.test.js runs these on a real
// kernel. A module's own tests use the same objects (and test/fake-chain-kernel.js `fakeMint`) so its store adapter is built against what the kernel really accepts.

export const SPACE = "spc_aaaaaaaaaaaa";

/** What a module with a `needs.kernel.mints` list declares (core/publish/module.json, core/wink/module.json carry their own). */
export const manifestNeeds = { kernel: { mints: [{ prefix: "credential/*", actions: ["vault.run"] }, { prefix: "node/*", actions: ["node.host"] }] } };

/** A grant the module makes for a service actor (a deployment) and for a person it admitted. */
export const made = {
  deploymentSecret: {
    subject: { kind: "actor", actor: { kind: "service", id: "deployment-dep_a", space: SPACE } },
    actions: ["vault.run"], resource: { prefix: `vyre://${SPACE}/credential/harlow/stripe` },
    source: "publish:secret:dep_a:STRIPE_KEY:secret:build+runtime", reason: "granted by per_owner",
  },
  sharedComputer: {
    subject: { kind: "actor", actor: { kind: "person", id: "per_owner", space: SPACE } },
    actions: ["node.host"], resource: { prefix: `vyre://${SPACE}/node/dev_a/` }, conditions: { budget: { meter: "node.cpu-hours-day", limit: 4 } },
    source: "wink:W4", reason: "shared with limits",
  },
};

/** Each of these is refused with the code shown, and nothing is written. */
export const refused = [
  { why: "an action the manifest does not list", code: "not_allowed", input: { ...made.deploymentSecret, actions: ["vault.reveal"] } },
  { why: "an address outside the listed prefixes", code: "not_allowed", input: { ...made.deploymentSecret, resource: { prefix: `vyre://${SPACE}/contact/x` } } },
  { why: "another module's source", code: "not_allowed", input: { ...made.deploymentSecret, source: "wink:W4" } },
  { why: "an address in another Space", code: "not_allowed", input: { ...made.deploymentSecret, resource: { prefix: "vyre://spc_bbbbbbbbbbbb/credential/x" } } },
  { why: "a subject that is not an actor or a group", code: "bad_input", input: { ...made.deploymentSecret, subject: { kind: "role", name: "owner" } } },
];
