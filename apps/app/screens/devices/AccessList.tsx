// Everything that can reach your spaces, one row each: who or what, what it may do, since when, and a held Remove with what it does said first.
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Divider, EmptyState, IconTile, Text, markRef } from "@vyre/ui";
import { glyph, type AccessItem } from "./data";
import { removeText } from "./wink.js";

export function AccessList({ rows, empty, onRemove }: { rows: AccessItem[]; empty: string; onRemove: (a: AccessItem) => void }) {
  return (
    <Card flush>
      {rows.length ? rows.map((a, i) => (
        <View key={a.id}>
          {i ? <Divider /> : null}
          <View className="gap-s2 p-s3">
            <View className="flex-row items-center gap-s3">
              {a.kind === "Kit" || a.kind === "Flow" ? <IconTile name={glyph(a) ?? "kits"} size={40} /> : <Avatar of={{ ...markRef(a.family, a.name, a.id), device: a.device }} size={40} />}
              <View className="min-w-0 flex-1 gap-s1">
                <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{a.name}</Text><Chip>{a.kind}</Chip></View>
                <Text tone="muted">{a.allows}</Text>
                <Text size="caption" tone="label">{`Since ${a.since} · last used ${a.last}`}</Text>
              </View>
            </View>
            <Text size="caption" tone="label">{removeText(a.kind, a.name)}</Text>
            <View className="flex-row"><Button kind="hold" size="sm" label={`Remove ${a.name}`} onPress={() => onRemove(a)} /></View>
          </View>
        </View>
      )) : <EmptyState title="Nothing here" body={empty} />}
    </Card>
  );
}
