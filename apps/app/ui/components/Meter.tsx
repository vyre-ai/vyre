import { View } from "react-native";
import { cn } from "../lib/cn";

/** A bar that shows how much of a whole is used (a budget). `value` is 0 to 1; over 0.9 it turns warm, over 1 it turns red. The words around it say the numbers. */
export function Meter({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }} className="h-s2 overflow-hidden rounded-full bg-surface-3">
      <View className={cn("h-full rounded-full", value > 1 ? "bg-err" : value > 0.9 ? "bg-warn" : "bg-accent")} style={{ width: `${v * 100}%` }} />
    </View>
  );
}
