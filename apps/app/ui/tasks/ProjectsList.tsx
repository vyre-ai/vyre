import { useState } from "react";
import { View } from "react-native";
import { aid, stageFieldOf, stageNames } from "../../../../deck/ui/kernel-view.js";
import { viewDefOf } from "../../../../deck/ui/view-defs.js";
import { Avatar } from "../components/Avatar";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/States";
import { Fab } from "../components/Fab";
import { IconButton } from "../components/Button";
import { Menu } from "../components/Menu";
import { Row } from "../components/Row";
import { SectionLabel } from "../components/SectionLabel";
import { Segmented } from "../components/Segmented";
import { StageMini } from "../components/StageSteps";
import { Table } from "../components/Table";
import { Text } from "../components/Text";
import { ActorMark } from "./ActorMark";
import { spaceRef } from "../marks/useMark";
import { recordTitle, spaceName, taskFraction, who, type World } from "./model";
import { Stagger } from "../motion/Appear";
import { useUiTheme } from "../theme";

type Item = { def: any; row: any };

const TABULAR = { fontVariant: ["tabular-nums" as const] };
const workTypes = (items: Item[]) => [...new Map(items.map((i) => [i.def.name, i.def])).values()];

/** The New menu: a plus icon button on a wide screen, the floating 56 button on a phone. A choice per type that holds work ("New matter"). */
export function NewMenu({ items, onNew, floating }: { items: Item[]; onNew: (type: string) => void; floating?: boolean }) {
  const work = workTypes(items);
  if (!work.length) return null;
  return <Menu trigger={floating ? <Fab label="New" /> : <IconButton icon="plus" label="New" kind="secondary" />} items={work.map((t) => ({ label: `New ${t.label.toLowerCase()}`, onPress: () => onNew(t.name) }))} />;
}

/** "2 of 4" and a 40 wide, 3 high bar, or an en dash when a record has no tasks. */
function TaskBar({ done, total, width = 40 }: { done: number; total: number; width?: number }) {
  if (!total) return <Text tone="faint">{"–"}</Text>;
  return (
    <View className="flex-row items-center gap-s2" accessible accessibilityLabel={`${done} of ${total} tasks done`}>
      <Text size="secondary" tone="muted" style={TABULAR}>{`${done} of ${total}`}</Text>
      <View className="overflow-hidden rounded-full bg-edge-strong" style={{ width, height: 3 }}><View className="h-full rounded-full bg-accent" style={{ width: `${(done / total) * 100}%` }} /></View>
    </View>
  );
}

/**
 * Projects: every record of a type that holds work (Matters, Projects, Trips). One scope control (All spaces, Mine, a space); the type filter is a Filter menu and
 * shows as one applied chip. A wide screen gets a table (emblem and title with "Matter · Harlow Legal" under it, stage steps and name, owner, "2 of 4"); a phone gets
 * 72 high rows (emblem 44, title, "Matter · Engagement", the owner at the end, a 3 high progress bar), grouped by space only in All spaces.
 */
