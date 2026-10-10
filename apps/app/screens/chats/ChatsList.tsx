// The list of chats: who is in each, what it is about, where it runs, its state and when it last moved. A row for a chat you are not in is dim and does not open.
import { View } from "react-native";
import { AvatarStack, Card, Chip, Divider, ProviderBadge, Row, Text, markRef } from "@vyre/ui";
import { ageOf } from "./chat-model.js";
import { chatState, chatSub, computerOf, type ChatRow } from "./chats-model.js";

export function ChatsList({ rows, now, places, onOpen }: { rows: ChatRow[]; now: number; places: unknown; onOpen: (id: string) => void }) {
  return (
    <Card flush>
      {rows.map((t, i) => (
        <View key={t.id} style={t.open ? undefined : { opacity: 0.5 }}>
          {i ? <Divider /> : null}
          <Row lead={<AvatarStack of={[...t.people.map((n) => markRef("person", n)), ...t.agents.map((n) => markRef("assistant", n))]} size={40} max={3} />} title={t.pinned === "assistant" ? "Your assistant" : t.title} sub={t.pinned === "assistant" ? "Always here. Lumen talks to this chat too." : chatSub(t, computerOf(places, t.id))}
            end={<>{t.providers.map((p) => <ProviderBadge key={p} provider={p} size={16} />)}{chatState(t) === "needs-you" ? <Chip tone="accent">Needs you</Chip> : chatState(t) === "failed" ? <Chip tone="warn">Failed</Chip> : null}{t.unread > 0 ? <Chip tone="accent">{t.unread > 99 ? "99+" : String(t.unread)}</Chip> : null}{t.last ? <Text size="caption" tone="label">{ageOf(t.last, now)}</Text> : null}</>}
            onPress={t.open ? () => onOpen(t.id) : undefined} />
        </View>
      ))}
    </Card>
  );
}
