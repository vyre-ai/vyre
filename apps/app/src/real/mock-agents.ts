// The agent page's tools answered from memory, for the sample build (EXPO_PUBLIC_VYRE_MOCK=1) only: an Intake assistant with its instructions, two context files, a Claude login with an API token behind it, and its use in a chat and a flow.
// The shapes are the box's own (core/agents/config.js, core/sessions); what a person changes stays for the session.
import { loadAssistants } from "../../screens/settings/data";
import { WHO } from "../store-core/mock-ids.js";

const AGENTS_MD = `You are the intake assistant for Juniper Studio.

When a new inquiry arrives:
1. Read the form and the first message. Write the facts down in plain words.
2. Check the conflict list before anything else.
3. Draft the first reply for a person to approve. Never send it yourself.

Ask when something is missing. Do not guess a date, a name or an amount.
`;
const CLAUDE_MD = "Write short sentences. Use the client's own words for their situation.\n";

const REFUNDS_MD = `You handle refund requests for Juniper Studio.

1. Read the request and the order. Check the refund policy in your context files.
2. Under $200 and inside 30 days: draft the refund for a person to approve.
3. Over $200, past 30 days, or a customer who is upset: do not decide. Escalate to the owner with the order, the amount, and what the customer said, in three lines.

Never promise a refund in a reply. A person sends every message.
`;
type State = { role: string; docs: Record<string, string>; files: { name: string; size: number; at: number }[]; links: string[]; routes: { provider: string; account?: string }[]; vault: string[]; instructions: string; lent: { id: string; agent: string; item: string; origin: string; expires: number }[] };
const intake = (): State => ({
  role: "Intake assistant",
  docs: { "AGENTS.md": AGENTS_MD, "CLAUDE.md": CLAUDE_MD },
  files: [{ name: "intake-checklist.pdf", size: 184320, at: 1760000000000 }, { name: "price-list.xlsx", size: 42000, at: 1760100000000 }],
  links: ["/Users/alex/Vyre/Files/Intake forms"],
  routes: [{ provider: "claude", account: "acc_login" }, { provider: "claude", account: "acc_key" }],
  vault: ["lawmatics-api"],
  instructions: AGENTS_MD,
  lent: [{ id: "ag_0", agent: "intake", item: "lawmatics", origin: "https://app.lawmatics.com", expires: Date.now() + 20 * 86400000 }],
});
const refunds = (): State => ({
  role: "Refunds agent",
  docs: { "AGENTS.md": REFUNDS_MD, "CLAUDE.md": "Be calm and exact. Quote the policy, never paraphrase an amount.\n" },
  files: [{ name: "refund-policy.pdf", size: 96000, at: 1760200000000 }],
  links: [],
  routes: [{ provider: "claude", account: "acc_login" }, { provider: "openrouter", account: "acc_or" }],
  vault: [],
  instructions: REFUNDS_MD,
  lent: [],
});
let access: { kind: string; subject: string; level: string; by: string | null }[] = [{ kind: "person", subject: "per_dana", level: "edit", by: "per_you" }];
let projectDoc = "# Harlow Legal\n\nEvery chat here works for the Harlow matters.\n\n- Never send an email without the lawyer's yes.\n- Cite the file number in every draft.\n";
let projectRefs: { name: string; kind: string; size: number; files?: string }[] = [{ name: "Fee schedule.md", kind: "note", size: 420 }, { name: "Intake form.link", kind: "link", size: 60, files: "Clients/Harlow/intake.pdf" }, { name: "engagement-letter.docx", kind: "file", size: 52000 }];
// juno, kit, iris and rev carry their own short sample words, so no page shows the intake agent's.
const own = (role: string, md: string): State => ({ role, docs: { "AGENTS.md": md, "CLAUDE.md": "Write short sentences.\n" }, files: [], links: [], routes: [{ provider: "claude", account: "acc_login" }], vault: [], instructions: md, lent: [] });
const ROLES: Record<string, string> = { juno: "Your assistant", kit: "Research agent", iris: "Drafting agent", rev: "Reviewer" };
const W: Record<string, State> = {
  intake: intake(), refunds: refunds(),
  juno: own("Your assistant", "You are Alex's assistant.\n\nKeep Alex's day in order: read what came in, say what needs a decision, and draft the replies for Alex to approve. Never send anything yourself.\n"),
  kit: own("Agent of Alex", "You are kit, Alex's research agent.\n\nFind the facts behind a question, name the source of each, and say what you could not confirm.\n"),
  iris: own("Agent of Chris", "You are iris, Chris's drafting agent.\n\nDraft letters and summaries in Chris's voice for Chris to review.\n"),
  rev: own("Teammate, Juniper Studio", "You are rev, the reviewer on Juniper Studio's matters.\n\nCheck each draft against the file and list what does not match.\n"),
};
const w = (i: any): State => W[String(i?.agent ?? i?.name ?? "intake")] ?? W.intake;
const accounts = [
  { id: "acc_login", provider: "claude", label: "Claude (Alex)", kind: "login", is_default: true, signed_in_at: 1760000000000, identity: { email: "alex@juniper.studio" } },
  { id: "acc_key", provider: "claude", label: "Anthropic API token", kind: "api-key", vault_item: "anthropic-api-key" },
  { id: "acc_or", provider: "openrouter", label: "OpenRouter", kind: "api-key", vault_item: "openrouter-key" },
];
const agentOf = (name: string) => ({ uid: `agt_${name}`, name, kind: "agent", role: W[name].role, description: W[name].role, projects: ["juniper"], instructions: W[name].instructions, model: "sonnet", effort: "medium", computer: false, status: "idle", thread: null });

