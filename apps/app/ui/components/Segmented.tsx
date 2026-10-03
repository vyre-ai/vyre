import { Pressable, View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";

/** 2 to 5 choices, one on. Wraps on narrow screens, never scrolls. */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: [T, string][]; value?: T; onChange?: (v: T) => void; label?: string }) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} className="max-w-full flex-row flex-wrap self-start gap-s1 rounded-card border border-edge bg-surface-3 p-s1">
      {options.map(([v, l]) => (
        <Pressable key={v} accessibilityRole="radio" accessibilityState={{ selected: v === value }} onPress={() => onChange?.(v)}
          className={cn("h-control-sm items-center justify-center rounded-row px-s3", v === value ? "bg-surface-1" : "bg-transparent")}>
          <Text strong={v === value} tone={v === value ? "default" : "muted"}>{l}</Text>
        </Pressable>
      ))}
    </View>
  );
}
