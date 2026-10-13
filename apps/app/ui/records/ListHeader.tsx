import { useEffect, useRef, useState } from "react";
import { Platform, View, type TextInput } from "react-native";
import { Button, IconButton } from "../components/Button";
import { useUiTheme } from "../theme";
import { Card } from "../components/Card";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { GroupedList } from "../components/GroupedList";
import { Row } from "../components/Row";
import { Sheet } from "../components/Sheet";
import { Text } from "../components/Text";
import { KIND_LOGIC, normalizeKind } from "../fields/logic.js";
import { CREATED, DATE_PRESETS, chipWords, datePreset, filterableFields } from "./listfilter.js";
import type { Chip as FilterChip } from "./listfilter.js";

export type ListCtx = { me?: string; actors?: { id: string; name: string }[]; links?: Record<string, { title: string; type?: string }>; now?: number };

/**
 * The one header of an object list: its title (a slot, so a named view keeps its menu), "6 of 38", a search that "/" focuses and Escape clears, "+ Filter", the filters as chips that
 * a press removes, and "Save as view". A filter is built from the type's own fields (grouped as the type groups them): the field, how (that kind's own operators), and a value
 * picked, not typed, where the field has choices, people or links. Nothing here knows a record type.
 */
export function ListHeader({ title, noun, shown, total, query, onQuery, chips, onChips, def, ctx, onSave, saveNote, onImport, actions }: {
  title: React.ReactNode; noun: string; shown: number; total: number; query: string; onQuery: (q: string) => void; chips: FilterChip[]; onChips: (c: FilterChip[]) => void; def: any; ctx: ListCtx;
  /** Given, "Save as view" shows when there are filters. */ onSave?: () => void; /** Why some filters will not be kept by a saved view. */ saveNote?: string; /** Given, an Import button sits beside Filter. */ onImport?: () => void; /** Buttons at the end of the search row (New agent, New lead). */ actions?: React.ReactNode;
}) {
  const { phone } = useUiTheme();
  const ref = useRef<TextInput>(null);
  const [adding, setAdding] = useState(false);
  // "/" jumps to the search, as in most tools a person uses all day (web only; a phone has no keyboard shortcut).
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return;
      e.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);
  const narrowed = chips.length > 0 || query.trim() !== "";
  return (
    <View className="gap-s3">
      <View className="flex-row items-end gap-s3">
        <View className="min-w-0 flex-1">{title}<Text size="caption" tone="label">{narrowed ? `${shown} of ${total} ${noun}` : `${total} ${noun}`}</Text></View>
      </View>
      <View className="flex-row flex-wrap items-center gap-s2">
        <View className={phone ? "w-full" : "min-w-menu flex-1"}><Field name="Search" value={query} onChangeText={onQuery} placeholder={`Search ${noun}   /`} inputRef={ref} onKey={(k) => { if (k === "Escape") { onQuery(""); ref.current?.blur(); } }} /></View>
        {phone ? <IconButton kind="secondary" icon="filter" label="Filter" onPress={() => setAdding(true)} /> : <Button kind="secondary" size="sm" icon="plus" label="Filter" onPress={() => setAdding(true)} />}
        {onImport ? (phone ? <IconButton icon="upload" label="Import" onPress={onImport} /> : <Button kind="ghost" size="sm" icon="upload" label="Import" onPress={onImport} />) : null}
        {actions}
        {chips.length && onSave ? <Button kind="ghost" size="sm" icon="pin" label="Save as view" onPress={onSave} /> : null}
      </View>
      {chips.length || query ? (
        <View className="flex-row flex-wrap items-center gap-s2">
          {chips.map((c, i) => <Chip key={i} icon="x" onPress={() => onChips(chips.filter((_, k) => k !== i))}>{chipWords(def, c, ctx)}</Chip>)}
          <Chip onPress={() => { onChips([]); onQuery(""); }}>Clear</Chip>
        </View>
      ) : null}
      {chips.length && saveNote ? <Text size="caption" tone="label">{saveNote}</Text> : null}
      <FilterBuilder open={adding} onClose={() => setAdding(false)} def={def} ctx={ctx} onAdd={(c) => { onChips([...chips, c]); setAdding(false); }} />
    </View>
  );
}

