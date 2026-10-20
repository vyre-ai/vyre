import { useEffect, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, EmptyState, Field, FieldEditor, FieldRows, GroupedList, LoadingState, SectionLabel, Sheet, Tabs, Text, showToast, applyDraft, checkField, draftOf, newDraft, useUiTheme } from "@vyre/ui";
import type { Draft, Group, Rules } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useKernelTypes } from "./kernel-types";
import { TypeAccess } from "./TypeAccess";
import { TypeHistory } from "./TypeHistory";
import type { Def } from "./kernel-types";
import { PipelinesEditor } from "./PipelinesEditor";
import { InlineTitle } from "./InlineTitle";
import { moveField, parseRule, putField, regroup } from "../../ui/setup/typeedit.js";
import { fieldTokens, tokenList } from "../../ui/setup/fieldtokens.js";
import { useRecordsAccess } from "../records/records-access";

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
  // only an owner or an admin changes a type (records.define): anyone else reads its fields
  const { admin } = useRecordsAccess();
  useEffect(() => { if (!defs.length) void load(); }, []);
  const def = defs.find((d) => d.name === type);
  const [edit, setEdit] = useState<null | { orig?: any; draft: Draft; rules: Rules; tried: boolean }>(null);
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
  const list = (
    <View className="min-w-0 flex-1 gap-s3">
      {admin ? <InlineTitle label="Name" value={def.label} busy={working} onCommit={(next) => { save({ ...def, label: next } as Def); showToast(`Renamed to ${next}.`); }} /> : <Text strong>{def.label}</Text>}
      {admin ? null : <Text size="caption" tone="label">Only an owner or an admin changes this type's fields.</Text>}
      <SectionLabel first={false}>Fields</SectionLabel>
      <View className="flex-row"><Button kind="ghost" size="sm" icon="copy" label="Copy all as a list" onPress={() => copy(tokenList(def as any, defs as any), "The list")} /></View>
      <GroupedList groups={groups} items={rows} itemNoun="fields"
        onChange={admin ? ({ groups: g, items }) => save({ ...def, groups: g.length ? g : undefined, fields: regroup(def.fields, items) } as Def) : undefined}
        renderItems={(items, group) => (
          <View className="gap-s2">
            <FieldRows fields={items} types={types} tokens={tokens} onCopy={copy} selected={edit?.orig?.name} onOpen={(n) => { if (admin) open(def.fields.find((f) => f.name === n)); }} onMove={admin ? (n, dir) => save({ ...def, fields: moveField(def.fields, n, dir) } as Def) : undefined} />
            {admin ? <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label="Add a field" onPress={() => open(undefined, group)} /></View> : null}
          </View>
        )} />
      {!groups.length && admin ? <Text size="caption" tone="label">Add a group to split these fields into sections such as Contact details.</Text> : null}
      {stages.length && admin ? <PipelinesEditor def={def} reload={() => void load()} /> : null}
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
  if (!def && loading) return <Page title="Types" back="/u/settings/customize"><LoadingState rows={3} /></Page>;
  if (!def) return <Page title="Types" back="/u/settings/customize"><Card><EmptyState title="That type is not here" action={{ label: "Back to Types", onPress: () => router.push("/u/settings/customize" as never) }} /></Card></Page>;
  const plural = (def.plural as string) ?? `${def.label}s`;
  return (
    <Page title={def.label ? plural : "Type"} back="/u/settings/customize">
      <Pressable accessibilityRole="link" accessibilityLabel="Back to Types" onPress={() => router.push("/u/settings/customize" as never)} className="self-start"><Text size="caption" tone="label">Types /</Text></Pressable>
      <Tabs value={tab} onChange={setTab} items={[["fields", "Fields"], ["access", "Access"], ["history", "History"]]} />
      {tab === "access" ? <TypeAccess type={def.name} label={plural} /> : tab === "history" ? <TypeHistory type={def.name} /> : <TypeFields type={def.name} />}
    </Page>
  );
}
