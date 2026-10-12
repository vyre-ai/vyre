// "This Space's assistants and teammates" for a member of a joined team: read-only, with the gate's words when she tries to use one (nothing is started from here). The records are the ones the team's door lets a member read.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Divider, EmptyState, LoadingState, SpaceTag, Text, markRef } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { PlaceTag, usePlaceText } from "../../src/real/PlaceTag";
import { showingJoined } from "../../src/real/team-join";
import { askWords, spaceAgents } from "./space-agents-model.js";

export function SpaceAssistants() {
  const agentTag = usePlaceText("showing") ?? "";
  const [joined, setJoined] = useState(false);
  const [agents, setAgents] = useState<ReturnType<typeof spaceAgents> | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    void showingJoined().catch(() => false).then(async (j) => {
      setJoined(j);
      if (!j) return;
      const a = await callT("agents.roster", {});
      setAgents(a.error ? [] : spaceAgents(a.data));
    });
  }, []);
  if (!joined) return null;
  return (
    <View className="gap-s2">
      <View className="flex-row flex-wrap items-center gap-s2"><Text size="caption" strong tone="label">This Space's assistants</Text><PlaceTag of="showing" /></View>
      {agents === null ? <LoadingState rows={2} /> : null}
      {agents && !agents.length ? <Card><EmptyState title="Nothing to show yet" body="The team's assistants show here when the owner adds them." /></Card> : null}
      {agents && agents.length ? (
        <Card flush>
          {agents.map((a, i) => (
            <View key={a.name}>{i ? <Divider /> : null}
              <View className="flex-row items-center gap-s3 p-s3">
                <Avatar of={markRef(a.kind === "assistant" ? "assistant" : "teammate", a.name)} size={40} />
                <View className="min-w-0 flex-1 gap-s1">
                  <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{a.name}</Text>{agentTag ? <SpaceTag text={agentTag} /> : null}</View>
                  <View className="flex-row flex-wrap gap-s2">{[a.role, a.model, a.status].filter(Boolean).map((t: string) => <Chip key={t}>{t}</Chip>)}</View>
                </View>
                <Button kind="ghost" size="sm" label="Ask" onPress={() => setSaid(askWords(a, "agent"))} />
              </View>
            </View>
          ))}
        </Card>
      ) : null}
      {said ? <Text size="caption" tone="warn">{said}</Text> : null}
    </View>
  );
}
