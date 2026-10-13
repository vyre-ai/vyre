import { useEffect, useRef } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { AvatarStack, Button, Card, Chip, Menu, IconButton, Text } from "@vyre/ui";
import type { Body } from "./model";
import * as E from "./edit";
import { boardColumns, stageProgress, type Card as TaskCard, type Person } from "./board";
import { usePhone } from "../places/Page";

type Who = { id: string; name: string };

const web = Platform.OS === "web";

/**
 * A box that can be picked up and dropped on, on the web (the move buttons stay for the keyboard and a phone). `what` makes it draggable and says what it carries ("task:1:0", "stage:2"); `onDrop` makes it a
 * place to drop on, and gets what was dropped. React Native for web does not pass the drag events through to the element, so they are put on it directly.
 */
function DragBox({ what, onDrop, className, style, children }: { what?: string; onDrop?: (what: string) => void; className?: string; style?: object; children: React.ReactNode }) {
  const ref = useRef<View>(null);
  useEffect(() => {
    const el = web ? (ref.current as unknown as HTMLElement | null) : null;
    if (!el) return;
    const start = (e: DragEvent) => { e.stopPropagation(); e.dataTransfer?.setData("text/plain", what || ""); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); onDrop?.(e.dataTransfer?.getData("text/plain") || ""); };
    if (what) { el.draggable = true; el.addEventListener("dragstart", start); }
    if (onDrop) { el.addEventListener("dragover", over); el.addEventListener("drop", drop); }
    return () => { el.removeEventListener("dragstart", start); el.removeEventListener("dragover", over); el.removeEventListener("drop", drop); };
  }, [what, onDrop]);
  return <View ref={ref} className={className} style={style}>{children}</View>;
}

const markOf = (p: Person, i: number) => ({ kind: p.kind === "agent" ? "agent" : "person", id: `${p.kind}-${p.label}-${i}`, name: p.label } as const);

/** Who is on a task, as small faces with a word for the assignee. */
function People({ c }: { c: TaskCard }) {
  const others = [...(c.approver ? [c.approver] : []), ...c.followers];
  return (
    <View className="flex-row items-center gap-s2">
      <AvatarStack of={[markOf(c.assignee, 0)]} size={20} />
      <Text size="caption" tone="muted" numberOfLines={1}>{c.assignee.label}</Text>
      {others.length ? <View className="ml-auto flex-row items-center gap-s1"><Text size="caption" tone="label">{c.approver ? "Approver" : "Follows"}</Text><AvatarStack of={others.map(markOf)} size={20} max={3} /></View> : null}
    </View>
  );
}

function TaskCardView({ c, selected, onOpen }: { c: TaskCard; selected: boolean; onOpen: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${c.title}, open its settings`} onPress={onOpen}>
      <Card><View className={`gap-s2 p-s3 ${selected ? "rounded-card border border-accent" : ""}`}>
        <Text strong>{c.title || "Untitled task"}</Text>
        <People c={c} />
        {c.due || c.needsYes || c.optional || c.group ? (
          <View className="flex-row flex-wrap gap-s1">
            {c.group ? <Chip>{c.group}</Chip> : null}
            {c.due ? <Chip icon="clock">{`Due ${c.due}`}</Chip> : null}
            {c.needsYes ? <Chip tone="warn">Needs a yes</Chip> : null}
            {c.optional ? <Chip>Optional</Chip> : null}
          </View>
        ) : null}
      </View></Card>
    </Pressable>
  );
}

/**
 * The pipeline: a column per stage with its rule on top and its tasks as cards, a "+" at the end of each column and one for a new stage. A card opens the task's settings (onOpen). On a phone the stages stack.
 * Everything changes the working copy through edit.ts; nothing here talks to the box.
 */
export function Board({ body, onChange, selected, onOpen, people, agents, editable }: { body: Body; onChange: (b: Body) => void; selected: { si: number; ti: number } | null; onOpen: (si: number, ti: number) => void; people: Who[]; agents: Who[]; editable: boolean }) {
  const phone = usePhone();
  const cols = boardColumns(body, people, agents);
  const none = E.stageModeOf(body) === "none";
  const parse = (w: string): { kind: string; a: number; b: number } | null => { const m = /^(task|stage):(\d+)(?::(\d+))?$/.exec(w); return m ? { kind: m[1], a: Number(m[2]), b: Number(m[3] ?? 0) } : null; };
  // dropped on a card: a task goes before it; a stage is not moved by a card
  const dropTask = (w: string, si: number, ti: number) => { const d = parse(w); if (d?.kind === "task") onChange(E.moveTaskTo(body, { si: d.a, ti: d.b }, { si, ti })); };
  // dropped on a column: a task goes to its end; a stage takes this column's place
  const dropColumn = (w: string, si: number, end: number) => { const d = parse(w); if (!d) return; onChange(d.kind === "task" ? E.moveTaskTo(body, { si: d.a, ti: d.b }, { si, ti: end }) : E.moveStageTo(body, d.a, si)); };
  const column = (col: (typeof cols)[number]) => (
    <DragBox key={col.index} className="gap-s2" style={phone ? undefined : { width: 288 }} onDrop={editable ? (w) => dropColumn(w, col.index, col.tasks.length) : undefined}>
      <DragBox className="flex-row items-center gap-s2" what={editable && !none ? `stage:${col.index}` : undefined}>
        <View className="min-w-0 flex-1">
          <View className="flex-row flex-wrap items-center gap-s2"><Text strong numberOfLines={1}>{col.name}</Text>{none ? null : <Chip>{stageProgress(col.index, cols.length)}</Chip>}</View>
          {col.rule ? <Text size="caption" tone="label" numberOfLines={2}>{col.rule}</Text> : null}
        </View>
        {editable && !none ? (
          <Menu trigger={<IconButton icon="more" label={`${col.name}, more`} />} items={[
            ...(col.index > 0 ? [{ label: "Move left", onPress: () => onChange(E.moveStage(body, col.index, -1)) }] : []),
            ...(!col.last ? [{ label: "Move right", onPress: () => onChange(E.moveStage(body, col.index, 1)) }] : []),
            ...(body.stages.length > 2 ? [{ label: "Remove this stage", onPress: () => onChange(E.removeStage(body, col.index)) }] : []),
          ]} />
        ) : null}
      </DragBox>
      {col.tasks.map((c) => (
        <DragBox key={c.index} what={editable ? `task:${col.index}:${c.index}` : undefined} onDrop={editable ? (w) => dropTask(w, col.index, c.index) : undefined}>
          <TaskCardView c={c} selected={selected?.si === col.index && selected?.ti === c.index} onOpen={() => onOpen(col.index, c.index)} />
        </DragBox>
      ))}
      {editable ? <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label="Add a task" onPress={() => { const next = E.addTask(body, col.index); onChange(next); onOpen(col.index, (next.stages[col.index].tasks || []).length - 1); }} /></View> : null}
    </DragBox>
  );
  const add = editable && !none ? <View key="add" className="flex-row"><Button kind="ghost" size="sm" icon="plus" label="Add a stage" onPress={() => onChange(E.addStage(body))} /></View> : null;
  if (phone) return <View className="gap-s5">{cols.map(column)}{add}</View>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="flex-row items-start gap-s4 pb-s3">{cols.map(column)}{add}</View>
    </ScrollView>
  );
}
