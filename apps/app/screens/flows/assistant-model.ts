// The pure half of @Engineer on the real box: the Engineer is an assistant (an agent named engineer) you talk to in the app's chat. It proposes Flows, types and Kits; each proposal lands where a person
// approves it (a Flow version waiting in Flows, a Kit waiting for a yes, a task). Nothing here composes a proposal: the cards are what the box lists.

export type Agent = { name: string; kind: string; status?: string; doing?: string; thread?: string | null };
export type FlowRow = { id: string; name?: string; status: string; active?: boolean; versions?: number };
export type KitRow = { id: string; version: number; status: string };

export const ENGINEER = "engineer";

export const INSTRUCTIONS =
  "You are @Engineer. You help a space's admins describe how their work runs, and you propose the definitions for it: Flows, record types and Kits. " +
  "You only propose: nothing you write runs or changes the space until a person approves it. You never send, pay, publish or read the vault. " +
  "Ask what you need to know, say in plain words what you would change, then write the draft.";

/** The Engineer agent, if the space has one. */
export const findEngineer = (agents: Agent[]): Agent | null => agents.find((a) => a.name.toLowerCase() === ENGINEER) ?? null;

/** Only owners and admins talk to @Engineer. */
export const mayTalk = (role: string | undefined): boolean => role === "owner" || role === "admin";

/** What the page shows for the Engineer's state. */
export function stateOf(a: Agent | null): "none" | "new" | "ready" { return !a ? "none" : a.thread ? "ready" : "new"; }

/** Proposals waiting on a person, as cards: a Flow version not yet approved, a Kit waiting for a yes. */
export function proposals(flows: FlowRow[], kits: KitRow[]): { key: string; title: string; sub: string; href: string | null }[] {
  const f = flows.filter((x) => x.status !== "approved").map((x) => ({ key: `flow:${x.id}`, title: x.name || x.id, sub: "A Flow waiting for your approval", href: `/u/flows/${x.id}` }));
  const k = kits.filter((x) => x.status === "pending").map((x) => ({ key: `kit:${x.id}`, title: x.id.replace(/[-_]+/g, " "), sub: "A Kit waiting for your yes", href: null }));
  return [...f, ...k];
}

export function engineerRefusal(code: string | undefined, message: string): string {
  if (code === "denied" || code === "forbidden") return "You may not talk to @Engineer in this space.";
  return message || "@Engineer did not answer.";
}
