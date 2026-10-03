import { ScrollView, View } from "react-native";
import * as P from "@rn-primitives/tabs";
import { cn } from "../lib/cn";
import { Text } from "./Text";

/** Named views of one place. A row of labels with the current one underlined; the panels are the caller's. */
export function Tabs<T extends string>({ items, value, onChange }: { items: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <P.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="border-b border-edge flex-none grow-0">
        <P.List className="flex-row gap-s1">
          {items.map(([id, l]) => (
            <P.Trigger key={id} value={id} className="min-h-control justify-center px-s3">
              <View className="items-center">
                <Text strong={id === value} tone={id === value ? "default" : "muted"}>{l}</Text>
                <View className={cn("absolute -bottom-px left-0 right-0 h-s1 rounded-chip", id === value ? "bg-text" : "bg-transparent")} />
              </View>
            </P.Trigger>
          ))}
        </P.List>
      </ScrollView>
    </P.Root>
  );
}
