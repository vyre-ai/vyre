// "This Space's assistants and teammates" for a member of a joined team: read-only, with the gate's words when she tries to use one (nothing is started from here). The records are the ones the team's door lets a member read.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Divider, EmptyState, LoadingState, Text, markRef } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { showingJoined } from "../../src/real/team-join";
import { askWords, spaceAgents, spaceTeammates } from "./space-agents-model.js";

export function SpaceAssistants() {
  const [joined, setJoined] = useState(false);
  const [agents, setAgents] = useState<ReturnType<typeof spaceAgents> | null>(null);
  const [mates, setMates] = useState<ReturnType<typeof spaceTeammates>>([]);
  const [said, setSaid] = useState("");
  useEffect(() => {
    void showingJoined().catch(() => false).then(async (j) => {
      setJoined(j);
      if (!j) return;
      const a = await callT("records.list", { type: "agent" });
      setAgents(a.error ? [] : spaceAgents(a.data));
      const t = await callT("records.list", { type: "team-member" });
      setMates(t.error ? [] : spaceTeammates(t.data));
    });
  }, []);
  if (!joined) return null;
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">This Space's assistants and teammates</Text>
      {agents === null ? <LoadingState rows={2} /> : null}
      {agents && !agents.length && !mates.length ? <Card><EmptyState title="Nothing to show yet" body="The team's assistants and teammates show here when the owner adds them." /></Card> : null}
      {agents && agents.length ? (
        <Card flush>
          {agents.map((a, i) => (
            <View key={a.name}>{i ? <Divider /> : null}
              <View className="flex-row items-center gap-s3 p-s3">
                <Avatar of={markRef(a.kind === "assistant" ? "assistant" : "teammate", a.name)} size={40} />
                <View className="min-w-0 flex-1 gap-s1">
                  <Text strong>{a.name}</Text>
                  <View className="flex-row flex-wrap gap-s2">{a.tags.slice(0, 4).map((t) => <Chip key={t}>{t}</Chip>)}</View>
                </View>
                <Button kind="ghost" size="sm" label="Ask" onPress={() => setSaid(askWords(a, "agent"))} />
              </View>
            </View>
          ))}
        </Card>
      ) : null}
      {mates.length ? (
        <Card flush>
          {mates.map((m, i) => (
            <View key={`${m.name}-${i}`}>{i ? <Divider /> : null}
              <View className="flex-row items-center gap-s3 p-s3">
                <Avatar of={markRef("teammate", m.name)} size={40} />
                <View className="min-w-0 flex-1 gap-s1"><Text strong>{m.name}</Text>{m.role ? <Text size="caption" tone="label">{m.role}</Text> : null}</View>
                <Button kind="ghost" size="sm" label="Ask" onPress={() => setSaid(askWords(m, "teammate"))} />
              </View>
            </View>
          ))}
        </Card>
      ) : null}
      {said ? <Text size="caption" tone="warn">{said}</Text> : null}
    </View>
  );
}
