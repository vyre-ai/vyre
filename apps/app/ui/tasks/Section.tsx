import { View } from "react-native";
import { Text } from "../components/Text";

/** A titled block of a screen: a small label (with a count) over its content. */
export function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <View className="min-w-0 gap-s2">
      <Text strong tone="muted">{count === undefined ? title : `${title} · ${count}`}</Text>
      {children}
    </View>
  );
}
