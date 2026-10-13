// The pure half of an agent's page: its two instruction files, its context, the order of the sign-ins it runs on, and where it is used. No calls here.
import { providerName, type Account } from "../settings/accounts-model.ts";

export type Entry = { provider: string; account?: string };
export type Step = { provider: string; account: string; kind: string; title: string; sub: string; missing: boolean };
export type Doc = "AGENTS.md" | "CLAUDE.md";
export type ContextFile = { name: string; size: number; at?: number };
export type Used = { kind: "chat" | "flow"; id: string; title: string; sub: string };

/** The two files an agent reads before it works: what the person calls them, and what each is for. */
export const DOCS: [Doc, string, string][] = [
  ["AGENTS.md", "AGENTS.md", "Who this agent is and how it works. Every agent tool reads this one."],
  ["CLAUDE.md", "CLAUDE.md", "Extra notes for Claude, if you want them kept apart."],
];

/** What agents.docs.set takes: the file, and the text without the stray space at its ends. */
export const docInput = (agent: string, file: Doc, text: string) => ({ agent, file, text: text.trim() + (text.trim() ? "\n" : "") });

const KIND_SUB: Record<string, string> = { login: "Your sign-in", "api-key": "API token", "setup-token": "Setup token" };

/** The plan as rows. Order is the order it is tried in; an account that was removed shows marked so it can be taken off. */
export function stepsOf(routes: unknown, accounts: Account[] | any[]): Step[] {
  const entries: Entry[] = Array.isArray((routes as any)?.entries) ? (routes as any).entries : Array.isArray(routes) ? (routes as Entry[]) : [];
  const byId = new Map<string, any>((accounts as any[]).map((a) => [a.id, a]));
  return entries.filter((e) => e && typeof e.provider === "string").map((e) => {
    const a = e.account ? byId.get(e.account) : undefined;
    const kind = a ? String(a.kind || "login") : "login";
    return {
      provider: e.provider, account: e.account || "", kind, missing: Boolean(e.account && !a),
      title: a ? String(a.label || providerName(a.provider)) : e.account ? "An account that was removed" : providerName(e.provider),
      sub: a ? `${providerName(a.provider)}. ${KIND_SUB[kind] || kind}` : `${providerName(e.provider)}`,
    };
  });
}

export const entriesOf = (steps: Step[]): Entry[] => steps.map((s) => ({ provider: s.provider, ...(s.account ? { account: s.account } : {}) }));

/** One place down (+1) or up (-1); the ends stay. */
export function move(list: Entry[], i: number, by: -1 | 1): Entry[] {
  const j = i + by;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
export const drop = (list: Entry[], i: number): Entry[] => list.filter((_, k) => k !== i);
export const add = (list: Entry[], e: Entry): Entry[] => (list.some((x) => x.provider === e.provider && (x.account || "") === (e.account || "")) ? list : [...list, e]);

/** Two accounts on one provider may break that vendor's terms: the box saves it only after the person has seen this. */
export const needsAck = (list: Entry[]): boolean => new Set(list.map((e) => e.provider)).size < list.length;
export const ACK_WORDS = "Two accounts on one provider can combine that vendor's limits, which some providers' terms do not allow. Save only if you have checked yours.";

/** The accounts a person can still add to the plan. */
export const addable = (list: Entry[], accounts: Account[] | any[]) => (accounts as any[]).filter((a) => a && !a.pending && !list.some((e) => e.account === a.id));

export function sizeLine(n: number): string {
  if (!n) return "Empty";
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n / 1024 / 1024)} MB`;
}
export const linkLine = (p: string) => ({ title: p.replace(/\/+$/, "").split("/").pop() || p, sub: p });
/** An uploaded file's name is a name and nothing more: no folder, no dots up. */
export const contextName = (s: string): string => String(s || "").trim().split(/[\\/]/).pop()!.replace(/^\.+/, "").trim();

export const NOT_USED = (name: string) => `${name} is not in any chat or flow yet. Pick it in a chat, or make it the doer of a task in a flow.`;
/** Where the agent is used: its chats, and the flows that name it as a doer. */
export function usedRows(d: any, agent: string): Used[] {
  const chats = (Array.isArray(d?.chats) ? d.chats : []).map((c: any): Used => ({ kind: "chat", id: String(c.id), title: String(c.title || "Chat"), sub: "Chat" }));
  const flows = (Array.isArray(d?.flows) ? d.flows : []).map((f: any): Used => ({ kind: "flow", id: String(f.id), title: String(f.name || "Flow"), sub: `Flow. ${agent} is the doer` }));
  return [...chats, ...flows];
}
