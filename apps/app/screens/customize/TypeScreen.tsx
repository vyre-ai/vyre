import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Divider, EmptyState, Field, Menu, Row, Sheet, Switch, Text, showToast, Banner } from "@vyre/ui";
import { Group, Page } from "../places/Frame";
import { useTypes } from "./state";
import { KINDS, addField, addStage, callThemCases, fieldLine, kindLabel, moveStage, rename, renameStage, sealField } from "./logic.js";
import type { TypeDef } from "./logic.js";

/** One type: its names, fields, stages and whether it holds work. Edits apply at once, on every view of the type. */
export function TypeScreen() {
  const { type } = useLocalSearchParams<{ type: string }>();
  const router = useRouter();
  const { types, update, load, loading, error } = useTypes();
  useEffect(() => { if (!types.length) void load(); }, []);
  const t = types.find((x) => x.id === type);
  const [one, setOne] = useState(t?.label ?? "");
  const [many, setMany] = useState(t?.plural ?? "");
  const [stages, setStages] = useState<string[]>(t?.stages ?? []);
  const [field, setField] = useState<null | { label: string; kind: string }>(null);
  const [edit, setEdit] = useState<string | null>(null);
  useEffect(() => { if (t) { setOne(t.label); setMany(t.plural); setStages(t.stages); } }, [t?.id]);
  if (!t && loading) return <Page title="Customize" back="/u/settings/customize"><Card><EmptyState title="Loading" body="Asking your Vyre." /></Card></Page>;
  if (!t) return <Page title="Customize" back="/u/settings/customize"><Card><EmptyState title="That type is not here" action={{ label: "Back to Customize", onPress: () => router.push("/u/settings/customize" as never) }} /></Card></Page>;
  const put = (n: TypeDef) => update(n);
  const editing = t.fields.find((f) => f.key === edit);
  return (
    <Page title={t.plural} sub="Customize" back="/u/settings/customize">
      <Group title="Name">
        <Card className="gap-s3">
          <View className="flex-row flex-wrap gap-s3"><Field className="min-w-menu flex-1" label="One" value={one} onChangeText={setOne} /><Field className="min-w-menu flex-1" label="Many" value={many} onChangeText={setMany} /></View>
          <View className="flex-row flex-wrap gap-s2">
            <Button kind="primary" size="sm" label="Save" onPress={() => { put(rename(t, one, many)); showToast("Names saved."); }} />
            {t.id === "matter" ? <Button size="sm" label="Call them Cases" onPress={() => { const c = callThemCases(t); put(c); setOne(c.label); setMany(c.plural); showToast("Matters are now Cases."); }} /> : null}
          </View>
          {t.kit ? <Text size="caption" tone="label">{`Comes from the Kit ${t.kit}. Your names stay when the Kit updates.`}</Text> : null}
        </Card>
      </Group>
      <Group title="Fields">
        <Card flush>
          {t.fields.map((f, i) => <View key={f.key}>{i ? <Divider /> : null}<Row title={f.label} sub={fieldLine(f)} end={f.sealed ? <Chip tone="sealed" icon="vault">Sealed</Chip> : undefined} onPress={() => setEdit(f.key)} /></View>)}
        </Card>
        <View className="flex-row"><Button size="sm" icon="plus" label="Add a field" onPress={() => setField({ label: "", kind: "text" })} /></View>
      </Group>
      {t.stages.length || t.fields.some((f) => f.kind === "stage") ? (
        <Group title="Stages">
          <Card flush>
            {stages.map((s, i) => (
              <View key={i}>
                {i ? <Divider /> : null}
                <View className="gap-s2 p-s3">
                  <Field label={`Stage ${i + 1}`} value={s} onChangeText={(v) => setStages((xs) => xs.map((x, k) => (k === i ? v : x)))} />
                  <Text size="caption" tone="label">{t.rules?.[s] ? `To enter: ${t.rules[s]}` : "No entry rule"}</Text>
                  <View className="flex-row flex-wrap gap-s2">
                    <Button kind="ghost" size="sm" label="Move up" disabled={i === 0} onPress={() => { const n = moveStage(stages, i, -1); setStages(n); put({ ...t, stages: n }); }} />
                    <Button kind="ghost" size="sm" label="Move down" disabled={i === stages.length - 1} onPress={() => { const n = moveStage(stages, i, 1); setStages(n); put({ ...t, stages: n }); }} />
                    <Button kind="ghost" size="sm" label="Rename" onPress={() => { const n = renameStage(t.stages, i, s); if (n === t.stages) { showToast("A stage needs a name that no other stage has."); setStages(t.stages); } else { setStages(n); put({ ...t, stages: n }); } }} />
                  </View>
                </View>
              </View>
            ))}
          </Card>
          <View className="flex-row"><Button size="sm" icon="plus" label="Add a stage" onPress={() => { const n = addStage(stages); setStages(n); put({ ...t, stages: n }); }} /></View>
        </Group>
      ) : null}
      <Card><Row title="Holds work" sub={`Tasks, members and chats on every ${t.label.toLowerCase()}. Shown under Projects.`} end={<Switch label="Holds work" on={t.work} onChange={(work) => put({ ...t, work })} />} /></Card>

      <Sheet open={!!field} onClose={() => setField(null)} title="Add a field">
        {field ? (
          <>
            <Text tone="muted">{`It shows on every view of ${t.plural} at once.`}</Text>
            <Field label="Name" value={field.label} onChangeText={(label) => setField({ ...field, label })} placeholder="Field name" />
            <View className="gap-s1">
              <Text size="caption" strong tone="label">Kind</Text>
              <View className="flex-row"><Menu trigger={<Button label={kindLabel(field.kind)} />} items={KINDS.map(([k, l]) => ({ label: l, onPress: () => setField({ ...field, kind: k }) }))} /></View>
            </View>
            <View className="flex-row gap-s2">
              <Button kind="primary" label="Add field" disabled={!field.label.trim()} onPress={() => { put(addField(t, field.label, field.kind)); setField(null); showToast(`${field.label.trim()} added to ${t.plural}.`); }} />
              <Button kind="ghost" label="Cancel" onPress={() => setField(null)} />
            </View>
          </>
        ) : null}
      </Sheet>
      <Sheet open={!!editing} onClose={() => setEdit(null)} title={editing?.label}>
        {editing ? (
          <>
            <Text tone="muted">{fieldLine(editing)}</Text>
            <Card><Row title="Sealed from AI" sub={`On every ${t.label}. Hidden from every assistant, including yours.`} end={<Switch label="Sealed from AI" on={!!editing.sealed} onChange={(on) => { put(sealField(t, editing.key, on)); showToast(on ? `${editing.label} is sealed on every ${t.label}.` : `${editing.label} is no longer sealed.`); }} />} /></Card>
            <View className="flex-row"><Button kind="ghost" label="Done" onPress={() => setEdit(null)} /></View>
          </>
        ) : null}
      </Sheet>
    </Page>
  );
}
