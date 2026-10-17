// Where named vaults come from: vault.named.* on the Space's kernel (the owner's surfaces), or the sample world. A vault's shares are one grant on it; "everyone" is the two Space-wide groups together.
import { tool } from "../../src/real/box";
import type { Directory, Level, Share, Who } from "./ShareSheet";
import type { Vlt } from "./VaultsPanel";

export type VaultsData = {
  load(): Promise<{ vaults: Vlt[]; dir: Directory }>;
  create(name: string, everyone: boolean): Promise<void>;
  share(vault: string, w: { id: string; kind: Who["kind"] }, level: Level | null): Promise<void>;
  remove(id: string): Promise<void>;
};

export function realVaults(): VaultsData {
  return {
    async load() {
      const l = await tool<{ vaults: { id: string; name: string; personal: boolean; items: number }[]; directory: { people: { id: string; name: string; role?: string }[]; teams: { id: string; name: string; people?: string[]; agents?: string[] }[]; agents: { id: string; name: string }[] } }>("vault.named.list");
      const dir: Directory = {
        people: l.directory.people.map((p) => ({ id: p.id, kind: "person", name: p.name, sub: p.role ?? "" })),
        groups: l.directory.teams.map((t) => ({ id: t.id, kind: "group", name: t.name, people: t.people ?? [], agents: t.agents ?? [] })),
        agents: l.directory.agents.map((a) => ({ id: a.id, kind: "agent", name: a.name })),
      };
      const vaults: Vlt[] = [];
      for (const v of l.vaults) {
        const a = v.personal ? { access: [] as { subject: string; level: Level }[] } : await tool<{ access: { subject: string; level: Level }[] }>("vault.named.access.get", { vault: v.id });
        vaults.push({ id: v.id, name: v.name, sub: v.personal ? "Only you can open it" : "A vault of this Space", count: v.items, mine: v.personal, shares: a.access.map((x): Share => ({ id: x.subject, level: x.level })) });
      }
      return { vaults, dir };
    },
    async create(name, everyone) {
      const r = await tool<{ vault: { id: string } }>("vault.named.create", { name });
      if (everyone) await tool("vault.named.access.set", { vault: r.vault.id, kind: "everyone", subject: "everyone", level: "use" });
    },
    async share(vault, w, level) { await tool("vault.named.access.set", { vault, kind: w.id === "everyone" ? "everyone" : w.kind === "group" ? "team" : w.kind, subject: w.id, level }); },
    async remove(id) { await tool("vault.named.remove", { id }); },
  };
}
