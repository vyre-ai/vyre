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
/** The row at `from` dropped at `to`, the others closing up. */
export function moveTo(list: Entry[], from: number, to: number): Entry[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const out = list.slice();
  out.splice(to, 0, out.splice(from, 1)[0]);
  return out;
}
/** What kind of sign-in an account is, as a short line; an account that is gone says so. */
export const kindLine = (a?: { kind?: string } | null): string => (a ? KIND_SUB[String(a.kind || "login")] || String(a.kind) : "Not available");
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
/** A linked folder as a person reads it: its name, and its place in Files ("Files / Intake forms"), not a path on the computer. */
export const linkLine = (p: string) => {
  const clean = p.replace(/\/+$/, "");
  const at = clean.lastIndexOf("/Files/");
  const rel = at >= 0 ? clean.slice(at + "/Files/".length) : clean.split("/").slice(-2).join("/");
  return { title: clean.split("/").pop() || p, sub: ["Files", ...rel.split("/").filter(Boolean)].join(" / ") };
};
/** An uploaded file's name is a name and nothing more: no folder, no dots up. */
export const contextName = (s: string): string => String(s || "").trim().split(/[\\/]/).pop()!.replace(/^\.+/, "").trim();

export const NOT_USED = (name: string) => `${name} is not in any chat or flow yet. Pick it in a chat, or make it the doer of a task in a flow.`;
/** Where the agent is used: its chats, and the flows that name it as a doer. */
export function usedRows(d: any, agent: string): Used[] {
  const chats = (Array.isArray(d?.chats) ? d.chats : []).map((c: any): Used => ({ kind: "chat", id: String(c.id), title: String(c.title || "Chat"), sub: "Chat" }));
  const flows = (Array.isArray(d?.flows) ? d.flows : []).map((f: any): Used => ({ kind: "flow", id: String(f.id), title: String(f.name || "Flow"), sub: `Flow. ${agent} runs it` }));
  return [...chats, ...flows];
}

export const LEVELS: [string, string][] = [["use", "Can use"], ["edit", "Can edit"]];
export const LEVEL_NOTE = "Can use: chat with it, pick it in a flow. Can edit: change its instructions, files, models and links. Everything it is linked to stays what the person who linked it could reach.";
/** A sharing row: who, and what kind of who. */
export function accessRow(a: { kind: string; subject: string; level: string }, people: { id: string; name: string; role: string }[], roles: { id: string; name: string }[]): { title: string; sub: string } {
  if (a.kind === "role") return { title: roles.find((r) => r.id === a.subject)?.name || a.subject, sub: "Everyone with this role" };
  const p = people.find((x) => x.id === a.subject);
  return { title: p?.name || a.subject, sub: p?.role ? `Person, ${p.role}` : "Person" };
}

/** An agent's open work as rows: what it is to do, and what it is to approve. */
export function workRows(d: { todo?: any[]; approve?: any[] }): { id: string; title: string; sub: string; kind: "todo" | "approve" }[] {
  const row = (t: any, kind: "todo" | "approve") => ({ id: String(t.id), title: String(t.title || "A task"), kind, sub: kind === "approve" ? "Waiting for it to approve" : t.state === "stuck" ? "Stuck" : t.state === "working" ? "Working on it" : t.state === "waiting" ? "Waiting on something" : "To do" });
  return [...(d.todo || []).map((t) => row(t, "todo")), ...(d.approve || []).map((t) => row(t, "approve"))];
}
export const NO_WORK = (name: string) => `Nothing is waiting on ${name} right now.`;
/** The line under an agent's instructions: who made it and who last changed its words. */
export function authorLine(made: { name: string; staff: boolean } | null, edited: { name: string } | null): string {
  if (!made) return "";
  return `Made by ${made.name}${made.staff ? "" : " (not an admin)"}${edited && edited.name !== made.name ? `. Instructions last changed by ${edited.name}` : ""}.`;
}
