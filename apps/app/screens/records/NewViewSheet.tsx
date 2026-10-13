import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Chip, Field, Segmented, Sheet, Switch, Text, showToast, useStore } from "@vyre/ui";
import { OPS, buildView, fieldChoices, layoutsFor, personalEntry, personalViewsOf, sharedEntry } from "../../ui/views/saved-views.js";
import { editList, useEffectiveList } from "./views-actions";

type Filter = { field: string; op: string; value: string };
const ICONS = ["list", "board", "cal", "users", "chart", "star", "pin", "records"] as const;

/**
 * "New view": pick a type, a layout (List, Table, Board, Calendar), its grouping or date, filters, a sort, a name and an icon, then save it as your own or (an owner or admin) for the whole space,
 * and pin it to the sidebar. The sheet holds the choices; saved-views.js says whether they make a view and what it is. Choices are chips, not menus, because a menu opens in its own layer which a sheet on the web does not let take a press.
 */
export function NewViewSheet({ open, onClose, types, type: first, space, canShare, onSaved, preset }: { open: boolean; /** Filters to start from (the list's own, when it is saved as a view). */ preset?: { filters: Filter[] }; onClose: () => void; types: any[]; type: string; space: string; canShare: boolean; onSaved?: (name: string, type: string) => void }) {
  const store = useStore();
  const list = useEffectiveList();
  const [type, setType] = useState(first);
  const [layout, setLayout] = useState("list");
  const [groupBy, setGroupBy] = useState("");
  const [dateField, setDateField] = useState("");
  const [columns, setColumns] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  useEffect(() => { if (open && preset) { setType(first); setFilters(preset.filters); } }, [open]);
  const [sortField, setSortField] = useState("");
  const [desc, setDesc] = useState(false);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string>("list");
  const [shared, setShared] = useState(false);
  const [pin, setPin] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const def = types.find((t) => t.name === type) ?? types[0];
  const fields = useMemo(() => fieldChoices(def ?? { fields: [] }), [def]);
  const layouts = useMemo(() => layoutsFor(def ?? { fields: [] }), [def]);
  if (!def) return null;
  const pick = (t: string) => { setType(t); setLayout("list"); setGroupBy(""); setDateField(""); setColumns([]); setFilters([]); setSortField(""); setErrors([]); };
  const taken = personalViewsOf(type, list).map((v) => v.name.replace(/^mine-/, ""));
  const draft = () => buildView(def, { name, layout, groupBy: groupBy || fields.groupBy[0]?.name, dateField: dateField || fields.dateField[0]?.name, columns, filters, sort: sortField ? { field: sortField, dir: desc ? "desc" : "asc" } : undefined }, { taken: shared ? [] : taken });
  const save = async () => {
    const built = draft();
    if (!built.ok) { setErrors(built.errors); return; }
    setBusy(true); setErrors([]);
    try {
      if (shared) {
        const diff = sharedEntry(def, built.view);
        if (!diff.ok) { setErrors(diff.errors); return; }
        await store.define({ change_types: [diff.type] } as any);
        if (pin) await editList(space, (l) => [...l.filter((e) => !(e.kind === "view" && e.id === `records-${type}-${built.view.name}`)), { kind: "view", id: `records-${type}-${built.view.name}`.slice(0, 64), label: built.view.label, href: `/u/records/${type}?view=${built.view.name}`, icon } as any]);
        onSaved?.(built.view.name, type);
      } else {
        const entry = personalEntry(type, built.view, { icon, pinned: pin });
        if (!(await editList(space, (l) => [...l.filter((e) => !(e.kind === "view" && e.id === entry.id)), entry as any]))) return;
        onSaved?.(`mine-${built.view.name}`, type);
      }
      showToast(`${built.view.label} saved${pin ? " and pinned" : ""}.`);
      setName(""); onClose();
    } catch (e) { setErrors([e instanceof Error ? e.message : "That did not save."]); } finally { setBusy(false); }
  };
  const chips = (items: { name: string; label: string }[], value: string, onPick: (v: string) => void) => (
    <View className="flex-row flex-wrap gap-s2">{items.map((f) => <Chip key={f.name} tone={value === f.name ? "accent" : "plain"} icon={value === f.name ? "check" : undefined} onPress={() => onPick(f.name)}>{f.label}</Chip>)}</View>
  );
  const label = (t: string) => <Text size="caption" strong tone="label">{t}</Text>;
  const ok = layouts.filter((l) => l.ok);
  return (
    <Sheet open={open} onClose={onClose} title="New view">
      <View className="gap-s4">
        <View className="gap-s1">{label("Records")}{chips(types.map((t) => ({ name: t.name, label: t.plural ?? t.label })), type, pick)}</View>
        <View className="gap-s1">
          {label("Layout")}
          <Segmented<string> label="Layout" value={layout} onChange={(v) => { setLayout(v); setErrors([]); }} options={ok.map((l) => [l.id, l.label] as [string, string])} icons={Object.fromEntries(ok.map((l) => [l.id, l.icon])) as any} />
          {layouts.filter((l) => !l.ok).map((l) => <Text key={l.id} size="caption" tone="label">{`${l.label}: ${l.why}`}</Text>)}
        </View>
        {layout === "board" ? <View className="gap-s1">{label("Columns by")}{chips(fields.groupBy, groupBy || fields.groupBy[0]?.name, setGroupBy)}</View> : null}
        {layout === "calendar" ? <View className="gap-s1">{label("On the date")}{chips(fields.dateField, dateField || fields.dateField[0]?.name, setDateField)}</View> : null}
        {layout === "table" ? (
          <View className="gap-s1">
            {label("Columns")}
            <View className="flex-row flex-wrap gap-s2">{fields.columns.map((f: any) => <Chip key={f.name} tone={columns.includes(f.name) ? "accent" : "plain"} icon={columns.includes(f.name) ? "check" : undefined} onPress={() => setColumns((c) => (c.includes(f.name) ? c.filter((x) => x !== f.name) : [...c, f.name]))}>{f.label}</Chip>)}</View>
          </View>
        ) : null}
        <View className="gap-s2">
          {label("Only show records where")}
          {filters.map((f, i) => (
            <View key={i} className="gap-s2 rounded-card border border-edge p-s3">
              {chips(fields.filter, f.field, (v) => setFilters((fs) => fs.map((x, k) => (k === i ? { ...x, field: v } : x))))}
              <View className="flex-row flex-wrap gap-s2">{OPS.map((o) => <Chip key={o.id} tone={f.op === o.id ? "accent" : "plain"} onPress={() => setFilters((fs) => fs.map((x, k) => (k === i ? { ...x, op: o.id } : x)))}>{o.label}</Chip>)}</View>
              {f.op !== "empty" && f.op !== "filled" ? <Field label="Value" value={f.value} onChangeText={(v) => setFilters((fs) => fs.map((x, k) => (k === i ? { ...x, value: v } : x)))} /> : null}
              <View className="flex-row"><Button kind="ghost" size="sm" label="Remove" onPress={() => setFilters((fs) => fs.filter((_, k) => k !== i))} /></View>
            </View>
          ))}
          <View className="flex-row"><Button size="sm" icon="plus" label="Add a filter" onPress={() => setFilters((fs) => [...fs, { field: fields.filter[0]?.name ?? "", op: "is", value: "" }])} /></View>
        </View>
        <View className="gap-s1">
          {label("Sort by")}
          {chips([{ name: "", label: "Default" }, ...fields.sort], sortField, setSortField)}
          {sortField ? <View className="flex-row items-center gap-s2"><Switch label="Newest or largest first" on={desc} onChange={setDesc} /><Text tone="muted">Largest or newest first</Text></View> : null}
        </View>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Sales pipeline" />
        <View className="gap-s1">
          {label("Icon")}
          <View className="flex-row flex-wrap gap-s2">{ICONS.map((i) => <Chip key={i} tone={icon === i ? "accent" : "plain"} icon={i as any} onPress={() => setIcon(i)}>{i === "cal" ? "calendar" : i}</Chip>)}</View>
        </View>
        {canShare ? <Segmented<string> label="Who sees it" value={shared ? "space" : "me"} onChange={(v) => setShared(v === "space")} options={[["me", "Just me"], ["space", "Everyone in the space"]]} /> : null}
        {shared ? <Text size="caption" tone="label">Everyone sees it, and each person still sees only the records their role allows.</Text> : null}
        <View className="flex-row items-center gap-s2"><Switch label="Pin to the sidebar" on={pin} onChange={setPin} /><Text>Pin to the sidebar</Text></View>
        {errors.length ? <Banner tone="warn">{errors[0]}</Banner> : null}
        <View className="flex-row gap-s2"><Button kind="primary" label="Save view" disabled={busy} onPress={() => void save()} /><Button kind="ghost" label="Cancel" onPress={onClose} /></View>
      </View>
    </Sheet>
  );
}
