import { View } from "react-native";
import { cn } from "../lib/cn";
import { passwordStrength } from "../lib/strength.js";
import { Text } from "./Text";

const FILL = ["bg-edge", "bg-err", "bg-warn", "bg-primary", "bg-ok"] as const;

/**
 * How strong a master password is: four steps and the level in words ("Good"). Colour is never the only signal.
 * The screen asks for Good or better before it continues. `passwordStrength` is the one scoring rule.
 */
export function PasswordStrength({ value }: { value: string }) {
  const s = passwordStrength(value);
  return (
    <View className="min-w-0 flex-1 flex-row items-center gap-s2" accessibilityRole="progressbar" accessibilityLabel={`Password strength: ${s.label || "none yet"}`} accessibilityValue={{ min: 0, max: 4, now: s.score }}>
      {[1, 2, 3, 4].map((i) => <View key={i} className={cn("h-s1 flex-1 rounded-full", i <= s.score ? FILL[s.score] : "bg-edge")} />)}
      <Text size="caption" tone="muted" className="min-w-0">{s.label}</Text>
    </View>
  );
}
