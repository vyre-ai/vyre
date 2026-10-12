import { View } from "react-native";
import { Text } from "./Text";

/**
 * Words two devices both show so a person can see they are talking to each other (the four words of a space, the three words of a sign-in). Large, in order, one tile each,
 * with the instruction under them. Never read as one phrase: the tiles are numbered for a screen reader.
 */
export function MatchWords({ words, label, note }: { words: string[]; label?: string; note?: string }) {
  return (
    <View className="gap-s2" accessible accessibilityLabel={`${label ?? "Words"}: ${words.map((w, i) => `${i + 1}, ${w}`).join(", ")}`}>
      {label ? <Text size="caption" strong tone="label">{label}</Text> : null}
      <View className="flex-row flex-wrap gap-s2">
        {words.map((w) => (
          <View key={w} className="rounded-field border border-edge-strong bg-surface-3 px-s4 py-s2">
            <Text size="headline" strong>{w}</Text>
          </View>
        ))}
      </View>
      {note ? <Text size="caption" tone="muted">{note}</Text> : null}
    </View>
  );
}
