// The agent page's tools answered from memory, for the sample build (EXPO_PUBLIC_VYRE_MOCK=1) only: an Intake assistant with its instructions, two context files, a Claude login with an API token behind it, and its use in a chat and a flow.
// The shapes are the box's own (core/agents/config.js, core/sessions); what a person changes stays for the session.
const AGENTS_MD = `You are the intake assistant for Juniper Studio.

When a new inquiry arrives:
1. Read the form and the first message. Write the facts down in plain words.
2. Check the conflict list before anything else.
3. Draft the first reply for a person to approve. Never send it yourself.

Ask when something is missing. Do not guess a date, a name or an amount.
`;
const CLAUDE_MD = "Write short sentences. Use the client's own words for their situation.\n";

const state = {
  docs: { "AGENTS.md": AGENTS_MD, "CLAUDE.md": CLAUDE_MD } as Record<string, string>,
  files: [{ name: "intake-checklist.pdf", size: 184320, at: 1760000000000 }, { name: "price-list.xlsx", size: 42000, at: 1760100000000 }],
  links: ["/Users/alex/Vyre/Files/Intake forms"],
  routes: [{ provider: "claude", account: "acc_login" }, { provider: "claude", account: "acc_key" }] as { provider: string; account?: string }[],
  vault: ["lawmatics-api"],
  instructions: AGENTS_MD,
};
const accounts = [
  { id: "acc_login", provider: "claude", label: "Claude (Alex)", kind: "login", is_default: true, signed_in_at: 1760000000000, identity: { email: "alex@juniper.studio" } },
  { id: "acc_key", provider: "claude", label: "Anthropic API token", kind: "api-key", vault_item: "anthropic-api-key" },
  { id: "acc_or", provider: "openrouter", label: "OpenRouter", kind: "api-key", vault_item: "openrouter-key" },
];
const agent = () => ({ uid: "agt_intake", name: "intake", kind: "agent", role: "Intake assistant", projects: ["juniper"], instructions: state.instructions, model: "sonnet", effort: "medium", computer: false, status: "idle", thread: null });

export const mockAgentTools: Record<string, (i: any) => unknown> = {
  "agents.list": () => [agent()],
  "agents.usage": () => [{ agent: "intake", auth: "subscription", turns: 41, threads: 6, duration_ms: 5_400_000, last_at: Date.now() - 3_600_000, tokens: { input: 210000, output: 38000 } }],
  "sessions.models.get": () => ({ aliases: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", haiku: "claude-haiku-5-5" } }),
  "watchers.list": () => [],
  "agents.update": (i) => { if (typeof i.instructions === "string") state.instructions = i.instructions; return agent(); },
  "agents.ask": () => ({ thread: "thr_intake_1", project: "juniper" }),
  "agents.docs.get": () => ({ files: { ...state.docs } }),
  "agents.docs.set": (i) => { state.docs[i.file] = i.text; if (i.file === "AGENTS.md") state.instructions = i.text; return { ok: true, file: i.file }; },
  "agents.context.list": () => ({ files: state.files.slice(), links: state.links.slice() }),
  "agents.context.add": (i) => { state.files = [...state.files.filter((f) => f.name !== i.name), { name: i.name, size: Math.round((String(i.base64).length * 3) / 4), at: Date.now() }]; return { ok: true, name: i.name }; },
  "agents.context.remove": (i) => { state.files = state.files.filter((f) => f.name !== i.name); return { ok: true }; },
  "agents.context.link": (i) => { if (!state.links.includes(i.path)) state.links.push(i.path); return { ok: true, path: i.path }; },
  "agents.context.unlink": (i) => { state.links = state.links.filter((p) => p !== i.path); return { ok: true }; },
  "files.dirs": (i) => ({ dirs: [{ name: "Intake forms", path: "/Users/alex/Vyre/Files/Intake forms" }, { name: "Intake archive", path: "/Users/alex/Vyre/Files/Intake archive" }].filter((d) => d.name.toLowerCase().includes(String(i.q || "").toLowerCase())) }),
  "sessions.accounts.list": () => accounts,
  "sessions.routes.get": () => ({ scope: "agent:intake", entries: state.routes.slice() }),
  "sessions.routes.set": (i) => { state.routes = i.entries; return { scope: i.scope, entries: i.entries }; },
  "vault.list": () => ({ items: [{ name: "lawmatics-api", kind: "api-key" }, { name: "mail", kind: "login" }, { name: "anthropic-api-key", kind: "api-key" }], locked: false, personal: "none" }),
  "agents.vault.list": () => ({ assigned: state.vault.slice() }),
  "agents.vault.assign": (i) => { if (!state.vault.includes(i.item)) state.vault.push(i.item); return { ok: true }; },
  "agents.vault.unassign": (i) => { state.vault = state.vault.filter((x) => x !== i.item); return { ok: true }; },
  "agents.used": () => ({ chats: [{ id: "thr_intake_1", title: "Priya Shah: first inquiry" }, { id: "thr_intake_2", title: "Weekly intake review" }], flows: [{ id: "flw_new_client", name: "New client intake" }] }),
};
