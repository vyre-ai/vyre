// The table block's typed form: columns with field kinds and cells typed by them (apps/app/ui/views/records-table.js builds the content from a type's records). Each cell is drawn by the field
// registry's own renderer, so a money, a stage, a person, a link or a sealed value reads here exactly as it does everywhere else, and a sealed cell is only a mask: it has no value to draw.
// Sorting, the filter and sort menus, the filter chips and the phone's rows are the records list's, kept as they were.
import { useMemo, useState } from "react";
import { View } from "react-native";
import { Avatar } from "../components/Avatar";
import { IconButton } from "../components/Button";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Menu, type MenuItem } from "../components/Menu";
import { Row } from "../components/Row";
import { EmptyState } from "../components/States";
import { Table, type Column } from "../components/Table";
import { Text } from "../components/Text";
import { fmtMoney, toDate } from "../fields/logic.js";
import { renderField } from "../fields/registry";
import { Stagger } from "../motion/Appear";
import { useUiTheme } from "../theme";
import { orderRows } from "../views/records-table.js";
import type { Block, Handlers } from "./types";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (v: any) => { const d = toDate(v); return d ? `${d.getDate()} ${MON[d.getMonth()]}` : ""; };
const TABULAR = { fontVariant: ["tabular-nums" as const] };

type Col = { id: string; title: string; sortLabel?: string; kind: string; role: string; sort?: boolean; filter?: boolean; options?: string[]; initials?: boolean; endDate?: boolean; f?: any };

/** One cell, drawn by its kind. Text and numbers are plain; `title` has its tile of initials for a person-like type; `sealed` is the mask and nothing else. */
export function TypedCell({ col, cell, openLink }: { col: Col; cell: any; openLink?: (urn: string) => void }) {
  if (cell === null || cell === undefined) return <Text tone="faint">–</Text>;
  if (typeof cell !== "object") return <Text>{String(cell)}</Text>;
  if (cell.k === "title") {
    return (
      <View className="min-w-0 flex-row items-center gap-s2">
        {cell.initials ? <Avatar of={{ kind: "person", id: String(cell.id ?? cell.v), name: String(cell.v) }} size={24} /> : null}
        <Text strong numberOfLines={1} className="min-w-0 flex-shrink">{String(cell.v)}</Text>
      </View>
    );
  }
  if (cell.k === "sealed") return cell.on ? <Chip tone="sealed" icon="vault">{`${col.title} on file, sealed`}</Chip> : <Text tone="faint">Empty</Text>;
  const urn = cell.k === "link" || cell.k === "ref" ? String(cell.v ?? "") : "";
  const env = { links: urn && cell.link ? { [urn]: cell.link } : {}, actors: cell.who ? [cell.who] : [], ...(openLink ? { open: openLink } : {}) };
  return renderField({ kind: cell.k, definition: { name: col.id, label: col.title, kind: cell.k, ...(col.f || {}) } as any, value: cell.v, mode: "compact", read_only: true }, env);
}

