// Vault, Vaults: the Space's named vaults. Owner surfaces; the sample world edits in memory.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorState, LoadingState } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { MOCK } from "../../src/real/box";
import { VaultsPanel, type Vlt } from "./VaultsPanel";
import type { Directory, Level, Share, Who } from "./ShareSheet";
import { realVaults, type VaultsData } from "./vaults-data";
import { AGENTS, GROUPS0, ME, PEOPLE } from "./share-sample";

const SAMPLE: Vlt[] = [
  { id: "mine", name: "Personal", sub: "Only you can open it", count: 7, shares: [], mine: true },
  { id: "acme", name: "Northwind Bakery (client)", sub: "A vault of this Space", count: 9, shares: [{ id: "billing", level: "use" }, { id: "dana", level: "edit" }] },
];

export function VaultsScreen() {
  const [world, setWorld] = useState<{ vaults: Vlt[]; dir: Directory } | null>(null);
  const [err, setErr] = useState("");
  const data: VaultsData = useMemo(() => {
    if (!MOCK) return realVaults();
    let vs = [...SAMPLE];
    const dir: Directory = { people: PEOPLE, groups: GROUPS0, agents: AGENTS };
    return {
      load: async () => ({ vaults: vs, dir }),
      create: async (name, everyone) => { vs = [...vs, { id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, sub: "A vault of this Space", count: 0, shares: everyone ? [{ id: "everyone", level: "use" }] : [] }]; },
      share: async (v, w, level) => { vs = vs.map((x) => (x.id === v ? { ...x, shares: [...x.shares.filter((s) => s.id !== w.id), ...(level ? [{ id: w.id, level }] : [])] } : x)); },
      remove: async (id) => { vs = vs.filter((x) => x.id !== id); },
    };
  }, []);
  const reload = useCallback(() => { setErr(""); data.load().then(setWorld).catch((e) => setErr(String(e?.message || "The vaults did not load."))); }, [data]);
  useEffect(reload, [reload]);
  const kind = (w: Who | { id: string }): Who["kind"] => ("kind" in w ? w.kind : "person");
  if (err) return <Frame title="Vaults" sub="Vaults of this Space." back="/u/vault"><ErrorState title="The vaults did not load" reason={err} retry={reload} /></Frame>;
  if (!world) return <Frame title="Vaults" sub="Vaults of this Space." back="/u/vault"><LoadingState rows={3} /></Frame>;
  const find = (id: string): Who => [...world.dir.people, ...world.dir.groups, ...world.dir.agents].find((x) => x.id === id) ?? { id, kind: id === "everyone" ? "group" : "person", name: id };
  const set = (vault: string, id: string, level: Level | null) => data.share(vault, { id, kind: kind(find(id)) }, level).then(reload);
  return (
    <Frame title="Vaults" sub="Each one kept apart, shared as a whole." back="/u/vault">
      <VaultsPanel vaults={world.vaults} dir={world.dir} me={MOCK ? ME : null} levels={MOCK ? undefined : ["use"]}
        onCreate={async (name, everyone) => { await data.create(name, everyone); reload(); }}
        onAdd={(v, w) => set(v, w.id, "use")} onLevel={(v, id, l) => set(v, id, l)} onRemove={(v, id) => set(v, id, null)} onRemoveVault={async (id) => { await data.remove(id); reload(); }} />
    </Frame>
  );
}

export type { Share };
