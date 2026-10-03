import { useMemo, useState } from "react";
import { View } from "react-native";
import { Table, type Column } from "../components/Table";
import { Chip } from "../components/Chip";
import { Select } from "../components/Select";
import { Button } from "../components/Button";
import { Text } from "../components/Text";
import { sortKey, sortRows } from "../fields/logic.js";
import type { FieldEnv } from "../fields/types";
import { fieldOf, filterRows, listColumns, optionsOf, titleOf, val, viewDefOf } from "./logic.js";
import { TitleCell, fieldNode } from "./shared";

/** The list: a table with the title first, the columns the definition names, a sort, and chips for the choice and stage columns. Rows on a phone (the Table does that). */
export function ListView({ def, rows, env, onOpen }: { def: any; rows: any[]; env: FieldEnv; onOpen?: (rec: any) => void }) {
  const vd = viewDefOf(def);
  const cols = listColumns(def, vd);
  const [sort, setSort] = useState<string>(vd.list?.sort || vd.titleField);
  const [desc, setDesc] = useState(false);
  const [filters, setFilters] = useState<Record<string, Set<string>>>({});
  const chipFields = cols.filter((f: any) => f.kind === "choice" || f.kind === "stage");
  const sortable = [fieldOf(def, vd.titleField), ...cols, fieldOf(def, vd.list?.sort ?? "")].filter((f: any, i: number, a: any[]) => f && a.indexOf(f) === i);
  const shown = useMemo(() => {
    const kept = filterRows(rows, filters);
    const sf = fieldOf(def, sort);
    return sf ? sortRows(kept, (r: any) => val(r, sf.name), sf.kind, { def: sf, actors: env.actors, links: env.links }, desc) : kept;
  }, [rows, filters, sort, desc, def, env.actors, env.links]);
  const flip = (name: string, opt: string) => {
    const next = new Set(filters[name] || []);
    if (next.has(opt)) next.delete(opt); else next.add(opt);
    setFilters({ ...filters, [name]: next });
  };
  const columns: Column<any>[] = [
    { key: "_title", label: def.label, render: (r) => <TitleCell def={def} rec={r} />, sortValue: (r) => titleOf(def, r, vd).toLowerCase() },
    ...cols.map((f: any): Column<any> => ({ key: f.name, label: f.label, render: (r) => fieldNode(f, r, env), sortValue: (r) => sortKey(f.kind, val(r, f.name), { def: f, actors: env.actors, links: env.links }) ?? "" })),
  ];
  return (
    <View className="gap-s3">
      <View className="flex-row flex-wrap items-end gap-s3">
        {chipFields.map((f: any) => (
          <View key={f.name} accessibilityRole="menu" accessibilityLabel={f.label} className="flex-row flex-wrap gap-s1">
            {optionsOf(f).map((o) => <Chip key={o} selected={!!filters[f.name]?.has(o)} onPress={() => flip(f.name, o)}>{o}</Chip>)}
          </View>
        ))}
        <View className="flex-1" />
        <View className="min-w-menu flex-row items-end gap-s2">
          <Select className="flex-1" label="Sort" value={sort} options={sortable.map((f: any) => [f.name, f.label])} onChange={setSort} />
          <Button size="sm" kind="secondary" label={desc ? "High to low" : "Low to high"} accessibilityLabel={desc ? "Sorted high to low. Reverse" : "Sorted low to high. Reverse"} onPress={() => setDesc(!desc)} />
        </View>
      </View>
      <Table columns={columns} rows={shown} rowKey={(r) => r.urn} onRow={onOpen} empty={`No ${vd.plural.toLowerCase()} here yet.`} />
      {shown.length ? <Text size="caption" tone="label">{shown.length} of {rows.length}</Text> : null}
    </View>
  );
}
