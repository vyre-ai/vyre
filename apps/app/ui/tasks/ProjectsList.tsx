import { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { aid, stageFieldOf, stageNames } from "../../src/store-core/kernel-view.js";
import { newMenuItems, templateNoun, templateStage } from "./template-stage.js";
import { viewDefOf } from "../../src/store-core/view-defs.js";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/States";
import { Fab } from "../components/Fab";
import { IconButton } from "../components/Button";
import { Menu } from "../components/Menu";
import { Icon, ICON_NAMES, type IconName } from "../components/Icon";
import { Segmented } from "../components/Segmented";
import { Text } from "../components/Text";
import { ActorMark } from "./ActorMark";
import { recordTitle, spaceName, taskFraction, who, type World } from "./model";
import { useUiTheme } from "../theme";
import { SpaceTag } from "../components/SpaceTag";

type Item = { def: any; row: any };

const TABULAR = { fontVariant: ["tabular-nums" as const] };
const workTypes = (items: Item[]) => [...new Map(items.map((i) => [i.def.name, i.def])).values()];

/**
 * The New menu: a plus icon button on a wide screen, the floating 56 button on a phone. A choice per type that holds work ("New trip"). `choices` are the ways a project is started, each a template
 * by what it calls its projects ("New matter") and last the blank one ("New blank project"); when given they stand in for the plain Project type, and `onChoose` gets the choice's key (a template id, or null for blank).
 */
export function NewMenu({ items, onNew, floating, choices, onChoose }: { items: Item[]; onNew: (type: string) => void; floating?: boolean; choices?: { label: string; key: string | null }[]; onChoose?: (key: string | null) => void }) {
  const menu = newMenuItems(workTypes(items), choices).map((m) => ({ label: m.label, onPress: () => (m.type ? onNew(m.type) : onChoose?.(m.key ?? null)) }));
  if (!menu.length) return null;
  return <Menu trigger={floating ? <Fab label="New" /> : <IconButton icon="plus" label="New" kind="secondary" />} items={menu} />;
}

/** "2/4" and a slim bar, both a fixed width so the column lines up; an en dash when a record has no tasks. */
function TaskBar({ done, total }: { done: number; total: number }) {
  if (!total) return <Text tone="faint">{"–"}</Text>;
  return (
    <View className="flex-row items-center gap-s2" style={{ width: 92 }} accessible accessibilityLabel={`${done} of ${total} tasks done`}>
      <Text size="secondary" tone="muted" style={[TABULAR, { width: 30 }]}>{`${done}/${total}`}</Text>
      <View className="overflow-hidden rounded-full bg-edge-strong" style={{ width: 48, height: 3 }}><View className="h-full rounded-full bg-primary" style={{ width: `${(done / total) * 100}%` }} /></View>
    </View>
  );
}

const TINTS = ["accent-wash", "ok-wash", "warn-wash"] as const;
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
/** A calm tile: a soft tint (stable per project) with the playbook's icon, never a pattern. */
function ProjectTile({ id, icon, size }: { id: string; icon?: string; size: number }) {
  const { color } = useUiTheme();
  const name = (icon && (ICON_NAMES as readonly string[]).includes(icon) ? icon : "projects") as IconName;
  return <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), backgroundColor: color[TINTS[hash(id) % TINTS.length]], alignItems: "center", justifyContent: "center" }}><Icon name={name} size={size >= 44 ? 20 : 16} tone="text-2" /></View>;
}

/** The first name of an owner, whole: never cut with dots. */
const firstName = (n: string) => String(n || "").trim().split(/\s+/)[0] || "";

/**
 * Projects, calm: a header (count, search with "/", Filter, New), the playbook chip when the list is narrowed to one, and one row per project: a tint tile with the playbook's icon, the name with
 * "Matter · Juniper Studio" under it, a neutral stage pill ("Stage 2 of 5", violet only when something needs you), tasks "2/4" on one line, the owner's face and first name, and a "..." menu (Open,
 * Rename, Archive). The whole row opens; Up and Down move through the rows and Enter opens one. On a phone each project is a card.
 */
