import { useState } from "react";
import { View } from "react-native";
import { Button } from "./Button";
import { WINDOW, windowOf } from "../views/windowing.js";
import { Text } from "./Text";
import { Menu } from "./Menu";
import { IconButton } from "./Button";

export type BoardColumn = { id: string; title: string };
export type BoardProps<T> = { columns: BoardColumn[]; items: T[]; columnOf: (item: T) => string; keyOf: (item: T) => string; renderCard: (item: T) => React.ReactNode; onMove?: (item: T, to: string) => void; /** What a column wears beside its name (its count, a total); default is the count. */ note?: (columnId: string, items: T[]) => string; /** The quiet drop target of an empty column on the wide board, "Drop a deal here". */ emptyHint?: string };

/**
 * The board on a phone and on native: columns stack, and a card moves with its "Move to" menu (no drag on a touch screen without a library
 * that is not worth carrying). The web build is Board.web.tsx, which adds drag and drop; the props are the same.
 */
export function BoardStacked<T>({ columns, items, columnOf, keyOf, renderCard, onMove, note }: BoardProps<T>) {
  // each column draws its first cards and a "Show more" (windowing.js)
  const [limits, setLimits] = useState<Record<string, number>>({});
  return (
    <View className="gap-s4">
      {columns.map((c) => {
        const here = items.filter((i) => columnOf(i) === c.id);
        const win = windowOf(here, limits[c.id] ?? WINDOW);
        return (
          <View key={c.id} className="gap-s2">
            <View className="flex-row items-center gap-s2"><Text strong>{c.title}</Text><Text size="caption" tone="label">{note ? note(c.id, here) : here.length}</Text></View>
            {win.rows.map((i) => (
              <View key={keyOf(i)} className="flex-row items-start gap-s2">
                <View className="min-w-0 flex-1">{renderCard(i)}</View>
                {onMove ? <Menu trigger={<IconButton icon="more" label="Move to" />} items={columns.filter((o) => o.id !== c.id).map((o) => ({ label: `Move to ${o.title}`, onPress: () => onMove(i, o.id) }))} /> : null}
              </View>
            ))}
            {win.more ? <Button kind="ghost" size="sm" label={win.label} onPress={() => setLimits({ ...limits, [c.id]: (limits[c.id] ?? WINDOW) + WINDOW })} /> : null}
          </View>
        );
      })}
    </View>
  );
}
