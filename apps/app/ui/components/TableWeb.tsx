import { Pressable, ScrollView, View } from "react-native";
import { getCoreRowModel, getSortedRowModel, useReactTable, type Cell, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { useState } from "react";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { Checkbox } from "./Checkbox";
import { useUiTheme } from "../theme";
// The shared pieces live in TableRows.tsx: a platform file must not import its own name ("./Table" from Table.web.tsx would resolve to itself).
import { RowsTable, EmptyTable, asNode, type Column, type TableProps } from "./TableRows";

export type { Column, TableProps };

/**
 * The web Table: dense rows with a header on a wide screen (TanStack Table does the model: sorting, column order); on a phone width the same data is
 * Rows (RowsTable). Only this file imports the table library.
 */
export function Table<T>(p: TableProps<T>) {
  const { phone } = useUiTheme();
  return phone ? <RowsTable {...p} /> : <WideTable {...p} />;
}

function WideTable<T>({ columns, rows, onRow, empty, rowKey, headerEnd, density, freezeFirst, selection }: TableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const defs: ColumnDef<T>[] = columns.map((c) => ({
    id: c.key,
    header: c.label,
    accessorFn: (r) => (c.sortValue ? c.sortValue(r) : String((r as any)[c.key] ?? "")),
    cell: (ctx) => (c.render ? c.render(ctx.row.original) : String(ctx.getValue() ?? "")),
  }));
  const table = useReactTable({ data: rows, columns: defs, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  if (!rows.length) return <EmptyTable text={empty} />;
  const model = table.getRowModel().rows;
  // Name takes the remaining width; the other columns size to their content (the longest header or cell text, in characters), the same on every row so they line up.
  const sizeOf = (i: number) => {
    if (i === 0) return freezeFirst ? { flexGrow: 0, flexShrink: 0, width: FIRST_W, position: "sticky" as any, left: 16 + (selection ? TICK_W : 0), zIndex: 1 } : { flex: 1, minWidth: 140 };
    const longest = Math.max(columns[i].label.length, ...model.map((r) => String(r.getVisibleCells()[i]?.getValue() ?? "").length));
    return { flexGrow: 0, flexShrink: 0, width: Math.min(240, Math.max(72, longest * 8 + 8)) };
  };
  // With the first column held in place the table is as wide as its columns and scrolls sideways under it.
  const wide = freezeFirst ? FIRST_W + columns.slice(1).reduce((a, _c, i) => a + ((sizeOf(i + 1) as any).width ?? 0), 0) + (headerEnd ? 32 : 0) + (selection ? TICK_W : 0) + (columns.length + 1) * 16 + 32 : undefined;
  const frame = (inner: React.ReactNode) => (freezeFirst ? <ScrollView horizontal showsHorizontalScrollIndicator><View style={{ minWidth: wide }}>{inner}</View></ScrollView> : inner);
  const compact = density === "compact";
  return (
    <View accessibilityRole={"table" as any} className="overflow-hidden rounded-card border border-edge bg-surface-2">
      {frame(<>
      <View className="min-h-control-sm flex-row items-center gap-s3 border-b border-edge px-s4">
        {selection ? <View style={tickStyle} className="bg-surface-2"><Checkbox on={selection.all} some={selection.some} onChange={() => selection.toggleAll()} label="Select all" /></View> : null}
        {table.getHeaderGroups()[0].headers.map((h, i) => {
          const dir = h.column.getIsSorted();
          return (
            <Pressable key={h.id} onPress={() => h.column.toggleSorting(dir === "asc")} style={sizeOf(i)} className={cn("min-w-0 flex-row items-center gap-s1 py-s2", i === 0 && freezeFirst && "bg-surface-2")} accessibilityRole="button" accessibilityLabel={`Sort by ${columns[i].label}`}>
              <Text size="caption" strong tone="label" className={columns[i].align === "right" ? "text-right" : ""}>{columns[i].label}</Text>
              {dir ? <Icon name={dir === "asc" ? "chevron-up" : "chevron-down"} size={12} tone="label" /> : null}
            </Pressable>
          );
        })}
        {headerEnd ? <View style={{ flexGrow: 0, flexShrink: 0, width: 32 }} className="items-center">{headerEnd}</View> : null}
      </View>
      {model.map((r, ri) => {
        const key = rowKey(r.original);
        const body = r.getVisibleCells().map((c, i) => (
          <View key={c.id} style={sizeOf(i)} className={cn("min-w-0", i === 0 && freezeFirst && "bg-surface-2")}>{asNode(cellOf(c), i === 0)}</View>
        ));
        if (selection) body.unshift(<View key="_tick" style={tickStyle} className="bg-surface-2"><Checkbox on={selection.has(key)} onChange={() => selection.toggle(key)} label="Select row" /></View>);
        if (headerEnd) body.push(<View key="_end" style={{ flexGrow: 0, flexShrink: 0, width: 32 }} />);
        const cls = cn(compact ? "min-h-control-sm" : "min-h-touch", "flex-row items-center gap-s3 px-s4", compact ? "py-0" : "py-s1", ri > 0 && "border-t border-edge");
        return onRow ? (
          <Pressable key={rowKey(r.original)} accessibilityRole="button" onPress={() => onRow(r.original)} className={cls} style={({ pressed, hovered }: any) => (pressed ? { backgroundColor: "var(--press)" } : hovered ? { backgroundColor: "var(--hover)" } : undefined)}>{body}</Pressable>
        ) : <View key={rowKey(r.original)} className={cls}>{body}</View>;
      })}
      </>)}
    </View>
  );
}

const FIRST_W = 220;
const TICK_W = 30;
const tickStyle = { width: 18, flexGrow: 0, flexShrink: 0, position: "sticky" as any, left: 16, zIndex: 2 };

// The cell functions are called, not mounted as components (flexRender would): they return a value or a node, never use hooks.
function cellOf(c: Cell<any, unknown>): React.ReactNode {
  return (c.column.columnDef.cell as (ctx: unknown) => React.ReactNode)(c.getContext());
}
