import { useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, FieldEditor, FieldRows, ModelMap, SectionLabel, Text, TypeStarter, checkField, newDraft, nameOf, useUiTheme } from "@vyre/ui";
import type { Draft, Rules } from "@vyre/ui";
import { ASSET, ASSET_FIELDS, DRAFTS, MODEL, ROLES, STARTERS, TYPES } from "./data";

const noRules: Rules = { visible: null, required: null };
const asRefs = (rows: { name: string; label: string; kind: string; options?: string[] }[]) => rows.map((r) => ({ name: r.name, label: r.label, kind: r.kind, options: r.options }));

/** The field pane on its own, from a given draft, so each part of it can be seen and tried. */
export function FieldPaneDemo({ draft: initial, tried = false, rules: r0 = noRules }: { draft: Draft; tried?: boolean; rules?: Rules }) {
  const [draft, setDraft] = useState(initial);
  const [rules, setRules] = useState(r0);
  return (
    <Card>
      <FieldEditor draft={draft} onChange={setDraft} owner={ASSET} types={TYPES} roles={ROLES} siblings={asRefs(ASSET_FIELDS)} rules={rules} onRules={setRules} tried={tried} editing={!!draft.name} onSave={() => {}} onCancel={() => {}} />
    </Card>
  );
}

/** The model map: every type, its counts, what it links to. */
export function ModelMapDemo() {
  return (
    <View className="gap-s3">
      <SectionLabel first>Record types</SectionLabel>
      <ModelMap types={MODEL} onOpen={() => {}} />
      <View className="flex-row"><Button kind="primary" icon="plus" label="Add a type" onPress={() => {}} /></View>
    </View>
  );
}

export function StarterDemo({ picked: p0 = "assets" }: { picked?: string }) {
  const [picked, setPicked] = useState(p0);
  const [name, setName] = useState(STARTERS.find((s) => s.id === p0)?.label.replace(/ies$/, "y").replace(/s$/, "") ?? "Item");
  const [work, setWork] = useState(false);
  return (
    <View className="gap-s3">
      <SectionLabel first>Add a type</SectionLabel>
      <Text tone="muted">A new kind of record for Juniper Studio. Pick where it starts.</Text>
      <TypeStarter starters={STARTERS} picked={picked} onPick={(id) => { setPicked(id); const s = STARTERS.find((x) => x.id === id); if (s) setName(id === "blank" ? "Item" : s.label.replace(/ies$/, "y").replace(/s$/, "")); }} name={name} onName={setName} work={work} onWork={setWork} />
      <View className="flex-row gap-s2"><Button kind="primary" label={`Add ${name || "type"}`} onPress={() => {}} /><Button kind="ghost" label="Cancel" onPress={() => {}} /></View>
    </View>
  );
}

/** One type's setup: its names, its fields as rows, and on a desk the field pane beside them. Real state: add, edit, move, save. */
export function TypeSetupDemo({ open: o0 = null, adding = false }: { open?: string | null; adding?: boolean }) {
  const { phone } = useUiTheme();
  const [fields, setFields] = useState(ASSET_FIELDS);
  const [open, setOpen] = useState<string | null>(o0);
  const [draft, setDraft] = useState<Draft | null>(adding ? newDraft("text") : o0 ? ASSET_FIELDS.find((f) => f.name === o0) as Draft : null);
  const [rules, setRules] = useState<Rules>(noRules);
  const [tried, setTried] = useState(false);
  const edit = (name: string) => { setOpen(name); setDraft(fields.find((f) => f.name === name) as Draft); setRules(noRules); setTried(false); };
  const start = () => { setOpen(null); setDraft(newDraft("text")); setRules(noRules); setTried(false); };
  const save = () => {
    if (!draft) return;
    const siblings = fields.filter((f) => f.name !== open);
    if (!checkField(draft, siblings, TYPES).ok) { setTried(true); return; }
    const row = { ...draft, name: open ?? nameOf(draft.label) } as Draft & { name: string; label: string; kind: string };
    setFields(open ? fields.map((f) => (f.name === open ? row : f)) : [...fields, row]);
    setDraft(null); setOpen(null);
  };
  const move = (name: string, dir: -1 | 1) => { const i = fields.findIndex((f) => f.name === name), j = i + dir; if (j < 0 || j >= fields.length) return; const n = [...fields]; [n[i], n[j]] = [n[j], n[i]]; setFields(n); };
  const list = (
    <View className="min-w-0 flex-1 gap-s3">
      <Card className="gap-s1"><Text strong>Assets</Text><Text size="caption" tone="label">What a client owns. Each belongs to one Client and shows on the Client's page.</Text><View className="flex-row flex-wrap gap-s2"><Chip>6 fields</Chip><Chip icon="link">Clients</Chip></View></Card>
      <SectionLabel first>Fields</SectionLabel>
      <FieldRows fields={fields} types={TYPES} selected={open ?? undefined} onOpen={edit} onMove={move} />
      <View className="flex-row"><Button icon="plus" label="Add a field" onPress={start} /></View>
    </View>
  );
  const pane = draft ? (
    <View className={phone ? "gap-s3" : "min-w-0 flex-1 gap-s3"}>
      <SectionLabel first>{open ? `Edit ${draft.label}` : "New field"}</SectionLabel>
      <Card><FieldEditor draft={draft} onChange={setDraft} owner={ASSET} types={TYPES} roles={ROLES} siblings={asRefs(fields)} rules={rules} onRules={setRules} tried={tried} editing={!!open} onSave={save} onCancel={() => { setDraft(null); setOpen(null); }} /></Card>
    </View>
  ) : null;
  return (
    <View className="gap-s3">
      {tried && draft ? <Banner tone="warn">Fix the marked fields to save.</Banner> : null}
      <View className={phone ? "gap-s3" : "flex-row items-start gap-s4"}>{list}{pane}</View>
    </View>
  );
}
