import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, Icon, Row, Text, showToast } from "@vyre/ui";
import { RecordTimeline } from "./RecordTimeline";
import { isMissing, recordsApi, type HistoryItem } from "./records-api";
import { HISTORY_FILTERS, actorWords, filterHistory } from "./history-model.js";
import { ago } from "../../ui/views/logic.js";

const ICON: Record<string, any> = { chat: "chat", email: "mail", task: "task", flow: "flows", file: "file", note: "edit", call: "phone", meeting: "cal", agent: "spark", edit: "edit" };

/**
 * A record's History: what happened to it, who did it (a person, or an agent tagged as one), a row of filters, an Undo on what can be undone, and the quick actions under the name: Log a call, Log a meeting, Add a
 * note, New task. It reads records.history; a box that does not have it yet shows the timeline it always had.
 */
export function RecordHistory({ urn, me, refresh = 0 }: { urn: string; me?: string; type?: string; /** Changes when something was logged above, so the list is read again. */ refresh?: number }) {
  const [items, setItems] = useState<HistoryItem[] | null | "missing">(null);
  const [filter, setFilter] = useState("all");
  const load = useCallback(() => { void recordsApi.history(urn).then((r) => setItems(r.error ? (isMissing(r.error) ? "missing" : []) : r.data?.items ?? [])); }, [urn]);
  useEffect(() => { setItems(null); load(); }, [load, refresh]);
  const undo = async (id: string) => {
    const r = await recordsApi.undo(id);
    if (r.error) { showToast(r.error.message || "That could not be undone."); return; }
    showToast("Undone. It is back the way it was.");
    load();
  };
  if (items === "missing") return <RecordTimeline urn={urn} />;
  const shown = items ? filterHistory(items, filter) : [];
  return (
    <View className="gap-s3">
      <Card title="History" className="gap-s3">
        <View className="flex-row flex-wrap gap-s2">{HISTORY_FILTERS.map(([k, l]) => <Chip key={k} selected={filter === k} onPress={() => setFilter(k)}>{l}</Chip>)}</View>
        {items === null ? <Text tone="label">Loading</Text> : shown.length ? shown.map((i) => (
          <Row key={i.id} dense lead={<View className="pr-s3"><Icon name={ICON[i.kind] ?? "records"} /></View>}
            title={<Text medium size="body">{i.text}</Text>}
            sub={`${actorWords(i.actor, me)}${i.actor?.kind === "agent" ? " (agent)" : ""} · ${ago(i.at, Date.now())}${i.file ? ` · ${i.file}` : ""}`}
            end={i.undo ? <Button kind="ghost" size="sm" label="Undo" onPress={() => void undo(i.id)} /> : undefined} />
        )) : <Text tone="label">Nothing of this kind yet.</Text>}
      </Card>
    </View>
  );
}
