import { View } from "react-native";
import { Text } from "./Text";

/** One event: who, what, when. Drawn from the Event log. */
export function TimelineItem({ actor, what, at, why }: { actor: string; what: string; at: string; why?: string }) {
  return (
    <View className="flex-row gap-s3 py-s2">
      <View className="mt-s2 h-s2 w-s2 flex-none rounded-full bg-edge-strong" />
      <View className="min-w-0 flex-1">
        <Text><Text strong>{actor}</Text>{" "}{what}</Text>
        {why ? <Text size="caption" tone="muted">{why}</Text> : null}
        <Text size="caption" tone="label">{at}</Text>
      </View>
    </View>
  );
}
