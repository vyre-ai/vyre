import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Divider, EmptyState, Field, FieldEditor, FieldRows, GroupedList, LoadingState, SectionLabel, Sheet, Tabs, Text, showToast, applyDraft, checkField, draftOf, newDraft, useUiTheme } from "@vyre/ui";
import type { Draft, Group, Rules } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useKernelTypes } from "./kernel-types";
import { TypeAccess } from "./TypeAccess";
import { TypeHistory } from "./TypeHistory";
import type { Def } from "./kernel-types";
import { addStage, moveStage, renameStage } from "./logic.js";
import { askable, pipelineInput, stageRows, toggleLost, toggleNeed } from "./stage-rules.js";
import { callT } from "../../src/real/call-tool";
import { moveField, parseRule, putField, regroup } from "../../ui/setup/typeedit.js";
import { fieldTokens, tokenList } from "../../ui/setup/fieldtokens.js";

// The roles a field can be hidden from (kernel/contracts/fields.d.ts hidden_from). The owner always sees every field.
const ROLES: [string, string][] = [["admin", "Admins"], ["manager", "Managers"], ["member", "Members"], ["temp", "Temporary members"]];

/** Copy text to the clipboard: the browser's on the web, the phone's otherwise. */
async function copyText(text: string) {
  if (Platform.OS === "web") { if (typeof navigator !== "undefined" && navigator.clipboard) await navigator.clipboard.writeText(text); return; }
  const mod = await import("expo-clipboard");
  await mod.setStringAsync(text);
}

