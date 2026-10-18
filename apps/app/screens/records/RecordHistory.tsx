import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Field, Icon, Row, Sheet, Text, showToast } from "@vyre/ui";
import { RecordTimeline } from "./RecordTimeline";
import { isMissing, recordsApi, type HistoryItem } from "./records-api";
import { HISTORY_FILTERS, QUICK, actorWords, filterHistory } from "./history-model.js";
import { ago } from "../../ui/views/logic.js";

const ICON: Record<string, any> = { chat: "chat", email: "mail", task: "task", flow: "flows", file: "file", note: "edit", call: "phone", meeting: "cal", agent: "spark", edit: "edit" };

/**
 * A record's History: what happened to it, who did it (a person, or an agent tagged as one), a row of filters, an Undo on what can be undone, and the quick actions under the name: Log a call, Log a meeting, Add a
 * note, New task. It reads records.history; a box that does not have it yet shows the timeline it always had.
 */
export function RecordHistory({ urn, me, type }: { urn: string; me?: string; type: string }) {
  const router = useRouter();
  const [items, setItems] = useState<HistoryItem[] | null | "missing">(null);
  const [filter, setFilter] = useState("all");
  const [asking, setAsking] = useState<null | (typeof QUICK)[number]>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void recordsApi.history(urn).then((r) => setItems(r.error ? (isMissing(r.error) ? "missing" : []) : r.data?.items ?? [])); }, [urn]);
  useEffect(() => { setItems(null); load(); }, [load]);
  const save = async () => {
    if (!asking) return;
    setBusy(true);
    const r = await recordsApi.log(urn, asking.key, text.trim());
    setBusy(false);
    if (r.error) { showToast(r.error.message || "That did not save."); return; }
    setAsking(null); setText(""); load();
  };
  const undo = async (id: string) => {
    const r = await recordsApi.undo(id);
    if (r.error) { showToast(r.error.message || "That could not be undone."); return; }
    showToast("Undone. It is back the way it was.");
    load();
  };
  const quick = (
    <View className="flex-row flex-wrap gap-s2">
      {QUICK.map((q) => <Button key={q.key} kind="secondary" size="sm" label={q.label} onPress={() => { setText(""); setAsking(q); }} />)}
      <Button kind="secondary" size="sm" icon="plus" label="New task" onPress={() => router.push(`/u/record/new?type=task&about=${encodeURIComponent(urn)}` as never)} />
    </View>
  );
  if (items === "missing") return <View className="gap-s3">{quick}<RecordTimeline urn={urn} /><Ask asking={asking} text={text} setText={setText} busy={busy} onSave={save} onClose={() => setAsking(null)} /></View>;
  const shown = items ? filterHistory(items, filter) : [];
  return (
    <View className="gap-s3">
      {quick}
      <Card title="History" className="gap-s3">
        <View className="flex-row flex-wrap gap-s2">{HISTORY_FILTERS.map(([k, l]) => <Chip key={k} selected={filter === k} onPress={() => setFilter(k)}>{l}</Chip>)}</View>
        {items === null ? <Text tone="label">Loading</Text> : shown.length ? shown.map((i) => (
          <Row key={i.id} dense lead={<View className="pr-s3"><Icon name={ICON[i.kind] ?? "records"} /></View>}
            title={<Text medium size="body">{i.text}</Text>}
            sub={`${actorWords(i.actor, me)}${i.actor?.kind === "agent" ? " (agent)" : ""} · ${ago(i.at, Date.now())}${i.file ? ` · ${i.file}` : ""}`}
            end={i.undo ? <Button kind="ghost" size="sm" label="Undo" onPress={() => void undo(i.id)} /> : undefined} />
        )) : <Text tone="label">Nothing of this kind yet.</Text>}
      </Card>
      <Ask asking={asking} text={text} setText={setText} busy={busy} onSave={save} onClose={() => setAsking(null)} />
    </View>
  );
}

function Ask({ asking, text, setText, busy, onSave, onClose }: { asking: null | (typeof QUICK)[number]; text: string; setText: (t: string) => void; busy: boolean; onSave: () => void; onClose: () => void }) {
  return (
    <Sheet open={!!asking} onClose={onClose} title={asking?.label}>
      <View className="gap-s3">
        <Field label={asking?.ask} value={text} onChangeText={setText} multiline lines={3} />
        <View className="flex-row gap-s2">
          <Button kind="primary" label="Save" loading={busy} disabled={busy || !text.trim()} onPress={onSave} />
          <Button kind="ghost" label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
