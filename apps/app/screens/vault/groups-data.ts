// Where Groups get their rows: the sample world, or the Space's kernel through spaces.groups.* (owner and admin change them, everyone sees the groups they are in), with the people from spaces.members.list and
// the agents from agents.list. An agent in a group is by its stable id, never its name.
import { tool } from "../../src/real/box";
import type { Who } from "./ShareSheet";

export type GroupsData = {
  load(): Promise<{ groups: Who[]; people: Who[]; agents: Who[] }>;
  save(g: { id: string; name: string; people: string[]; agents: string[] }): Promise<void>;
  remove(id: string): Promise<void>;
};

const arr = (d: unknown, key: string): any[] => (Array.isArray(d) ? d : d && Array.isArray((d as any)[key]) ? (d as any)[key] : []);

export function realGroups(space: string): GroupsData {
  return {
    async load() {
      const [g, m, a] = await Promise.all([tool<any>("spaces.groups.list", { space }), tool<any>("spaces.members.list", { space }), tool<any>("agents.list", {}).catch(() => [])]);
      const groups: Who[] = arr(g, "groups").map((x) => ({ id: String(x.id), kind: "group", name: String(x.name), people: x.people ?? [], agents: x.agents ?? [] }));
      const people: Who[] = arr(m, "members").filter((x) => x && typeof x.person === "string").map((x) => ({ id: String(x.person), kind: "person", name: String(x.name || x.person), sub: String(x.role || "") }));
      const agents: Who[] = arr(a, "agents").filter((x) => x && (x.uid || x.id) && x.name).map((x) => ({ id: String(x.uid || x.id), kind: "agent", name: String(x.name) }));
      return { groups, people, agents };
    },
    async save(g) { await tool("spaces.groups.set", { space, ...(g.id ? { id: g.id } : {}), name: g.name, people: g.people, agents: g.agents }); },
    async remove(id) { await tool("spaces.groups.remove", { space, id }); },
  };
}
