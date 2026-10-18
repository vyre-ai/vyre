// "Earlier in the original": what a forked thread was cut from, dimmed and read-only, ending in a "Forked here" divider. Drawn beside the thread, not in it: it is read once from the origin and never enters the thread's store.
import { ScrollView, View } from "react-native";
import { Button, Text, useUiTheme } from "@vyre/ui";
import type { OriginRow } from "./origin-history.js";

export function OriginBlock({ rows, title, phone, onHide }: { rows: OriginRow[]; title: string; phone: boolean; onHide: () => void }) {
  const { color } = useUiTheme();
  return (
    <View accessibilityLabel="Earlier in the original" style={{ paddingHorizontal: phone ? 12 : 24, paddingBottom: 6 }}>
      <View style={{ borderWidth: 1, borderColor: color.edge, borderRadius: 12, backgroundColor: color["surface-2"], overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 8 }}>
          <Text tone="muted" size="caption">{`Earlier in ${title}`}</Text>
          <Button kind="ghost" size="sm" label="Hide" onPress={onHide} />
        </View>
        <ScrollView style={{ maxHeight: 240 }} contentContainerStyle={{ padding: 12, gap: 8, opacity: 0.65 }}>
          {rows.map((r) => (
            <View key={r.id + r.role} style={{ alignSelf: r.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: r.role === "user" ? color.edge : "transparent" }}>
              <Text>{r.text}</Text>
            </View>
          ))}
        </ScrollView>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 8 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: color.edge }} />
          <Text tone="muted" size="caption">Forked here</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: color.edge }} />
        </View>
      </View>
    </View>
  );
}
