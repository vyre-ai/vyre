// @ts-check
// Fixtures for team/contracts/ext-agents.md. trust builds the Vault pass's move into the one registration against these while chat builds the module; lib/outside.js (real today) is checked against them
// by test/contracts/ext-agents.test.js. No value here is a real token: tokens are `vext_` plus 43 url-safe characters.

export const ID = "k3m9x2q7pw4t";
export const extFixtures = {
  id: ID,
  caller: `ext:${ID}`,
  actor: `ext_${ID}`,
  /** What outside.register returns, once: the token is shown this one time. */
  registered: { id: ID, name: "Muse", kind: "any", note: "writes our newsletter", token: "vext_Zk3pQ9wL2mTxV8aBHq7nR4sD1yUeC6jMLw5vG0tF8oI", url: "https://harlow.vyre.run/agents-mcp", expires: 1_793_000_000_000 },
  /** What outside.list returns for it: never the token. */
  listed: { id: ID, name: "Muse", kind: "any", note: "writes our newsletter", reach: "reads Clients and Matters; asks to add or change them", expires: 1_793_000_000_000, lastUsed: null, uses: 0, status: "active" },
  /** A grant the person gives (outside.grant input), one per kind. */
  grants: {
    records: { id: ID, what: { kind: "records", types: ["client", "matter"], write: true }, days: 30 },
    project: { id: ID, what: { kind: "records", project: "harlow" } },
    memory: { id: ID, what: { kind: "memory", project: "harlow" } },
    files: { id: ID, what: { kind: "files", project: "harlow" } },
    vault: { id: ID, what: { kind: "vault", items: ["ghl-api"], hosts: ["services.leadconnectorhq.com"] } },
  },
  /** The kernel grants a records grant becomes (subject, actions, selector, source). trust's mints contract says how they are minted. */
  mints: [
    { subject: { actor: { kind: "agent", id: `ext_${ID}` } }, actions: ["records.read"], selector: { prefix: "vyre://<space>/records/client" }, source: `outside:${ID}` },
    { subject: { actor: { kind: "agent", id: `ext_${ID}` } }, actions: ["records.create"], selector: { prefix: "vyre://<space>/records/client" }, source: `outside:${ID}` },
  ],
  /** MCP exchanges at /agents-mcp (Streamable HTTP, JSON-RPC in a POST, bearer header). */
  mcp: {
    headers: { authorization: "Bearer vext_Zk3pQ9wL2mTxV8aBHq7nR4sD1yUeC6jMLw5vG0tF8oI" },
    initializeResult: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "vyre", version: "1" } },
    listedWithRecordsReadOnly: ["whoami", "records_types", "records_list", "records_get"],
    listedWithNoGrant: ["whoami"],
    heldAnswer: { held: "hd_0194c2a1", message: "Waiting for the person to approve: add a client, Dana Reyes. Call held_get to see their answer." },
    deniedAnswer: { isError: true, text: "records_create needs the person to give you write access first." },
  },
  /** The Gate item a write files (the approvals card): who asked, in words, and the exact change. */
  heldItem: { sender: `outside:Muse`, summary: "Muse wants to add a client: Dana Reyes", facts: [{ label: "Type", value: "Client" }, { label: "Name", value: "Dana Reyes" }], effect: "records.create" },
  /** Events (names and urns, never values). */
  events: {
    "outside.registered": { id: ID, name: "Muse", kind: "any" },
    "outside.granted": { id: ID, kind: "records", resource: "vyre://<space>/records/client", write: true },
    "outside.used": { id: ID, name: "Muse", tool: "records_get", resource: "vyre://<space>/records/client/ab12", outcome: "ok" },
    "outside.held": { id: ID, name: "Muse", held: "hd_0194c2a1", tool: "records_create" },
    "outside.revoked": { id: ID, name: "Muse", by: "owner" },
  },
};
