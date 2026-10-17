// The share sheet's sample world: the design studio's people, agents and groups, and who may instruct whom. Used by the preview and by the Vault's sample data; nothing here is real.
import type { Directory, Who } from "./ShareSheet";

export const ME = "alex";
export const NAMES: Record<string, string> = { alex: "Alex Rivera", chris: "Chris Okafor", dana: "Dana Whitfield", iris: "Iris Chen" };
export const PEOPLE: Who[] = [
  { id: "chris", kind: "person", name: "Chris Okafor", sub: "Admin" },
  { id: "dana", kind: "person", name: "Dana Whitfield", sub: "Member" },
  { id: "iris", kind: "person", name: "Iris Chen", sub: "Member" },
];
/** Who can instruct each agent: the signed-in member may share with an agent only if she is one of them. */
export const AGENTS: Who[] = [
  { id: "kit", kind: "agent", name: "Kit", sub: "Billing agent", instructors: ["alex", "chris", "dana"], names: NAMES },
  { id: "juno", kind: "agent", name: "Juno", sub: "Intake agent", instructors: ["alex"], names: NAMES },
  { id: "atlas", kind: "agent", name: "Atlas", sub: "Research agent", instructors: ["chris"], names: NAMES },
];
export const GROUPS0: Who[] = [
  { id: "billing", kind: "group", name: "Billing", people: ["chris", "dana"], agents: ["kit"] },
  { id: "marketing", kind: "group", name: "Marketing", people: ["dana", "iris"], agents: ["juno"] },
];
export const dirOf = (groups: Who[]): Directory => ({ people: PEOPLE, groups, agents: AGENTS });