const PROJECTS: Record<string, string> = { juniper: "Juniper Studio", passport: "Passport renewal" };
export const mockAgentTools: Record<string, (i: any) => unknown> = {
  "work.project.ref": (i) => ({ name: PROJECTS[String(i.project)] ?? String(i.project) }),
  // One list for the Agents screen and the agent page, so every row opens: the sample world's assistants and agents (settings/data.ts), then the two that carry sample pages.
  "agents.list": () => [
    ...loadAssistants().map((a) => ({ uid: `agt_${a.id}`, name: a.name, kind: a.family === "assistant" ? "assistant" : "agent", model: a.model, effort: "medium", projects: ["juniper"], computer: false, status: a.paused ? "stopped" : "idle", thread: "x", autonomy: a.autonomy, id: a.id,
      instructions: W[a.id]?.instructions ?? String(a.role), made_by: a.id === "iris" ? WHO.chris : a.id === "rev" ? WHO.chris : WHO.alex, ...(a.id === "rev" ? { shares: [{ person: WHO.alex, level: "use" }] } : {}) })),
    ...["intake", "refunds"].map((n) => ({ ...agentOf(n), made_by: WHO.alex })),
  ],
  "agents.usage": (i) => [{ agent: String(i.agent ?? "intake"), auth: "subscription", turns: 41, threads: 6, duration_ms: 5_400_000, last_at: Date.now() - 3_600_000, tokens: { input: 210000, output: 38000 } }],
  "sessions.models.get": () => ({ aliases: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", haiku: "claude-haiku-5-5" } }),
  "watchers.list": () => [],
  "agents.update": (i) => { if (typeof i.instructions === "string") w(i).instructions = i.instructions; return agentOf(String(i.name ?? i.agent)); },
  "agents.ask": () => ({ thread: "thr_intake_1", project: "juniper" }),
  "agents.docs.get": (i) => ({ files: { ...w(i).docs } }),
  "agents.docs.set": (i) => { w(i).docs[i.file] = i.text; if (i.file === "AGENTS.md") w(i).instructions = i.text; return { ok: true, file: i.file }; },
  "agents.context.list": (i) => ({ files: w(i).files.slice(), links: w(i).links.slice() }),
  "agents.context.add": (i) => { w(i).files = [...w(i).files.filter((f) => f.name !== i.name), { name: i.name, size: Math.round((String(i.base64).length * 3) / 4), at: Date.now() }]; return { ok: true, name: i.name }; },
  "agents.context.remove": (i) => { w(i).files = w(i).files.filter((f) => f.name !== i.name); return { ok: true }; },
  "agents.context.link": (i) => { if (!w(i).links.includes(i.path)) w(i).links.push(i.path); return { ok: true, path: i.path }; },
  "agents.context.unlink": (i) => { w(i).links = w(i).links.filter((p) => p !== i.path); return { ok: true }; },
  "files.dirs": (i) => ({ dirs: [{ name: "Intake forms", path: "/Users/alex/Vyre/Files/Intake forms" }, { name: "Intake archive", path: "/Users/alex/Vyre/Files/Intake archive" }].filter((d) => d.name.toLowerCase().includes(String(i.q || "").toLowerCase())) }),
  "sessions.accounts.list": () => accounts,
  "sessions.routes.get": (i) => ({ scope: i.scope, entries: w({ agent: String(i.scope).replace("agent:", "") }).routes.slice() }),
  "sessions.routes.set": (i) => { w({ agent: String(i.scope).replace("agent:", "") }).routes = i.entries; return { scope: i.scope, entries: i.entries }; },
  "vault.list": () => ({ items: [{ name: "lawmatics-api", kind: "api-key", hosts: [] }, { name: "lawmatics", kind: "login", hosts: ["https://app.lawmatics.com"] }, { name: "mail", kind: "login", hosts: ["https://mail.juniper.studio"] }, { name: "anthropic-api-key", kind: "api-key", hosts: [] }], locked: false, personal: "none" }),
  "agents.vault.list": (i) => ({ assigned: w(i).vault.slice() }),
  "agents.vault.assign": (i) => { if (!w(i).vault.includes(i.item)) w(i).vault.push(i.item); return { ok: true }; },
  "agents.vault.unassign": (i) => { w(i).vault = w(i).vault.filter((x) => x !== i.item); return { ok: true }; },
  "vault.agent.grants": (i) => ({ grants: w(i).lent.map((g) => ({ ...g, status: "active", uses: 3 })) }),
  "vault.agent.grant": (i) => { w(i).lent.push({ id: `ag_${i.agent}_${w(i).lent.length + 1}`, agent: i.agent, item: i.item, origin: i.origin, expires: Date.now() + 30 * 86400000 }); return { grant: { status: "active", ...i } }; },
  "vault.agent.revoke": (i) => { for (const x of Object.values(W)) x.lent = x.lent.filter((g) => g.id !== i.id); return { revoked: true }; },
  "agents.access.get": () => ({ access: access.slice(), people: [{ id: "per_dana", name: "Dana Reyes", role: "member" }, { id: "per_sam", name: "Sam Okafor", role: "admin" }, { id: "per_lee", name: "Lee Park", role: "member" }], roles: [{ id: "member", name: "Members" }, { id: "paralegal", name: "Paralegals" }] }),
  "agents.access.set": (i) => { access = access.filter((a) => !(a.kind === i.kind && a.subject === i.subject)); if (i.level) access.push({ kind: i.kind, subject: i.subject, level: i.level, by: "per_you" }); return { ok: true }; },
  "tasks.list": (i) => i.checker ? { tasks: [{ id: "t_ref_2", title: "Check the refund draft for order 4471", state: "needs_check" }] } : { tasks: [{ id: "t_int_1", title: "Draft the first reply to Priya Shah", state: "working" }, { id: "t_int_2", title: "Check the conflict list", state: "ready" }] },
  "projects.docs.get": () => ({ files: { "AGENTS.md": projectDoc, "CLAUDE.md": projectDoc }, kept_same: true }),
  "projects.docs.set": (i) => { projectDoc = i.text; return { ok: true, file: i.file }; },
  "projects.refs.list": () => ({ items: projectRefs.slice() }),
  "projects.refs.add": (i) => { projectRefs = [...projectRefs.filter((r) => !r.name.startsWith(i.name)), i.files ? { name: `${i.name}.link`, kind: "link", size: 60, files: i.files } : i.text ? { name: `${i.name}.md`, kind: "note", size: i.text.length } : { name: i.name, kind: "file", size: 1000 }]; return { ok: true }; },
  "projects.refs.remove": (i) => { projectRefs = projectRefs.filter((r) => r.name !== i.name); return { ok: true }; },
  "agents.used": (i) => i.agent === "refunds" ? ({ chats: [{ id: "thr_ref_1", title: "Refund request, order 4471" }], flows: [{ id: "flw_refunds", name: "Refund requests" }] }) : ({ chats: [{ id: "thr_intake_1", title: "Priya Shah: first inquiry" }, { id: "thr_intake_2", title: "Weekly intake review" }], flows: [{ id: "flw_new_client", name: "New client intake" }] }),
};
