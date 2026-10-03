import { useState } from "react";
import { View } from "react-native";
import { aid } from "../../../../deck/ui/kernel-view.js";
import { viewDefOf } from "../../../../deck/ui/view-defs.js";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/States";
import { FilterPills } from "../components/FilterPills";
import { Menu } from "../components/Menu";
import { Table } from "../components/Table";
import { Text } from "../components/Text";
import { ActorMark } from "./ActorMark";
import { spaceRef } from "../marks/useMark";
import { progressText, recordTitle, spaceName, who, type World } from "./model";

type Item = { def: any; row: any };

/** Projects: every record of a type that holds work (Matters, Projects, Trips), in one table. Pills narrow it by space and by type; a row opens its project page. */
export function ProjectsList({ world, items, onOpen, onNew }: { world: World; items: Item[]; onOpen: (id: string) => void; onNew: (type: string) => void }) {
  const [space, setSpace] = useState("all");
  const [type, setType] = useState("all");
  const work = [...new Map(items.map((i) => [i.def.name, i.def])).values()];
  const shown = items.filter((i) => (space === "all" || i.row.labels?.source_spaces?.[0] === space) && (type === "all" || i.def.name === type));
  const ownerOf = (i: Item) => { const f = i.def.fields.find((x: any) => x.kind === "actor"); return f ? aid(i.row.data?.[f.name]?.actor) : ""; };
  return (
    <View className="gap-s4">
      <View className="flex-row items-center gap-s3">
        <Text size="page" strong className="flex-1">Projects</Text>
        <Menu trigger={<Button kind="primary" icon="plus" label="New" />} items={work.map((t) => ({ label: `New ${t.label.toLowerCase()}`, onPress: () => onNew(t.name) }))} />
      </View>
      <FilterPills label="Space" value={space} onChange={setSpace} options={[["all", "All spaces"], ...world.spaces.map((s: any) => [s.id, s.name] as [string, string])]} />
      <FilterPills label="Type" value={type} onChange={setType} options={[["all", "All"], ...work.map((t) => [t.name, viewDefOf(t).plural] as [string, string])]} />
      <Table<Item>
        rows={shown} rowKey={(i) => i.row.id} onRow={(i) => onOpen(i.row.id)} empty="Nothing here yet. A record of a type that holds work shows up here with its tasks and its team."
        columns={[
          { key: "name", label: "Name", sortValue: (i) => recordTitle(world, i.row), render: (i) => (
            <View className="flex-row items-center gap-s3"><Avatar of={{ kind: "project", id: i.row.id, name: recordTitle(world, i.row), seed: i.row.data?.avatar_seed }} size={32} space={i.row.labels?.source_spaces?.[0] ? spaceRef(spaceName(world, i.row.labels.source_spaces[0]), i.row.labels.source_spaces[0]) : undefined} /><Text strong numberOfLines={1} className="min-w-0 flex-shrink">{recordTitle(world, i.row)}</Text></View>
          ) },
          { key: "type", label: "Type", sortValue: (i) => i.def.label, render: (i) => i.def.label },
          { key: "stage", label: "Stage", sortValue: (i) => String(i.row.data?.stage ?? ""), render: (i) => String(i.row.data?.stage ?? "") },
          { key: "owner", label: "Owner", sortValue: (i) => who(world, ownerOf(i))?.name || "", render: (i) => { const a = who(world, ownerOf(i)); return a ? <View className="flex-row items-center gap-s2"><ActorMark who={a} size="sm" /><Text tone="muted" numberOfLines={1}>{a.name}</Text></View> : ""; } },
          { key: "tasks", label: "Tasks", sortValue: (i) => world.tasks.filter((t) => t.record === i.row.urn).length, render: (i) => progressText(world.tasks.filter((t) => t.record === i.row.urn)) },
        ]}
      />
      {!items.length ? <EmptyState title="Nothing here yet" /> : null}
    </View>
  );
}
