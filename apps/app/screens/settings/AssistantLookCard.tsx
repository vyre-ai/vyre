// Your assistant on Your profile: its face, its name, and the same look picker first run uses. The name is its identity in chats, files and signed work, so it is shown, not edited here.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Text, markRef, showToast } from "@vyre/ui";
import { Group } from "../places/Frame";
import { LookSheet } from "../assistants/AgentPage";
import { displayName } from "../../src/state/agent-name.js";
import { agentsList } from "./real";
import type { AgentFull } from "../assistants/agent-model.ts";

export function AssistantLookCard() {
  const [assistant, setAssistant] = useState<AgentFull | null | undefined>(undefined);
  const [looking, setLooking] = useState(false);
  const load = useCallback(() => { agentsList().then((l) => setAssistant((l as AgentFull[]).find((x) => x.kind === "assistant") ?? null)).catch(() => setAssistant(null)); }, []);
  useEffect(load, [load]);
  const shown = assistant ? displayName(assistant) : "";
  return (
    <Group title="Your assistant" note="Its face and its name, in chats and everywhere it shows.">
      <Card>
        {assistant ? (
          <View className="flex-row flex-wrap items-center gap-s3">
            <Avatar of={markRef("agent", assistant.name, undefined, assistant.look || undefined)} size={44} />
            <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 120 }}><Text strong numberOfLines={1}>{shown}</Text></View>
            <Button size="sm" kind="ghost" icon="spark" label="Change its look" className="self-start" onPress={() => setLooking(true)} />
          </View>
        ) : assistant === null ? <Text tone="muted">Your assistant has not been made yet. It is made when you finish setup.</Text> : null}
      </Card>
      {assistant ? <LookSheet a={assistant} open={looking} onClose={() => setLooking(false)} onSaved={(look) => { setAssistant({ ...assistant, look }); setLooking(false); showToast("Saved. Your assistant looks different now."); }} /> : null}
    </Group>
  );
}
