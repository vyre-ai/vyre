import { View } from "react-native";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { Text } from "./Text";
import { cn } from "../lib/cn";
import { useUiTheme } from "../theme";
import { BoardStacked as Stacked, type BoardProps } from "./BoardStacked";

function Column({ id, title, note, hint, children }: { id: string; title: string; note: string; hint?: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const empty = !Array.isArray(children) || children.length === 0;
  return (
    <View className="min-w-0 flex-1 gap-s3">
      <View className="flex-row items-baseline justify-between gap-s2 px-s1"><Text strong tone="muted" numberOfLines={1} className="min-w-0 flex-shrink">{title}</Text><Text size="caption" tone="label">{note}</Text></View>
      <div ref={setNodeRef} style={{ minHeight: "calc(var(--row-h) * 2)", display: "flex", flexDirection: "column", gap: "var(--s-3)", borderRadius: "var(--r-card)", paddingBottom: "var(--s-6)", outline: isOver ? "2px dashed var(--accent)" : "none" }}>
        {children}
        {empty && hint ? <div style={{ minHeight: "var(--row-h)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--r-card)", border: "1px dashed var(--edge)", opacity: isOver ? 1 : 0.7 }}><Text size="caption" tone="label">{hint}</Text></div> : null}
      </div>
    </View>
  );
}

function Draggable({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, opacity: isDragging ? 0.85 : 1, cursor: "grab", touchAction: "none" }}>{children}</div>
  );
}

/** The wide-screen board (web): columns side by side, cards drag between them with @dnd-kit. A narrow screen gets the stacked board. */
export function Board<T>(props: BoardProps<T>) {
  const { phone } = useUiTheme();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  if (phone) return <Stacked {...props} />;
  const { columns, items, columnOf, keyOf, renderCard, onMove, note, emptyHint } = props;
  const end = (e: DragEndEvent) => {
    const to = e.over?.id;
    const item = items.find((i) => keyOf(i) === e.active.id);
    if (item && to && String(to) !== columnOf(item)) onMove?.(item, String(to));
  };
  return (
    <DndContext sensors={sensors} onDragEnd={end}>
      <View className={cn("flex-row items-start gap-s6")}>
        {columns.map((c) => {
          const here = items.filter((i) => columnOf(i) === c.id);
          return <Column key={c.id} id={c.id} title={c.title} note={note ? note(c.id, here) : String(here.length)} hint={emptyHint}>{here.map((i) => <Draggable key={keyOf(i)} id={keyOf(i)}>{renderCard(i)}</Draggable>)}</Column>;
        })}
      </View>
    </DndContext>
  );
}
