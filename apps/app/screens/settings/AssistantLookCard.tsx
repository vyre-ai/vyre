// Settings > Account: you and your Assistant. Your avatar as it is drawn now, and the Assistant: its face, its name, and a button that opens the same look picker first run uses (LookSheet, one
// component), so the person can change how it looks after setup. The Assistant's name is its identity on the box (chats, files and its signed work carry it), so it is shown, not edited here.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Row, Text, markRef, showToast } from "@vyre/ui";
import { Group } from "../places/Frame";
import { LookSheet } from "../assistants/AgentPage";
import { agentsList } from "./real";
import type { AgentFull } from "../assistants/agent-model.ts";

/** The person's own name for their avatar line (what the identity or the sample world calls them). */
export function AssistantLookCard({ person }: { person: string }) {
  const [assistant, setAssistant] = useState<AgentFull | null | undefined>(undefined);
  const [looking, setLooking] = useState(false);
  const load = useCallback(() => { agentsList().then((l) => setAssistant((l as AgentFull[]).find((x) => x.kind === "assistant") ?? null)).catch(() => setAssistant(null)); }, []);
  useEffect(load, [load]);
  return (
    <Group title="You and your Assistant" note="How you and your Assistant are drawn, in chats and everywhere your name shows.">
      <Card flush>
        <Row lead={<Avatar of={markRef("person", person)} size={48} />} title={person} sub="You. Drawn from your name." />
        {assistant ? (
          <Row lead={<Avatar of={markRef("agent", assistant.name, undefined, assistant.look || undefined)} size={48} />} title={assistant.name} sub="Your Assistant"
            end={<Button size="sm" kind="ghost" icon="face" label="Change its look" onPress={() => setLooking(true)} />} />
        ) : assistant === null ? <View className="p-s3"><Text tone="muted">Your Assistant has not been made yet. It is made when you finish setup.</Text></View> : null}
      </Card>
      {assistant ? <LookSheet a={assistant} open={looking} onClose={() => setLooking(false)} onSaved={(look) => { setAssistant({ ...assistant, look }); setLooking(false); showToast("Saved. Your Assistant looks different now."); }} /> : null}
    </Group>
  );
}
