// The pure half of @Engineer on the real box: the Engineer is an assistant (an agent named engineer) you talk to in the app's chat. It proposes Flows, types and Kits; each proposal lands where a person
// approves it (a Flow version waiting in Flows, a Kit waiting for a yes, a task). Nothing here composes a proposal: the cards are what the box lists.

export type Agent = { name: string; kind: string; status?: string; doing?: string; thread?: string | null };
export type FlowRow = { id: string; name?: string; status: string; active?: boolean; versions?: number };
export type KitRow = { id: string; version: number; status: string };
export type TaskRow = { id: string; kind?: string; title?: string; state?: string; form?: { kind?: string }; by?: unknown };

export const ENGINEER = "engineer";

/** The Engineer agent, if the space has one. */
export const findEngineer = (agents: Agent[]): Agent | null => agents.find((a) => a.name.toLowerCase() === ENGINEER) ?? null;

/** Only owners and admins talk to @Engineer. */
export const mayTalk = (role: string | undefined): boolean => role === "owner" || role === "admin";

/** What the page shows for the Engineer's state. */
export function stateOf(a: Agent | null): "none" | "new" | "ready" { return !a ? "none" : a.thread ? "ready" : "new"; }

/** An open task the Engineer (or a Kit) put in Now as a proposal: its own `kind` says so, or its form is a Kit install. Done, skipped and rejected ones are over. */
export const openProposals = (tasks: TaskRow[]): TaskRow[] => tasks.filter((t) => (t.kind === "proposal" || t.form?.kind === "kit_install" || t.form?.kind === "proposal") && t.state !== "done" && t.state !== "skipped" && t.state !== "rejected");

/** Proposals waiting on a person, as cards: each proposal task in Now (opens its approve card), a Flow version not yet approved, a Kit waiting for a yes. */
export function proposals(flows: FlowRow[], kits: KitRow[], tasks: TaskRow[] = []): { key: string; title: string; sub: string; href: string | null }[] {
  const t = openProposals(tasks).map((x) => ({ key: `task:${x.id}`, title: x.title || "A proposal", sub: "A proposal waiting for your approval", href: `/u/task/${x.id}` }));
  const f = flows.filter((x) => x.status !== "approved").map((x) => ({ key: `flow:${x.id}`, title: x.name || x.id, sub: "A Flow waiting for your approval", href: `/u/flows/${x.id}` }));
  const k = kits.filter((x) => x.status === "pending").map((x) => ({ key: `kit:${x.id}`, title: x.id.replace(/[-_]+/g, " "), sub: "A Kit waiting for your yes", href: null }));
  // A pending Kit has its install card as a task already: do not list it twice.
  return [...t, ...f, ...k.filter(() => !t.length)];
}

export function engineerRefusal(code: string | undefined, message: string): string {
  if (code === "denied" || code === "forbidden") return "You may not talk to @Engineer in this space.";
  return message || "@Engineer did not answer.";
}