export function ProjectsList({ world, items, onOpen, onNew, tagOf, choices, onChoose, playbook, playbookName: playbookLabel, onClearPlaybook, onRename, onArchive }: {
  world: World; items: Item[]; onOpen: (id: string) => void; onNew: (type: string) => void; /** The small tag that says where a project lives, from its source space (placeTag). */ tagOf?: (spaceId?: string) => string | null;
  choices?: { label: string; key: string | null }[]; onChoose?: (key: string | null) => void;
  /** Narrow the list to one playbook (a template id), as "Playbook: <name>" with a way off. */ playbook?: string | null; /** Its name, from the playbook list; the rows are narrowed by the screen (ofPlaybook) before they get here. */ playbookName?: string; onClearPlaybook?: () => void;
  /** Row menu actions on a project's record. */ onRename?: (row: any) => void; onArchive?: (row: any) => void;
}) {
  const { phone, color } = useUiTheme();
  const [space, setSpace] = useState("all");
  const [type, setType] = useState("all");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(-1);
  const search = useRef<TextInput>(null);
  const work = workTypes(items);
  const word = q.trim().toLowerCase();
  const shown = items.filter((i) => (space === "all" || i.row.labels?.source_spaces?.[0] === space) && (type === "all" || i.def.name === type) && (!word || recordTitle(world, i.row).toLowerCase().includes(word)));
  const ownerOf = (i: Item) => { const f = i.def.fields.find((x: any) => x.kind === "actor"); return f ? aid(i.row.data?.[f.name]?.actor) : ""; };
  const stageOf = (i: Item) => { const pinned = templateStage(i.row.data); if (pinned) return pinned; const sf = stageFieldOf(i.def); const stages: string[] = sf ? stageNames(i.def, sf) : []; return { stages, at: sf ? stages.indexOf(String(i.row.data?.[sf.name] ?? "")) : -1 }; };
  const tasksOf = (i: Item) => taskFraction(world.tasks.filter((t) => t.record === i.row.urn));
  const spaceId = (i: Item): string | undefined => i.row.labels?.source_spaces?.[0];
  const manySpaces = new Set(shown.map(spaceId).filter(Boolean)).size > 1;
  const typeLabel = (i: Item) => (i.def.name === "project" ? templateNoun(i.row.data) : null) || i.def.label;
  const snapshotIcon = (i: Item): string | undefined => { try { return JSON.parse(String(i.row.data?.template_snapshot ?? "{}")).icon; } catch { return undefined; } };
  const playbookName = playbook ? playbookLabel || templateNoun(items.find((i) => i.row.data?.template === playbook)?.row.data) || playbook : "";
  const sub = (i: Item) => [typeLabel(i), manySpaces || !tagOf ? spaceName(world, spaceId(i)) : ""].filter(Boolean).join(" · ");
  // "/" focuses the search; Up, Down and Enter walk the rows (the search box and the page both listen).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const on = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); search.current?.focus(); }
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);
  useEffect(() => setActive(-1), [word, space, type, playbook]);
  const keys = (e: any) => {
    const ev = e.nativeEvent;
    if (ev.key === "ArrowDown" && shown.length) { e.preventDefault?.(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (ev.key === "ArrowUp" && shown.length) { e.preventDefault?.(); setActive((a) => Math.max(0, a - 1)); }
    else if (ev.key === "Enter" && active >= 0 && shown[active]) { e.preventDefault?.(); onOpen(shown[active].row.id); }
    else if (ev.key === "Escape") { if (q) { e.preventDefault?.(); setQ(""); } }
  };

  const filter = (
    <Menu
      trigger={<IconButton icon="filter" label="Filter" kind="secondary" touch={phone} />}
      items={[{ label: "All types", selected: type === "all", onPress: () => setType("all") }, ...work.map((t) => ({ label: viewDefOf(t).plural, selected: type === t.name, onPress: () => setType(t.name) }))]}
    />
  );
  const rowMenu = (i: Item) => (
    <Menu
      trigger={<IconButton icon="more" label={`More for ${recordTitle(world, i.row)}`} touch={phone} />}
      items={[{ label: "Open", onPress: () => onOpen(i.row.id) }, ...(onRename ? [{ label: "Rename", onPress: () => onRename(i.row) }] : []), ...(onArchive ? [{ label: "Archive", onPress: () => onArchive(i.row) }] : [])]}
    />
  );
  const stagePill = (i: Item, needsYou = false) => { const s = stageOf(i); if (s.at < 0 || !s.stages.length) return <Text tone="faint">{"–"}</Text>; return <StatusPill at={s.at + 1} of={s.stages.length} needsYou={needsYou} />; };
  const ownerCell = (i: Item) => { const a = who(world, ownerOf(i)); return a ? <View className="flex-row items-center gap-s2"><ActorMark who={a} size="sm" /><Text size="secondary" tone="muted">{firstName(a.name)}</Text></View> : null; };

  const wideRow = (i: Item, k: number) => {
    const t = tasksOf(i);
    return (
      <View key={i.row.id}>
        {k > 0 ? <Divider /> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={`${recordTitle(world, i.row)}, ${sub(i)}`} onPress={() => onOpen(i.row.id)} onHoverIn={() => setActive(k)}
          style={{ flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16, minHeight: 64, backgroundColor: active === k ? color.hover : "transparent" }}>
          <ProjectTile id={i.row.id} icon={snapshotIcon(i)} size={36} />
          <View className="min-w-0 flex-1"><Text strong numberOfLines={1}>{recordTitle(world, i.row)}</Text><Text size="secondary" tone="label" numberOfLines={1}>{sub(i)}</Text></View>
          {tagOf && tagOf(spaceId(i)) ? <SpaceTag text={tagOf(spaceId(i)) as string} /> : null}
          <View style={{ width: 120 }}>{stagePill(i)}</View>
          <View style={{ width: 92 }}><TaskBar done={t.done} total={t.total} /></View>
          <View style={{ width: 120 }}>{ownerCell(i)}</View>
          {rowMenu(i)}
        </Pressable>
      </View>
    );
  };
  const phoneRow = (i: Item, k: number) => {
    const t = tasksOf(i);
    return (
      <View key={i.row.id}>
        {k > 0 ? <Divider inset={68} /> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={`${recordTitle(world, i.row)}, ${sub(i)}`} onPress={() => onOpen(i.row.id)} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, minHeight: 72 }}>
          <ProjectTile id={i.row.id} icon={snapshotIcon(i)} size={44} />
          <View className="min-w-0 flex-1 gap-s1">
            <Text strong numberOfLines={1}>{recordTitle(world, i.row)}</Text>
            <Text size="secondary" tone="label" numberOfLines={1}>{sub(i)}</Text>
            <View className="flex-row flex-wrap items-center gap-s2">{stagePill(i)}{t.total ? <TaskBar done={t.done} total={t.total} /> : null}{ownerCell(i)}</View>
          </View>
          {rowMenu(i)}
        </Pressable>
      </View>
    );
  };

  return (
    <View className="gap-s4">
      <View className="flex-row items-center gap-s2">
        <View className="min-w-0 flex-1"><Text size="page" strong>Projects</Text><Text size="caption" tone="label">{`${shown.length} ${shown.length === 1 ? "project" : "projects"}`}</Text></View>
        {phone ? null : (
          <TextInput ref={search} value={q} onChangeText={setQ} onKeyPress={keys} placeholder="Search  /" placeholderTextColor={color.label} accessibilityLabel="Search projects"
            style={{ width: 200, minHeight: 36, borderWidth: 1, borderColor: color.edge, borderRadius: 10, paddingHorizontal: 10, color: color.text, fontSize: 14, outlineStyle: "none" } as any} />
        )}
        {filter}
        {phone ? null : <NewMenu items={items} onNew={onNew} choices={choices} onChoose={onChoose} />}
      </View>
      {phone ? <TextInput value={q} onChangeText={setQ} placeholder="Search projects" placeholderTextColor={color.label} accessibilityLabel="Search projects" style={{ minHeight: 44, borderWidth: 1, borderColor: color.edge, borderRadius: 12, paddingHorizontal: 12, color: color.text, fontSize: 16, outlineStyle: "none" } as any} /> : null}
      {world.spaces.length > 1 ? <Segmented fill={phone} label="Space" value={space} onChange={setSpace} options={[["all", "All spaces"], ...world.spaces.map((s: any) => [s.id, s.name] as [string, string])]} /> : null}
      <View className="flex-row flex-wrap gap-s2">
        {type !== "all" ? <Chip icon="x" onPress={() => setType("all")}>{`Type: ${viewDefOf(work.find((t) => t.name === type) ?? work[0]).plural}`}</Chip> : null}
        {playbook ? <Chip icon="x" onPress={() => onClearPlaybook?.()}>{`Playbook: ${playbookName}`}</Chip> : null}
      </View>
      {shown.length ? <Card flush>{shown.map((i, k) => (phone ? phoneRow(i, k) : wideRow(i, k)))}</Card> : <Card><EmptyState title="Nothing here yet" body="A record of a type that holds work shows up here with its tasks and its team." /></Card>}
      {phone && !items.length ? <EmptyState title="Nothing here yet" /> : null}
    </View>
  );
}