export function ProjectsList({ world, items, onOpen, onNew }: { world: World; items: Item[]; onOpen: (id: string) => void; onNew: (type: string) => void }) {
  const { phone } = useUiTheme();
  const [space, setSpace] = useState("all");
  const [type, setType] = useState("all");
  const work = workTypes(items);
  const shown = items.filter((i) => (space === "all" || i.row.labels?.source_spaces?.[0] === space) && (type === "all" || i.def.name === type));
  const ownerOf = (i: Item) => { const f = i.def.fields.find((x: any) => x.kind === "actor"); return f ? aid(i.row.data?.[f.name]?.actor) : ""; };
  const stageOf = (i: Item) => { const sf = stageFieldOf(i.def); const stages: string[] = sf ? stageNames(i.def, sf) : []; return { stages, at: sf ? stages.indexOf(String(i.row.data?.[sf.name] ?? "")) : -1 }; };
  const tasksOf = (i: Item) => taskFraction(world.tasks.filter((t) => t.record === i.row.urn));
  const spaceId = (i: Item): string | undefined => i.row.labels?.source_spaces?.[0];
  const emblem = (i: Item, size: 32 | 44, badge: boolean) => (
    <Avatar of={{ kind: "project", id: i.row.id, name: recordTitle(world, i.row), seed: i.row.data?.avatar_seed }} size={size} space={badge && spaceId(i) ? spaceRef(spaceName(world, spaceId(i)), spaceId(i)) : undefined} />
  );
  // The space badge and the space name only say something when the rows come from more than one space.
  const manySpaces = new Set(shown.map(spaceId).filter(Boolean)).size > 1;
  const showBadge = space === "all" && manySpaces;
  // A column that says the same thing or nothing on every row is left out.
  const showType = type === "all" && work.length > 1;
  const showOwner = shown.some((i) => !!ownerOf(i));
  const showTasks = shown.some((i) => tasksOf(i).total > 0);
  const tally = (() => { const c = new Map<string, number>(); for (const i of shown) { const s = stageOf(i); const n = s.at >= 0 ? s.stages[s.at] : ""; if (n) c.set(n, (c.get(n) ?? 0) + 1); } return [...c].map(([n, k]) => `${k} ${n}`).join(", "); })();
  const typeLabel = (i: Item) => i.def.label;

  const filter = (
    <Menu
      trigger={<IconButton icon="filter" label="Filter" kind="secondary" touch={phone} />}
      items={[{ label: "All types", selected: type === "all", onPress: () => setType("all") }, ...work.map((t) => ({ label: viewDefOf(t).plural, selected: type === t.name, onPress: () => setType(t.name) }))]}
    />
  );

  const table = (
    <Table<Item>
      rows={shown} rowKey={(i) => i.row.id} onRow={(i) => onOpen(i.row.id)} empty="Nothing here yet. A record of a type that holds work shows up here with its tasks and its team."
      columns={[
        { key: "name", label: "Name", sortValue: (i) => recordTitle(world, i.row), render: (i) => (
          <View className="flex-row items-center gap-s3">
            {emblem(i, 32, showBadge)}
            <View className="min-w-0 flex-1">
              <Text strong numberOfLines={1}>{recordTitle(world, i.row)}</Text>
              <Text size="secondary" tone="label" numberOfLines={1}>{[showType ? "" : typeLabel(i), manySpaces ? spaceName(world, spaceId(i)) : ""].filter(Boolean).join(" · ")}</Text>
            </View>
          </View>
        ) },
        ...(showType ? [{ key: "type", label: "Type", sortValue: (i: Item) => i.def.label, render: (i: Item) => i.def.label }] : []),
        { key: "stage", label: "Stage", sortValue: (i) => String(i.row.data?.stage ?? ""), render: (i) => { const s = stageOf(i); return <StageMini stages={s.stages} current={s.at} />; } },
        ...(showOwner ? [{ key: "owner", label: "Owner", sortValue: (i: Item) => who(world, ownerOf(i))?.name || "", render: (i: Item) => { const a = who(world, ownerOf(i)); return a ? <View className="flex-row items-center gap-s2"><ActorMark who={a} size="sm" /><Text size="secondary" tone="muted" numberOfLines={1}>{a.name}</Text></View> : <Text tone="faint">{"–"}</Text>; }}] : []),
        ...(showTasks ? [{ key: "tasks", label: "Tasks", sortValue: (i: Item) => tasksOf(i).total, render: (i: Item) => { const t = tasksOf(i); return <TaskBar done={t.done} total={t.total} />; }}] : []),
      ]}
    />
  );

  const phoneRow = (i: Item) => {
    const s = stageOf(i), t = tasksOf(i), a = who(world, ownerOf(i));
    const line = [typeLabel(i), s.at >= 0 ? s.stages[s.at] : ""].filter(Boolean).join(" · ");
    return (
      <Row
        className="py-s3"
        lead={emblem(i, 44, false)}
        title={recordTitle(world, i.row)}
        sub={<View className="gap-s2"><Text size="secondary" tone="label" numberOfLines={1}>{line}</Text>{t.total ? <View className="overflow-hidden rounded-full bg-edge-strong" style={{ width: 120, height: 3 }}><View className="h-full rounded-full bg-accent" style={{ width: `${(t.done / t.total) * 100}%` }} /></View> : null}</View>}
        end={a ? <ActorMark who={a} size={28} /> : undefined}
        onPress={() => onOpen(i.row.id)}
      />
    );
  };
  const groups = space === "all" ? [...new Set(shown.map(spaceId))].map((sid) => ({ sid, list: shown.filter((i) => spaceId(i) === sid) })) : [{ sid: undefined, list: shown }];
  const phoneList = (
    <View>
      {groups.map((g, gi) => (
        <View key={g.sid ?? "one"}>
          {space === "all" && g.sid ? (
            <View className={gi ? "flex-row items-center gap-s2 pt-s6" : "flex-row items-center gap-s2"}>
              <Avatar of={spaceRef(spaceName(world, g.sid), g.sid)} size={16} />
              <SectionLabel first>{spaceName(world, g.sid) || "Space"}</SectionLabel>
            </View>
          ) : null}
          <Card flush>
            <Stagger>{g.list.map((i, k) => <View key={i.row.id}>{k > 0 ? <Divider inset={68} /> : null}{phoneRow(i)}</View>)}</Stagger>
          </Card>
        </View>
      ))}
      {!shown.length ? <Card><EmptyState title="Nothing here yet" body="A record of a type that holds work shows up here with its tasks and its team." /></Card> : null}
    </View>
  );

  return (
    <View className="gap-s4">
      <View className="flex-row items-center gap-s2">
        <View className="min-w-0 flex-1"><Text size="page" strong>Projects</Text>{tally ? <Text size="caption" tone="label">{`${shown.length} ${shown.length === 1 ? "project" : "projects"}: ${tally}`}</Text> : null}</View>
        {filter}
        {phone ? null : <NewMenu items={items} onNew={onNew} />}
      </View>
      {world.spaces.length > 1 ? <Segmented fill={phone} label="Space" value={space} onChange={setSpace} options={[["all", "All spaces"], ...world.spaces.map((s: any) => [s.id, s.name] as [string, string])]} /> : null}
      {type !== "all" ? <View className="flex-row"><Chip icon="x" onPress={() => setType("all")}>{`Type: ${viewDefOf(work.find((t) => t.name === type) ?? work[0]).plural}`}</Chip></View> : null}
      {phone ? phoneList : table}
      {!items.length ? <EmptyState title="Nothing here yet" /> : null}
    </View>
  );
}
