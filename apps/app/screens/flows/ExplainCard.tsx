// "In plain words" on a Flow run: why it ran, what it did, where it stands, from the box (flows.describe, the run's own explanation). Nothing here is written by the app.
import { View } from "react-native";
import { Card, Icon, Text } from "@vyre/ui";

export function ExplainCard({ text }: { text: string }) {
  if (!text) return null;
  return (
    <Card>
      <View className="gap-s2">
        <View className="flex-row items-center gap-s2"><Icon name="spark" tone="accent" /><Text strong size="secondary">Explain this run</Text></View>
        <Text selectable>{text}</Text>
      </View>
    </Card>
  );
}
