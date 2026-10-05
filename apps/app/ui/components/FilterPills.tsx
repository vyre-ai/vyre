import { Pressable, View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";

/** A row of filter pills, one on (All spaces, Mine, Juniper Studio). Wraps on a narrow screen. Narrowing a list; for switching views use Tabs or Segmented. */
export function FilterPills<T extends string>({ options, value, onChange, label }: { options: [T, string][]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} className="flex-row flex-wrap gap-s2">
      {options.map(([v, l]) => (
        <Pressable key={v} accessibilityRole="radio" accessibilityState={{ selected: v === value }} onPress={() => onChange(v)}
          className={cn("min-h-control-sm items-center justify-center rounded-full border px-s4", v === value ? "border-transparent bg-primary" : "border-edge-strong bg-transparent")}>
          <Text strong tone={v === value ? "inverse" : "muted"}>{l}</Text>
        </Pressable>
      ))}
    </View>
  );
}
