// What is connected, one row each: its name, what it is, how it is doing, and where it lives. Tapping a row opens its own tab.
import { View } from "react-native";
import { Button, Card, Divider, Row, Text } from "@vyre/ui";
import { connectedKind, connectedLine, type Connected } from "./any-app";

export function ConnectedList({ list, onOpen }: { list: Connected[]; onOpen: (c: Connected) => void }) {
  return (
    <Card flush>
      {list.map((c, i) => (
        <View key={c.key}>{i ? <Divider /> : null}
          <Row title={<View className="flex-row items-center gap-s2"><Text strong>{c.label}</Text><Text tone="muted" size="caption">{connectedKind(c)}</Text></View>}
            sub={<View className="gap-s1 pt-s1"><Text size="secondary" tone={c.status === "ok" ? undefined : "muted"}>{connectedLine(c)}</Text>
              {c.where ? <Text size="caption" tone="muted" mono>{c.where}</Text> : null}
              <View className="self-start"><Button size="sm" kind="ghost" label="Open" onPress={() => onOpen(c)} /></View></View>} />
        </View>
      ))}
    </Card>
  );
}
