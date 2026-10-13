// The AI-key tools answered from memory, for the sample build (EXPO_PUBLIC_VYRE_MOCK=1) only: two keys, a local one and a hosted one, each with a few changes. The shapes are the box's own (core/mcpconn).
const MIN = 60_000;
type Key = { id: string; name: string; where: string; hosted: boolean; created: number; lastUsed: number | null; revoked: boolean };
const now = () => Date.now();
let keys: Key[] | null = null;
const seed = (): Key[] => [
  { id: "mcn_sample1", name: "Claude Code on laptop", where: "Alex MacBook", hosted: false, created: now() - 3 * 86_400_000, lastUsed: now() - 2 * MIN, revoked: false },
  { id: "mcn_sample2", name: "Zapier", where: "hosted", hosted: true, created: now() - 9 * 86_400_000, lastUsed: now() - 26 * 60 * MIN, revoked: false },
];
const list = () => (keys ??= seed());

export const mockMcpTools: Record<string, (input: any) => unknown> = {
  "mcpconn.list": () => list(),
  "mcpconn.activity": () => [
    { at: now() - 2 * MIN, name: "Claude Code on laptop", tool: "projects.create", ok: true, says: "via Claude Code on laptop" },
    { at: now() - 9 * MIN, name: "Claude Code on laptop", tool: "agents.create", ok: true, says: "via Claude Code on laptop" },
    { at: now() - 26 * 60 * MIN, name: "Zapier", tool: "records.create", ok: true, says: "via Zapier" },
    { at: now() - 26 * 60 * MIN - MIN, name: "Zapier", tool: "memory.remember", ok: true, says: "via Zapier" },
  ],
  "mcpconn.connect": (i) => {
    const hosted = Boolean(i?.hosted), name = String(i?.name || (hosted ? "Hosted AI" : "Claude Code on laptop"));
    const id = `mcn_sample${list().length + 1}`;
    list().unshift({ id, name, where: hosted ? "hosted" : "Alex MacBook", hosted, created: now(), lastUsed: null, revoked: false });
    const url = "https://harlow.vyre.run/mcp", key = `${id}~sampleSecretNotReal`;
    return hosted
      ? { id, name, key, local: false, url, snippets: { claude: `claude mcp add --transport http vyre-x ${url} --header "Authorization: Bearer ${key}"`, codex: `codex mcp add vyre-x --url ${url} --bearer-token-env-var VYRE_MCP_KEY`, json: "{}" } }
      : { id, name, key, local: true, snippets: { claude: "claude mcp add -s user vyre -- vyre mcp", codex: "codex mcp add vyre -- vyre mcp", json: "{}" } };
  },
  "mcpconn.revoke": (i) => { const k = list().find((x) => x.id === i?.id); if (k) k.revoked = true; return { revoked: true, id: i?.id }; },
};
