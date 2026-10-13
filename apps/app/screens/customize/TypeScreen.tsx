import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Divider, EmptyState, Field, FieldEditor, FieldRows, GroupedList, LoadingState, SectionLabel, Sheet, Text, showToast, applyDraft, checkField, draftOf, newDraft, useUiTheme } from "@vyre/ui";
import type { Draft, Group, Rules } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useKernelTypes } from "./kernel-types";
import type { Def } from "./kernel-types";
import { addStage, moveStage, renameStage } from "./logic.js";
import { moveField, parseRule, putField, regroup } from "../../ui/setup/typeedit.js";

// The roles a field can be hidden from (kernel/contracts/fields.d.ts hidden_from). The owner always sees every field.
const ROLES: [string, string][] = [["admin", "Admins"], ["manager", "Managers"], ["member", "Members"], ["temp", "Temporary members"]];

/** One type: its name, its fields in groups, the field editor beside them (a sheet on a phone), its stages. Every change is one records.define. */
export function TypeScreen() {
  const { type } = useLocalSearchParams<{ type: string }>();
  const router = useRouter();
  const { phone } = useUiTheme();
  const { defs, load, loading, save } = useKernelTypes();
  useEffect(() => { if (!defs.length) void load(); }, []);
  const def = defs.find((d) => d.name === type);
  const [label, setLabel] = useState("");
  const [names, setNames] = useState<Record<number, string>>({});
  const [edit, setEdit] = useState<null | { orig?: any; draft: Draft; rules: Rules; tried: boolean }>(null);
  useEffect(() => { if (def) setLabel(def.label); }, [def?.name]);
  if (!def && loading) return <Page title="Customize" back="/u/settings/customize"><LoadingState rows={3} /></Page>;
  if (!def) return <Page title="Customize" back="/u/settings/customize"><Card><EmptyState title="That type is not here" action={{ label: "Back to Customize", onPress: () => router.push("/u/settings/customize" as never) }} /></Card></Page>;
  const types = defs.map((d) => ({ name: d.name, label: d.label, plural: (d.plural as string) ?? `${d.label}s` }));
  const self = types.find((t) => t.name === def.name)!;
  const groups: Group[] = def.groups ?? [];
  const rows = def.fields.filter((f) => f.kind !== "stage").map((f) => draftOf(f) as Draft & { name: string });
  const siblings = def.fields.map((f) => ({ name: f.name, label: f.label, kind: f.kind, options: f.options }));
  const open = (orig?: any, group = "") => {
    const draft = orig ? draftOf(orig) : { ...newDraft("text"), group };
    setEdit({ orig, draft, rules: { visible: parseRule(draft.visible_if), required: parseRule(draft.required_if) }, tried: false });
  };
  const commit = () => {
    if (!edit) return;
    const others = edit.orig ? siblings.filter((s) => s.name !== edit.orig.name) : siblings;
    if (!checkField(edit.draft, others, types).ok) { setEdit({ ...edit, tried: true }); return; }
    const field = applyDraft(edit.orig, edit.draft);
    const g = edit.draft.group;
    save({ ...def, fields: putField(def.fields, field, edit.orig?.name), groups: g && !groups.some((x) => x.name === g) ? [...groups, { name: g }] : groups.length ? groups : undefined } as Def);
    setEdit(null);
    showToast(`${field.label} saved.`);
  };
  const pane = edit ? (
    <FieldEditor draft={edit.draft} onChange={(draft) => setEdit({ ...edit, draft })} owner={self} types={types} roles={ROLES} siblings={siblings} rules={edit.rules} onRules={(rules) => setEdit({ ...edit, rules })}
      tried={edit.tried} editing={!!edit.orig} groups={groups.map((g) => g.name)} onSave={commit} onCancel={() => setEdit(null)} />
  ) : null;
  const stages = (def.stages ?? []).map((s) => s.name);
  const putStages = (n: string[]) => { const old = new Map((def.stages ?? []).map((s: any) => [s.name, s])); save({ ...def, stages: n.map((x) => old.get(x) ?? { name: x }) } as Def); };
  const list = (
    <View className="min-w-0 flex-1 gap-s3">
      <SectionLabel first>Name</SectionLabel>
      <Card className="gap-s3">
        <Field label="Name (one of them)" value={label} onChangeText={setLabel} />
        <View className="flex-row"><Button kind="primary" size="sm" label="Save" disabled={!label.trim() || label === def.label} onPress={() => { save({ ...def, label: label.trim() } as Def); showToast("Name saved."); }} /></View>
      </Card>
      <SectionLabel>Fields</SectionLabel>
      <GroupedList groups={groups} items={rows} itemNoun="fields"
        onChange={({ groups: g, items }) => save({ ...def, groups: g.length ? g : undefined, fields: regroup(def.fields, items) } as Def)}
        renderItems={(items, group) => (
          <View className="gap-s2">
            <FieldRows fields={items} types={types} selected={edit?.orig?.name} onOpen={(n) => open(def.fields.find((f) => f.name === n))} onMove={(n, dir) => save({ ...def, fields: moveField(def.fields, n, dir) } as Def)} />
            <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label="Add a field" onPress={() => open(undefined, group)} /></View>
          </View>
        )} />
      {!groups.length ? <Text size="caption" tone="label">Add a group to split these fields into sections such as Client details.</Text> : null}
      {stages.length ? (
        <>
          <SectionLabel>Stages</SectionLabel>
          <Card flush>
            {stages.map((s, i) => (
              <View key={i}>
                {i ? <Divider /> : null}
                <View className="gap-s2 p-s3">
                  <Field label={`Stage ${i + 1}`} value={names[i] ?? s} onChangeText={(v) => setNames({ ...names, [i]: v })} />
                  <View className="flex-row flex-wrap gap-s2">
                    <Button kind="ghost" size="sm" label="Move up" disabled={i === 0} onPress={() => putStages(moveStage(stages, i, -1))} />
                    <Button kind="ghost" size="sm" label="Move down" disabled={i === stages.length - 1} onPress={() => putStages(moveStage(stages, i, 1))} />
                    <Button kind="ghost" size="sm" label="Rename" disabled={(names[i] ?? s) === s} onPress={() => { const n = renameStage(stages, i, names[i] ?? s); if (n === stages) { showToast("A stage needs a name that no other stage has."); setNames({}); } else { putStages(n); setNames({}); } }} />
                  </View>
                </View>
              </View>
            ))}
          </Card>
          <View className="flex-row"><Button size="sm" icon="plus" label="Add a stage" onPress={() => putStages(addStage(stages))} /></View>
        </>
      ) : null}
    </View>
  );
  return (
    <Page title={def.label ? `${self.plural}` : "Type"} sub="Customize" back="/u/settings/customize">
      <View className={phone ? "gap-s3" : "flex-row items-start gap-s4"}>
        {list}
        {!phone && pane ? <View className="min-w-0 flex-1 gap-s3"><SectionLabel first>{edit?.orig ? `Edit ${edit.orig.label}` : "New field"}</SectionLabel><Card>{pane}</Card></View> : null}
      </View>
      <Sheet open={phone && !!edit} onClose={() => setEdit(null)} title={edit?.orig ? `Edit ${edit.orig.label}` : "New field"}>{pane}</Sheet>
    </Page>
  );
}
