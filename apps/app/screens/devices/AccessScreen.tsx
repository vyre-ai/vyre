import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Button, Card, Chip, Divider, EmptyState, Segmented, Text, showToast, markRef, IconTile } from "@vyre/ui";
import { Page } from "../places/Frame";
import { ACCESS_FILTERS, glyph } from "./data";
import { useDevices } from "./state";
import { removeText } from "./wink.js";

/** Everything that can reach your things: devices, people, assistants, Kits and Flows, with a held Remove. */
export function AccessScreen() {
  const router = useRouter();
  const { items, removeItem } = useDevices();
  const [f, setF] = useState("all");
  const rows = items.filter((i) => f === "all" || i.kind === f);
  return (
    <Page title="Access" sub="Who and what can reach your spaces." back="/u/settings"
      actions={<Button kind="primary" size="sm" icon="plus" label="Add or invite" onPress={() => router.push("/u/wink" as never)} />}>
      <Segmented label="Show" value={f} onChange={setF} options={ACCESS_FILTERS} />
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
              <View className="flex-row"><Button kind="hold" size="sm" label={`Remove ${a.name}`} onPress={() => { removeItem(a.id); showToast(`${a.name} was removed.`); }} /></View>
            </View>
          </View>
        )) : <EmptyState title="Nothing here" body="Nothing of this kind can reach your spaces." />}
      </Card>
    </Page>
  );
}
