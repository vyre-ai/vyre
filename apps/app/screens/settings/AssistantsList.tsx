// The assistants of this space, one row each: who, whether it is paused, what it does, and a Pause or Resume. Tapping Open goes to its page.
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Divider, Text, markRef } from "@vyre/ui";
import { agentLine, isStopped, roleOf, type Agent } from "./agents-model";

export function AssistantsList({ list, busy, onFlip, onOpen }: { list: Agent[]; busy: string | null; onFlip: (a: Agent) => void; onOpen: (a: Agent) => void }) {
  return (
    <Card flush>
      {list.map((a, i) => (
        <View key={a.name}>{i ? <Divider /> : null}
          <View className="flex-row items-center gap-s3 p-s3">
            <Avatar of={markRef(a.kind === "assistant" ? "assistant" : "teammate", a.name)} size={40} />
            <View className="min-w-0 flex-1 gap-s1">
              <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{a.name}</Text>{isStopped(a) ? <Chip tone="warn">Paused</Chip> : null}</View>
              <Text size="caption" tone="label">{`${roleOf(a)}. ${agentLine(a)}`}</Text>
            </View>
            {a.thread ? <Button kind="ghost" size="sm" label={isStopped(a) ? "Resume" : "Pause"} disabled={busy === a.name} onPress={() => onFlip(a)} /> : null}
            <Button kind="secondary" size="sm" label="Open" onPress={() => onOpen(a)} />
          </View>
        </View>
      ))}
    </Card>
  );
}
