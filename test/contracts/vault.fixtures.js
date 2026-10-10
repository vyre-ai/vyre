// @ts-check
// Fixtures for team/contracts/vault.md (v1): what the shared-vault, member and health tools answer, and which callers they admit. design and projects-flows build the Vault screens and the Now
// row against these while core/vault is the real thing; test/contracts/vault.test.js runs the real tools and compares their shapes with these. No value here is real.

const FP = "ABCD EFGH JKLM NPQR STUV";

/** A shared vault as every tool shows it: `role` is the caller's own. */
export const vaultFixture = {
  id: "vs_k3m9x2q7pw4t", name: "team", role: "owner", kv: 1, seq: 1, home: "https://alex.vyre.run/vault",
  members: [{ name: "alex", role: "owner", fingerprint: FP }],
  items: [{ name: "api-token" }, { name: "db-login", rotate: true }],
};

export const vaultFixtures = {
  vault: vaultFixture,
  create: { vault: vaultFixture },
  list: { vaults: [vaultFixture] },
  sync: { synced: [{ vault: "team", home: true }] },
  rotate: { vault: "team", kv: 2 },
  invite: { invite: "vyre-invite:v1:eyJmYWtlIjp0cnVlfQ", vault: "team", member: "dana", role: "member" },
  accept: { vault: vaultFixture },
  role: { vault: "team", member: "dana", role: "admin" },
  remove: { vault: "team", removed: "dana", kv: 3, rotate: ["team/api-token", "team/db-login"] },
  health: {
    items: [{ name: "db-login", kind: "login", reasons: ["weak", "reused"], group: "g1" }, { name: "old-key", kind: "secret", reasons: ["old"] }],
    counts: { weak: 1, reused: 1, old: 1, rotate: 0, "2fa-available": 0, "passkey-available": 0, unprotected: 0, expired: 0, expiring: 0 },
    checked: 14, touchid: { enrolled: false, available: false }, at: 1_790_000_000_000,
  },
  healthSummary: { total: 3, rotate: 1, fix: 2, counts: { weak: 1, reused: 1, old: 1 }, dismissed_until: null },
  healthDismissed: { total: 0, rotate: 0, fix: 0, counts: {}, dismissed_until: 1_790_604_800_000 },
  dismiss: { dismissed_until: 1_790_604_800_000 },
  link: { linked: { item: "portal-login", to: "vyre://spc_aaaaaaaaaaaa/client/0194c2a1-7b3e-4c1d-9a55-3f2b8e6d7c10" } },
  unlink: { unlinked: { item: "portal-login", to: "vyre://spc_aaaaaaaaaaaa/client/0194c2a1-7b3e-4c1d-9a55-3f2b8e6d7c10" } },
  links: { links: [{ item: "portal-login", to: "vyre://spc_aaaaaaaaaaaa/client/0194c2a1-7b3e-4c1d-9a55-3f2b8e6d7c10", since: 1_790_000_000_000 }] },
  usesFor: { uses: [{ item: "portal-login", at: 1_790_000_100_000, by: "the agent kit", line: "portal-login was used to sign in by the agent kit" }] },
  events: {
    "vault.linked": { name: "portal-login", to: "vyre://spc_aaaaaaaaaaaa/client/0194c2a1-7b3e-4c1d-9a55-3f2b8e6d7c10" },
    "vault.unlinked": { name: "portal-login", to: "vyre://spc_aaaaaaaaaaaa/client/0194c2a1-7b3e-4c1d-9a55-3f2b8e6d7c10" },
    "vault.shared-created": { vault: "team" },
    "vault.shared-joined": { vault: "team", role: "member" },
    "vault.member-added": { vault: "team", member: "dana", role: "member" },
    "vault.member-role": { vault: "team", member: "dana", role: "admin" },
    "vault.member-removed": { vault: "team", member: "dana", rotate: 2 },
    "vault.key-rotated": { vault: "team", kv: 2 },
  },
};

/** Who each tool admits (the caller kinds of its `callers` list), and whether it takes the one yes. */
export const vaultCallers = {
  "vault.vaults.create": { admits: ["cli", "local", "device"], yes: false },
  "vault.vaults.list": { admits: ["cli", "local", "deck", "capsule", "tailnet", "device", "module"], yes: false },
  "vault.vaults.sync": { admits: ["cli", "local", "device", "mcp"], yes: false },
  "vault.vaults.rotate": { admits: ["cli", "local", "device"], yes: true },
  "vault.members.invite": { admits: ["cli", "local", "device"], yes: true },
  "vault.members.accept": { admits: ["cli", "local", "device"], yes: false },
  "vault.members.role": { admits: ["cli", "local", "device"], yes: true },
  "vault.members.remove": { admits: ["cli", "local", "device"], yes: true },
  "vault.link": { admits: ["cli", "local", "device"], yes: false },
  "vault.unlink": { admits: ["cli", "local", "device"], yes: false },
};
/** Caller kinds a model session has: none of them reaches a write above. */
export const modelCallers = ["harness", "ext"];
