// An agent's Work: the threads it has run, newest first, with what started each and where it stands. Opening a row opens the thread in Chat, thinking and tool calls included.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Card, Chip, Divider, EmptyState, ErrorState, LoadingState, Row, Segmented, Text } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { callT as call } from "../../src/real/call-tool";
import { WORK_FILTERS, emptyWork, filterWork, workRows, type WorkFilter, type WorkRow } from "./agent-work-model.ts";

export default function AgentWork({ name }: { name: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<WorkRow[] | null>(null);
  const [err, setErr] = useState("");
  const [f, setF] = useState<WorkFilter>("all");
  const load = useCallback(() => {
    setErr("");
    call<unknown>("threads.list", { agent: name, all: true }).then((r) => {
      if (r.error) setErr(r.error.message || "The server did not answer.");
      else setRows(workRows(r.data, name));
    }).catch((e) => setErr(e instanceof Error && e.message ? e.message : "The server did not answer."));
  }, [name]);
  useEffect(load, [load]);
  const shown = useMemo(() => (rows ? filterWork(rows, f) : []), [rows, f]);
  return (
    <Sec title="Work">
      <Segmented label="Show" options={WORK_FILTERS} value={f} onChange={setF} />
      {err ? <Card flush><ErrorState title="Work did not load" reason={err} retry={load} /></Card> : null}
      {!rows && !err ? <LoadingState rows={3} /> : null}
      {rows && !shown.length ? <Card><EmptyState title="Nothing here yet" body={emptyWork(name, f)} /></Card> : null}
      {shown.length ? (
        <Card flush>
          {shown.map((r, i) => (
            <View key={r.id}>
              {i ? <Divider /> : null}
              <Row title={r.title} sub={r.sub} chevron end={r.needsYou ? <Chip>Needs you</Chip> : undefined} onPress={() => router.push(`/u/chats/${encodeURIComponent(r.id)}` as never)} accessibilityLabel={`Open ${r.title}`} />
            </View>
          ))}
          <Divider />
          <View className="p-s3"><Text size="caption" tone="label">{`Work given to ${name} by a Flow or a task is not listed here yet: it has no thread of its own.`}</Text></View>
        </Card>
      ) : null}
    </Sec>
  );
}
