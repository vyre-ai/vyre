// Settings, Groups: named sets of people and agents of the Space, for giving a vault (and later a Flow, a chat or a project) to several at once. Owner and admin make and change them; everyone sees the groups
// they are in. The sample world edits in memory; the real one is spaces.groups.* on the Space's kernel.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, EmptyState, ErrorState, LoadingState, Text, showToast } from "@vyre/ui";
import { Footnote } from "../places/Frame";
import { EmbedPage } from "../settings/embed";
import { within } from "../../src/state/kept-model.js";
import { useMembers } from "../spaces/state";
import { MOCK } from "../../src/real/box";
import { GroupsPanel } from "./GroupsPanel";
import type { Who } from "./ShareSheet";
import { realGroups, type GroupsData } from "./groups-data";
import { AGENTS, GROUPS0, PEOPLE } from "./share-sample";

export function GroupsScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const { spaces, space, load } = useMembers();
  useEffect(() => { void load(); }, [load]);
  const mine = MOCK ? "owner" : spaces.find((s) => s.id === space)?.role;
  const [world, setWorld] = useState<{ groups: Who[]; people: Who[]; agents: Who[] } | null>(null);
  const [err, setErr] = useState("");
  const data: GroupsData = useMemo(() => {
    if (!MOCK) return realGroups(space ?? "");
    let groups = [...GROUPS0];
    return {
      load: async () => ({ groups, people: PEOPLE, agents: AGENTS }),
      save: async (g) => { groups = g.id ? groups.map((x) => (x.id === g.id ? { ...x, name: g.name, people: g.people, agents: g.agents } : x)) : [...groups, { id: g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), kind: "group", name: g.name, people: g.people, agents: g.agents }]; },
      remove: async (id) => { groups = groups.filter((x) => x.id !== id); },
    };
  }, [space]);
  const reload = useCallback(() => { setErr(""); within(data.load()).then(setWorld).catch((e) => setErr(String(e?.message || "The space did not answer."))); }, [data]);
  useEffect(reload, [reload]);
  const admin = mine === "owner" || mine === "admin";
  if (err) return <EmbedPage embedded={embedded} title="Groups" back="/u/settings"><ErrorState title="The groups did not load" reason={err} retry={reload} /></EmbedPage>;
  if (!world) return <EmbedPage embedded={embedded} title="Groups" back="/u/settings"><LoadingState rows={3} /></EmbedPage>;
  return (
    <EmbedPage embedded={embedded} title="Groups" sub="Sets of people and agents you give things to at once." back="/u/settings">
      {admin ? (
        <GroupsPanel groups={world.groups} people={world.people} agents={world.agents}
          onSave={async (g) => { await data.save(g); showToast(`${g.name} saved.`); reload(); }}
          onRemove={async (id) => { await data.remove(id); showToast("Group removed. What was shared with it reaches no one."); reload(); }} />
      ) : (
        <Card>{world.groups.length ? <Text>{world.groups.map((g) => g.name).join(", ")}</Text> : <EmptyState title="You are in no groups" body="An owner or an admin makes groups and puts people and agents in them." />}</Card>
      )}
      {!admin ? <Footnote icon="info">Only an owner or an admin changes groups.</Footnote> : null}
    </EmbedPage>
  );
}
