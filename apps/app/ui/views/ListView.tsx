import { useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Table, type Column } from "../components/Table";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/States";
import { IconButton } from "../components/Button";
import { Menu, type MenuItem } from "../components/Menu";
import { Row } from "../components/Row";
import { Text } from "../components/Text";
import { Stagger } from "../motion/Appear";
import { useUiTheme } from "../theme";
import { fmtMoney, sortKey, sortRows, toDate } from "../fields/logic.js";
import type { FieldEnv } from "../fields/types";
import { fieldOf, filterRows, listColumns, optionsOf, titleOf, val, viewDefOf, viewRows } from "./logic.js";
import { TitleCell, fieldNode } from "./shared";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (v: any) => { const d = toDate(v); return d ? `${d.getDate()} ${MON[d.getMonth()]}` : ""; };
const TABULAR = { fontVariant: ["tabular-nums" as const] };

/**
 * The list: a table with the title first and the columns the definition names (rows on a phone). The controls are one row: `lead` (the List, Board, Calendar
 * switcher) on the left, then a Filter menu and a Sort menu as icon buttons. A filter that is on shows as a chip with an x (two at most, then "+N").
 * A phone row is the title (17), a line "Jane Doe, Engagement" (links, stage and choices), and at the end the money field in 17 tabular with the calendar
 * date under it ("closing 28 Oct"); the owner is a column on a wide screen and not on the phone.
 */
export function ListView({ def, rows, env, onOpen, lead, view, noFilter }: { def: any; view?: string; noFilter?: boolean; rows: any[]; env: FieldEnv; onOpen?: (rec: any) => void; lead?: ReactNode }) {
  const { phone } = useUiTheme();
  const vd = viewDefOf(def, undefined, view);
  const cols = listColumns(def, vd);
  const [sort, setSort] = useState<string>(vd.list?.sort || vd.titleField);
  const [desc, setDesc] = useState(vd.list?.sortDir === "desc");
  const [filters, setFilters] = useState<Record<string, Set<string>>>({});
  const chipFields = cols.filter((f: any) => f.kind === "choice" || f.kind === "stage");
  const sortable = [fieldOf(def, vd.titleField), ...cols, fieldOf(def, vd.list?.sort ?? "")].filter((f: any, i: number, a: any[]) => f && a.indexOf(f) === i);
  const shown = useMemo(() => {
    const kept = filterRows(viewRows(rows, noFilter ? undefined : vd.list?.filter), filters);
    const sf = fieldOf(def, sort);
    return sf ? sortRows(kept, (r: any) => val(r, sf.name), sf.kind, { def: sf, actors: env.actors, links: env.links }, desc) : kept;
  }, [rows, filters, sort, desc, def, vd.list?.filter, noFilter, env.actors, env.links]);
  const flip = (name: string, opt: string) => {
    const next = new Set(filters[name] || []);
    if (next.has(opt)) next.delete(opt); else next.add(opt);
    setFilters({ ...filters, [name]: next });
  };
  const applied: { f: any; o: string }[] = chipFields.flatMap((f: any) => [...(filters[f.name] ?? [])].map((o) => ({ f, o })));

  const filterItems: MenuItem[] = chipFields.flatMap((f: any) => optionsOf(f).map((o: string) => ({ label: `${f.label}: ${o}`, selected: !!filters[f.name]?.has(o), onPress: () => flip(f.name, o) })));
  const sortItems: MenuItem[] = [
    ...sortable.map((f: any) => ({ label: `Sort by ${f.label}`, selected: f.name === sort, onPress: () => setSort(f.name) })),
    { label: desc ? "Order: high to low" : "Order: low to high", onPress: () => setDesc(!desc) },
  ];
  const controls = (
    <View className="flex-row items-center gap-s2">
      <View className="min-w-0 flex-1 flex-row">{lead}</View>
      {filterItems.length ? <Menu trigger={<IconButton icon="filter" label="Filter" kind="secondary" touch={phone} />} items={filterItems} /> : null}
      <Menu trigger={<IconButton icon="sort" label="Sort" kind="secondary" touch={phone} />} items={sortItems} />
    </View>
  );
  const chips = applied.length ? (
    <View className="flex-row flex-wrap items-center gap-s2">
      {applied.slice(0, 2).map(({ f, o }) => <Chip key={f.name + o} icon="x" onPress={() => flip(f.name, o)}>{`${f.label}: ${o}`}</Chip>)}
      {applied.length > 2 ? <Text size="caption" tone="label">{`+${applied.length - 2}`}</Text> : null}
    </View>
  ) : null;

  const columns: Column<any>[] = [
    { key: "_title", label: def.label, render: (r) => <TitleCell def={def} rec={r} />, sortValue: (r) => titleOf(def, r, vd).toLowerCase() },
    ...cols.map((f: any): Column<any> => ({ key: f.name, label: f.label, render: (r) => fieldNode(f, r, env), sortValue: (r) => sortKey(f.kind, val(r, f.name), { def: f, actors: env.actors, links: env.links }) ?? "" })),
  ];

  // The phone row: link and stage and choice values make the line; the money field and the calendar date go to the end.
  const money = cols.find((f: any) => f.kind === "money");
  const dateField = vd.calendar ? fieldOf(def, vd.calendar.date) : null;
  const lineFields = cols.filter((f: any) => ["link", "ref", "stage", "choice", "text"].includes(f.kind));
  const lineOf = (r: any) => lineFields.map((f: any) => {
    const v = val(r, f.name);
    if (f.kind === "link" || f.kind === "ref") { const urn = typeof v === "object" && v ? String(v.urn || "") : String(v || ""); return env.links?.[urn]?.title ?? ""; }
    return v == null ? "" : String(typeof v === "object" ? v.name ?? "" : v);
  }).filter(Boolean).join(" · ");
  const phoneList = shown.length ? (
    <Card flush>
      <Stagger>
        {shown.map((r, i) => {
          const fee = money ? val(r, money.name) : null;
          const when = dateField ? dayMonth(val(r, dateField.name)) : "";
          return (
            <View key={r.urn}>
              {i > 0 ? <Divider /> : null}
              <Row
                className="py-s3"
                title={titleOf(def, r, vd)}
                sub={lineOf(r) || undefined}
                end={fee != null && fee !== "" || when ? (
                  <View className="items-end">
                    {fee != null && fee !== "" ? <Text strong size="headline" style={TABULAR}>{fmtMoney(fee)}</Text> : null}
                    {when && dateField ? <Text size="secondary" tone="label">{`${dateField.label.toLowerCase()} ${when}`}</Text> : null}
                  </View>
                ) : undefined}
                onPress={onOpen ? () => onOpen(r) : undefined}
              />
            </View>
          );
        })}
      </Stagger>
    </Card>
  ) : <Card><EmptyState title={`No ${vd.plural.toLowerCase()} here yet.`} /></Card>;

  return (
    <View className="gap-s3">
      {controls}
      {chips}
      {phone ? phoneList : <Table columns={columns} rows={shown} rowKey={(r) => r.urn} onRow={onOpen} empty={`No ${vd.plural.toLowerCase()} here yet.`} />}
      {shown.length ? <Text size="caption" tone="label">{shown.length} of {rows.length}</Text> : null}
    </View>
  );
}