/** Pick a field, how, and a value; it is added as a chip. */
function FilterBuilder({ open, onClose, def, ctx, onAdd }: { open: boolean; onClose: () => void; def: any; ctx: ListCtx; onAdd: (c: FilterChip) => void }) {
  const [field, setField] = useState<any>(null);
  const [op, setOp] = useState("");
  const [a, setA] = useState<any>("");
  const [b, setB] = useState("");
  useEffect(() => { if (!open) { setField(null); setOp(""); setA(""); setB(""); } }, [open]);
  const kind = field ? normalizeKind(field.kind) : "";
  const ops = field ? (KIND_LOGIC[kind] || KIND_LOGIC.text).ops : [];
  const cur = ops.find((o) => o.id === op);
  const choose = (f: any) => { const o = (KIND_LOGIC[normalizeKind(f.kind)] || KIND_LOGIC.text).ops; setField(f); setOp(o[0]?.id ?? ""); setA(""); setB(""); };
  const sections = filterableFields(def);
  const groups = def.groups || [];
  const items = sections.flatMap((s) => s.fields.map((f: any) => ({ ...f, group: s.group })));
  const opt = (): { id: any; label: string }[] => {
    if (kind === "choice" || kind === "stage" || kind === "multi_choice") return (field.options || []).map((o: string) => ({ id: o, label: o }));
    if (kind === "boolean") return [{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }];
    if (kind === "actor") return [...(ctx.me ? [{ id: ctx.me, label: "You" }] : []), ...(ctx.actors || []).filter((x) => x.id !== ctx.me).map((x) => ({ id: x.id, label: x.name }))];
    if (kind === "link" || kind === "ref") return Object.entries(ctx.links || {}).filter(([, t]) => !field.to || !t.type || t.type === field.to).map(([urn, t]) => ({ id: urn, label: t.title }));
    return [];
  };
  const ready = !!cur && (cur.operand === "none" || (cur.operand === "two" ? !!a && !!b : cur.operand === "option" ? a !== "" : String(a).trim() !== ""));
  const add = () => { if (!ready || !cur) return; onAdd({ field: field.name, op, ...(cur.operand === "none" ? {} : { operand: cur.operand === "two" ? [String(a), String(b)] : kind === "actor" ? { actor: { id: a } } : (kind === "link" || kind === "ref") ? { urn: a } : a }) }); };
  return (
    <Sheet open={open} onClose={onClose} title={field ? `Filter by ${field.label}` : "Filter by"}>
      {!field ? (
        <GroupedList groups={groups} items={items} itemNoun="fields" renderItems={(fs) => <Card flush>{fs.map((f: any) => <Row key={f.name} dense title={f.label} sub={f.name === CREATED.name ? "When it was made" : (KIND_LOGIC[normalizeKind(f.kind)] || KIND_LOGIC.text).label} chevron onPress={() => choose(f)} />)}</Card>} />
      ) : (
        <View className="gap-s3">
          <View className="flex-row flex-wrap gap-s2">{ops.map((o) => <Chip key={o.id} selected={op === o.id} onPress={() => { setOp(o.id); setA(""); setB(""); }}>{o.label}</Chip>)}</View>
          {cur?.operand === "option" ? (
            opt().length ? <View className="flex-row flex-wrap gap-s2">{opt().map((o) => <Chip key={String(o.id)} selected={a === o.id} onPress={() => setA(o.id)}>{o.label}</Chip>)}</View> : <Text tone="label">Nothing to pick from yet.</Text>
          ) : null}
          {cur?.operand === "text" ? <Field label="Value" value={String(a)} onChangeText={setA} autoFocus /> : null}
          {cur?.operand === "number" ? <Field label="Value" kind="number" value={String(a)} onChangeText={setA} autoFocus /> : null}
          {cur?.operand === "date" ? <Field label="Date (2026-10-28)" kind="date" value={String(a)} onChangeText={setA} /> : null}
          {cur?.operand === "two" ? (
            <View className="gap-s2">
              {kind === "date" || kind === "datetime" ? <View className="flex-row flex-wrap gap-s2">{DATE_PRESETS.map(([id, l]) => <Chip key={id} onPress={() => { const [x, y] = datePreset(id, ctx.now ?? Date.now()); setA(x); setB(y); }}>{l}</Chip>)}</View> : null}
              <View className="flex-row gap-s2"><View className="min-w-0 flex-1"><Field label="From" value={String(a)} onChangeText={setA} /></View><View className="min-w-0 flex-1"><Field label="To" value={b} onChangeText={setB} /></View></View>
            </View>
          ) : null}
          <View className="flex-row gap-s2"><Button kind="primary" label="Add filter" disabled={!ready} onPress={add} /><Button kind="ghost" label="Back" onPress={() => setField(null)} /></View>
        </View>
      )}
    </Sheet>
  );
}