/** One type's fields, in groups, with the field editor beside them (a sheet on a phone), its name and its stages. Every change is one records.define. Settings and the Records page both show it. */
export function TypeFields({ type }: { type: string }) {
  const { phone } = useUiTheme();
  const { defs, load, save, busy } = useKernelTypes();
  useEffect(() => { if (!defs.length) void load(); }, []);
  const def = defs.find((d) => d.name === type);
  const [label, setLabel] = useState("");
  const [names, setNames] = useState<Record<number, string>>({});
  const [edit, setEdit] = useState<null | { orig?: any; draft: Draft; rules: Rules; tried: boolean }>(null);
  useEffect(() => { if (def) setLabel(def.label); }, [def?.name]);
  if (!def) return null;
  const types = defs.map((d) => ({ name: d.name, label: d.label, plural: (d.plural as string) ?? `${d.label}s` }));
  const self = types.find((t) => t.name === def.name)!;
  const groups: Group[] = def.groups ?? [];
  const rows = def.fields.filter((f) => f.kind !== "stage").map((f) => draftOf(f) as Draft & { name: string });
  const siblings = def.fields.map((f) => ({ name: f.name, label: f.label, kind: f.kind, options: f.options }));
  const tokens = fieldTokens(def as any, defs as any);
  const copy = (text: string, what: string) => { void copyText(text).then(() => showToast(`${what} copied.`), () => showToast("Copying did not work here. Select the text and copy it.")); };
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
  const working = !!busy[def.name];
  const pane = edit ? (
    <FieldEditor draft={edit.draft} onChange={(draft) => setEdit({ ...edit, draft })} owner={self} types={types} roles={ROLES} siblings={siblings} rules={edit.rules} onRules={(rules) => setEdit({ ...edit, rules })}
      tried={edit.tried} busy={working} editing={!!edit.orig} groups={groups.map((g) => g.name)} sealLocked={edit.orig && edit.orig.kind !== "sealed" ? "To seal values this field already holds, add a new sealed field. Moving existing values into the vault is not offered here yet." : edit.orig ? "A sealed field stays sealed. Who may reveal it can be changed below." : undefined} onSave={commit} onCancel={() => setEdit(null)} />
  ) : null;
  const stages = (def.stages ?? []).map((s) => s.name);
  const putStages = (n: string[]) => { const old = new Map((def.stages ?? []).map((s: any) => [s.name, s])); save({ ...def, stages: n.map((x) => old.get(x) ?? { name: x }) } as Def); };
  // A stage's rules (the fields it needs, whether it is a lost stage) are written by records.pipeline.set, which makes the entry condition; the list is read back from the type.
  const needsRows = stageRows(def);
  const putRules = (rows: ReturnType<typeof stageRows>) => { void callT("records.pipeline.set", pipelineInput(def.name, rows)).then((r) => { if (r.error) showToast(r.error.message || "That did not save."); else void load(); }); };
  const list = (
    <View className="min-w-0 flex-1 gap-s3">
      <SectionLabel first>Name</SectionLabel>
      <Card className="gap-s3">
        <Field label="Name (one of them)" value={label} onChangeText={setLabel} />
        <View className="flex-row"><Button kind="primary" size="sm" label="Save" loading={working} disabled={working || !label.trim() || label === def.label} onPress={() => { save({ ...def, label: label.trim() } as Def); showToast("Name saved."); }} /></View>
      </Card>
      <SectionLabel>Fields</SectionLabel>
      <View className="flex-row"><Button kind="ghost" size="sm" icon="copy" label="Copy all as a list" onPress={() => copy(tokenList(def as any, defs as any), "The list")} /></View>
      <GroupedList groups={groups} items={rows} itemNoun="fields"
        onChange={({ groups: g, items }) => save({ ...def, groups: g.length ? g : undefined, fields: regroup(def.fields, items) } as Def)}
        renderItems={(items, group) => (
          <View className="gap-s2">
            <FieldRows fields={items} types={types} tokens={tokens} onCopy={copy} selected={edit?.orig?.name} onOpen={(n) => open(def.fields.find((f) => f.name === n))} onMove={(n, dir) => save({ ...def, fields: moveField(def.fields, n, dir) } as Def)} />
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
                  <View className="gap-s1">
                    <Text size="caption" tone="label">{needsRows[i]?.requires.length ? "Needs these before a record can enter it" : "Needs nothing to enter"}</Text>
                    <View className="flex-row flex-wrap gap-s1">
                      {askable(def).map((f: any) => <Chip key={f.name} selected={!!needsRows[i]?.requires.includes(f.name)} onPress={() => putRules(toggleNeed(needsRows, i, f.name))}>{String(f.label ?? f.name)}</Chip>)}
                      <Chip selected={!!needsRows[i]?.lost} onPress={() => putRules(toggleLost(needsRows, i))}>Counts as lost, asks why</Chip>
                    </View>
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
    <>
      {working ? <Banner><Text strong>{`Setting up ${def.label} in Records...`}</Text><Text size="caption" tone="muted">This can take a minute. You can leave this page; it finishes on its own.</Text></Banner> : null}
      <View className={phone ? "gap-s3" : "flex-row items-start gap-s4"}>
        {list}
        {!phone && pane ? <View className="min-w-0 flex-1 gap-s3"><SectionLabel first>{edit?.orig ? `Edit ${edit.orig.label}` : "New field"}</SectionLabel><Card>{pane}</Card></View> : null}
      </View>
      <Sheet open={phone && !!edit} onClose={() => setEdit(null)} title={edit?.orig ? `Edit ${edit.orig.label}` : "New field"}>{pane}</Sheet>
    </>
  );
}

/** One type in Settings: its Fields, Access and History tabs. */
export function TypeScreen() {
  const { type } = useLocalSearchParams<{ type: string }>();
  const router = useRouter();
  const { defs, load, loading } = useKernelTypes();
  useEffect(() => { if (!defs.length) void load(); }, []);
  const def = defs.find((d) => d.name === type);
  const [tab, setTab] = useState("fields");
  if (!def && loading) return <Page title="Objects" back="/u/settings/customize"><LoadingState rows={3} /></Page>;
  if (!def) return <Page title="Objects" back="/u/settings/customize"><Card><EmptyState title="That type is not here" action={{ label: "Back to Customize", onPress: () => router.push("/u/settings/customize" as never) }} /></Card></Page>;
  const plural = (def.plural as string) ?? `${def.label}s`;
  return (
    <Page title={def.label ? plural : "Type"} sub="Objects" back="/u/settings/customize">
      <Tabs value={tab} onChange={setTab} items={[["fields", "Fields"], ["access", "Access"], ["history", "History"]]} />
      {tab === "access" ? <TypeAccess type={def.name} label={plural} /> : tab === "history" ? <TypeHistory type={def.name} /> : <TypeFields type={def.name} />}
    </Page>
  );
}
