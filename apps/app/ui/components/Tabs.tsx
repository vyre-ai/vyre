import { ScrollView, View } from "react-native";
import * as P from "@rn-primitives/tabs";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { useUiTheme } from "../theme";
import { px } from "../lib/measure";

/** Named views of one place. A row of labels with the current one underlined; the panels are the caller's. */
export function Tabs<T extends string>({ items, value, onChange }: { items: [T, string][]; value: T; onChange: (v: T) => void }) {
  const { map, color } = useUiTheme();
  // Style props, not className: @rn-primitives drops className on the web.
  return (
    <P.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="border-b border-edge flex-none grow-0">
        <P.List style={{ flexDirection: "row", gap: px(map, "--s-1") }}>
          {items.map(([id, l]) => (
            <P.Trigger key={id} value={id} style={{ minHeight: px(map, "--control"), justifyContent: "center", paddingHorizontal: px(map, "--s-3") }}>
              <View className="items-center">
                <Text medium style={{ fontSize: 15, lineHeight: 20 }} tone={id === value ? "default" : "muted"}>{l}</Text>
                <View style={{ position: "absolute", bottom: -1, left: 0, right: 0, height: 2, borderRadius: 1, backgroundColor: id === value ? color.accent : "transparent" }} />
              </View>
            </P.Trigger>
          ))}
        </P.List>
      </ScrollView>
    </P.Root>
  );
}
