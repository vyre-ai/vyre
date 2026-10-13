// An agent's Work: the threads it has run, newest first, with what started each and where it stands. Opening a row opens the thread in Chat, thinking and tool calls included.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Card, Chip, Divider, EmptyState, ErrorState, IconTile, LoadingState, Row, Segmented, Text } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { callT as call } from "../../src/real/call-tool";
import { flowChatSub, flowChatsOf, type FlowChat } from "../chats/flow-chat-model.ts";
import { WORK_FILTERS, emptyWork, filterWork, workRows, type WorkFilter, type WorkRow } from "./agent-work-model.ts";

export default function AgentWork({ name }: { name: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<WorkRow[] | null>(null);
  const [flows, setFlows] = useState<FlowChat[]>([]);
  const [err, setErr] = useState("");
  const [f, setF] = useState<WorkFilter>("all");
  const load = useCallback(() => {
    setErr("");
    call<unknown>("threads.list", { agent: name, all: true }).then((r) => {
      if (r.error) setErr(r.error.message || "The server did not answer.");
      else { setRows(workRows(r.data, name)); setFlows(flowChatsOf(r.data, name)); }
    }).catch((e) => setErr(e instanceof Error && e.message ? e.message : "The server did not answer."));
  }, [name]);
  useEffect(load, [load]);
  const shown = useMemo(() => (rows ? filterWork(rows, f) : []), [rows, f]);
  return (
    <Sec title="Work">
      <Segmented label="Show" options={WORK_FILTERS} value={f} onChange={setF} />
      {err ? <Card flush><ErrorState title="Work did not load" reason={err} retry={load} /></Card> : null}
      {!rows && !err ? <LoadingState rows={3} /> : null}
      {rows && !shown.length && !(f !== "jobs" && f !== "people" && flows.length) ? <Card><EmptyState title="Nothing here yet" body={emptyWork(name, f)} /></Card> : null}
      {rows && f !== "jobs" && f !== "people" && flows.length ? (
        <Card flush>
          {flows.map((c, i) => (
            <View key={c.id}>
              {i ? <Divider /> : null}
              <Row lead={<IconTile size={40} name="flows" />} title={<Text strong numberOfLines={2}>{c.title}</Text>} sub={flowChatSub(c, Date.now())} chevron end={c.needsYou ? <Chip>Needs you</Chip> : undefined} accessibilityLabel={`Open ${c.title}`} onPress={() => router.push(`/u/chats/flow/${encodeURIComponent(c.id)}` as never)} />
            </View>
          ))}
        </Card>
      ) : null}
      {shown.length ? (
        <Card flush>
          {shown.map((r, i) => (
            <View key={r.id}>
              {i ? <Divider /> : null}
              <Row title={r.title} sub={r.sub} chevron end={r.needsYou ? <Chip>Needs you</Chip> : undefined} onPress={() => router.push(`/u/chats/${encodeURIComponent(r.id)}` as never)} accessibilityLabel={`Open ${r.title}`} />
            </View>
          ))}
          <Divider />
          <View className="p-s3"><Text size="caption" tone="label">{`A task given to ${name} outside a Flow wake is not listed here: it has no thread of its own.`}</Text></View>
        </Card>
      ) : null}
    </Sec>
  );
}
