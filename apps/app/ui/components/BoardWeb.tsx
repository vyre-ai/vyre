import { View } from "react-native";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { Text } from "./Text";
import { cn } from "../lib/cn";
import { useUiTheme } from "../theme";
import { BoardStacked as Stacked, type BoardProps } from "./BoardStacked";

function Column({ id, title, count, children }: { id: string; title: string; count: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <View className="min-w-0 flex-1 gap-s2">
      <View className="flex-row items-center gap-s2 px-s1"><Text strong>{title}</Text><Text size="caption" tone="label">{count}</Text></View>
      <div ref={setNodeRef} style={{ minHeight: "var(--row-h)", display: "flex", flexDirection: "column", gap: "var(--s-2)", borderRadius: "var(--r-card)", outline: isOver ? "2px dashed var(--accent)" : "none" }}>{children}</div>
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
  const { columns, items, columnOf, keyOf, renderCard, onMove } = props;
  const end = (e: DragEndEvent) => {
    const to = e.over?.id;
    const item = items.find((i) => keyOf(i) === e.active.id);
    if (item && to && String(to) !== columnOf(item)) onMove?.(item, String(to));
  };
  return (
    <DndContext sensors={sensors} onDragEnd={end}>
      <View className={cn("flex-row items-start gap-s3")}>
        {columns.map((c) => {
          const here = items.filter((i) => columnOf(i) === c.id);
          return <Column key={c.id} id={c.id} title={c.title} count={here.length}>{here.map((i) => <Draggable key={keyOf(i)} id={keyOf(i)}>{renderCard(i)}</Draggable>)}</Column>;
        })}
      </View>
    </DndContext>
  );
}
