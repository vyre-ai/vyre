import { View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { Row } from "./Row";
import { EmptyState } from "./States";
import { Appear } from "../motion/Appear";

export type Column<T> = { key: string; label: string; render?: (row: T) => React.ReactNode; align?: "left" | "right"; sortValue?: (row: T) => string | number };
export type TableProps<T> = { columns: Column<T>[]; rows: T[]; onRow?: (row: T) => void; empty?: string; rowKey: (row: T) => string };

/** A column's cell for a row: its render, or the plain value under its key. Called as a function (never mounted), so it may not use hooks. */
export function cellValue<T>(c: Column<T>, row: T): React.ReactNode {
  return c.render ? c.render(row) : String((row as any)[c.key] ?? "");
}

/** A string or a number becomes a Text; a node stays as it is. */
export function asNode(n: React.ReactNode, first = false) {
  return typeof n === "string" || typeof n === "number" ? <Text strong={first} tone={first ? "default" : "muted"} numberOfLines={1}>{String(n)}</Text> : n;
}

/** The empty card shared by both tables. */
export function EmptyTable({ text }: { text?: string }) {
  return <View className="rounded-card border border-edge bg-surface-2"><EmptyState title={text ?? "Nothing here yet."} /></View>;
}

/**
 * The list the phone gets (and every native screen): one Row per record, the first column as the title and the others wrapped under it. Rows come in
 * with a short stagger (the first eight), so a list that just loaded settles instead of appearing whole.
 */
export function RowsTable<T>({ columns, rows, onRow, empty, rowKey }: TableProps<T>) {
  if (!rows.length) return <EmptyTable text={empty} />;
  return (
    <View className="overflow-hidden rounded-card border border-edge bg-surface-2">
      {rows.map((r, i) => (
        <Appear key={rowKey(r)} index={i}>
          <View className={cn(i > 0 && "border-t border-edge")}>
            <Row
              onPress={onRow ? () => onRow(r) : undefined}
              title={asNode(cellValue(columns[0], r), true)}
              sub={<View className="flex-row flex-wrap gap-x-s3 gap-y-s1">{columns.slice(1).map((c) => (
                <View key={c.key} className="flex-row items-center gap-s1"><Text size="caption" tone="label">{c.label}</Text><View>{asNode(cellValue(c, r))}</View></View>
              ))}</View>}
            />
          </View>
        </Appear>
      ))}
    </View>
  );
}