export function TypedTable({ k, b, h }: { k: string; b: Block; h: Handlers }) {
  const { phone } = useUiTheme();
  const cols = (b.content?.columns ?? []) as Col[];
  const all = (b.content?.rows ?? []) as any[];
  const [sort, setSort] = useState<string>(b.props?.sort ?? "_title");
  const [desc, setDesc] = useState(Boolean(b.props?.desc));
  const [filters, setFilters] = useState<Record<string, Set<string>>>({});
  const title = cols.find((c) => c.role === "title");
  const shownCols = cols.filter((c) => c.role !== "endDate" && c.role !== "sortOnly");
  const sortable = cols.filter((c) => c.sort);
  const chipCols = cols.filter((c) => c.filter);
  const shown = useMemo(() => orderRows(all, { sort, desc, filters }), [all, filters, sort, desc]);
  const flip = (name: string, opt: string) => {
    const next = new Set(filters[name] || []);
    if (next.has(opt)) next.delete(opt); else next.add(opt);
    setFilters({ ...filters, [name]: next });
  };
  const applied = chipCols.flatMap((c) => [...(filters[c.id] ?? [])].map((o) => ({ c, o })));
  const filterItems: MenuItem[] = chipCols.flatMap((c) => (c.options ?? []).map((o) => ({ label: `${c.title}: ${o}`, selected: !!filters[c.id]?.has(o), onPress: () => flip(c.id, o) })));
  const sortItems: MenuItem[] = [
    ...sortable.map((c) => ({ label: `Sort by ${c.sortLabel ?? c.title}`, selected: c.id === sort, onPress: () => setSort(c.id) })),
    { label: desc ? "Order: high to low" : "Order: low to high", onPress: () => setDesc(!desc) },
  ];
  const controls = b.props?.controls ? (
    <View className="flex-row items-center gap-s2">
      <View className="min-w-0 flex-1 flex-row">{h.slot?.(k, "lead")}</View>
      {filterItems.length ? <Menu trigger={<IconButton icon="filter" label="Filter" kind="secondary" touch={phone} />} items={filterItems} /> : null}
      <Menu trigger={<IconButton icon="sort" label="Sort" kind="secondary" touch={phone} />} items={sortItems} />
    </View>
  ) : null;
  const chips = applied.length ? (
    <View className="flex-row flex-wrap items-center gap-s2">
      {applied.slice(0, 2).map(({ c, o }) => <Chip key={c.id + o} icon="x" onPress={() => flip(c.id, o)}>{`${c.title}: ${o}`}</Chip>)}
      {applied.length > 2 ? <Text size="caption" tone="label">{`+${applied.length - 2}`}</Text> : null}
    </View>
  ) : null;

  const lineCols = cols.filter((c) => c.role === "line");
  const end = cols.find((c) => c.role === "end");
  const dateCol = cols.find((c) => c.role === "endDate" || c.endDate);
  const lineOf = (r: any) => lineCols.map((c) => { const x = r.cells?.[c.id]; if (!x || typeof x !== "object") return x == null ? "" : String(x); if (x.k === "sealed") return ""; if (x.link) return x.link.title; if (x.who) return x.who.name; const v = x.v; return v == null ? "" : String(typeof v === "object" ? v.name ?? "" : v); }).filter(Boolean).join(" · ");
  const phoneList = shown.length ? (
    <Card flush>
      <Stagger>
        {shown.map((r, i) => {
          const fee = end ? r.cells?.[end.id]?.v : null;
          const when = dateCol ? dayMonth(r.cells?.[dateCol.id]?.v) : "";
          return (
            <View key={r.id}>
              {i > 0 ? <Divider /> : null}
              <Row className="py-s3" title={String(r.cells?._title?.v ?? "")} sub={lineOf(r) || undefined}
                end={fee != null && fee !== "" || when ? (
                  <View className="items-end">
                    {fee != null && fee !== "" ? <Text strong size="headline" style={TABULAR}>{fmtMoney(fee)}</Text> : null}
                    {when && dateCol ? <Text size="secondary" tone="label">{`${dateCol.title.toLowerCase()} ${when}`}</Text> : null}
                  </View>
                ) : undefined}
                onPress={h.open ? () => h.open!(k, r) : undefined} />
            </View>
          );
        })}
      </Stagger>
    </Card>
  ) : <Card><EmptyState title={String(b.content?.empty ?? "Nothing here yet.")} /></Card>;

  const columns: Column<any>[] = shownCols.map((c): Column<any> => ({
    key: c.id, label: c.role === "title" ? c.title : c.title,
    render: (r) => <TypedCell col={c} cell={r.cells?.[c.id]} openLink={h.openLink} />,
    sortValue: (r) => { const x = r.cells?.[c.id]; return String((x && typeof x === "object" ? x.s : x) ?? ""); },
  }));
  void title;
  return (
    <View className="gap-s3">
      {controls}
      {chips}
      {phone ? phoneList : <Table columns={columns} rows={shown} rowKey={(r) => r.id} onRow={h.open ? (r) => h.open!(k, r) : undefined} empty={String(b.content?.empty ?? "")} />}
      {shown.length ? <Text size="caption" tone="label">{shown.length} of {b.content?.total ?? all.length}</Text> : null}
    </View>
  );
}
