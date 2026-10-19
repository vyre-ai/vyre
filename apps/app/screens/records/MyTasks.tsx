import { useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Row, Text } from "@vyre/ui";
import { isMissing, recordsApi, type TaskRow } from "./records-api";
import { MY_GROUPS, dueFirst, stateWords } from "./my-tasks-model.js";

/** My tasks, grouped by the slot I hold: Assigned to you, Reviewing, Approving (tasks.list mine). Draws nothing on a box that does not have the three slots yet. */
export function MyTasks({ onOpen }: { onOpen: (id: string) => void }) {
  const [lists, setLists] = useState<Record<string, TaskRow[]> | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all(MY_GROUPS.map((g) => recordsApi.tasksMine(g.slot as "assigned", g.states).then((r) => ({ g, r })))).then((all) => {
      if (!live) return;
      if (all.some(({ r }) => isMissing(r.error) || (r.error && /mine/i.test(r.error.message ?? "")))) { setMissing(true); return; }
      setLists(Object.fromEntries(all.map(({ g, r }) => [g.slot, dueFirst(r.data?.tasks ?? [])])));
    });
    return () => { live = false; };
  }, []);
  if (missing || !lists) return null;
  return (
    <View className="gap-s3">
      {MY_GROUPS.map((g) => (
        <Card key={g.slot} title={`${g.title}${lists[g.slot].length ? ` · ${lists[g.slot].length}` : ""}`}>
          {lists[g.slot].length ? lists[g.slot].map((t) => <Row key={t.id} title={t.title} sub={[stateWords(t.state), t.due_shown].filter(Boolean).join(" · ")} onPress={() => onOpen(t.id)} />) : <Text tone="label">{g.empty}</Text>}
        </Card>
      ))}
    </View>
  );
}
