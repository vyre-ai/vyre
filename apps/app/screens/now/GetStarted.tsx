import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Divider, Text } from "@vyre/ui";
import type { Step } from "./get-started.js";

/** One quiet card for a new box: the steps to do, each with its own button. */
export function GetStarted({ title, steps }: { title: string; steps: Step[] }) {
  const router = useRouter();
  return (
    <Card className="gap-s3">
      <Text strong>{title}</Text>
      {steps.map((s, i) => (
        <View key={s.route}>
          {i ? <Divider /> : null}
          <View className="gap-s2 pt-s2">
            <Text strong>{`${i + 1}. ${s.title}`}</Text>
            <Text tone="muted">{s.line}</Text>
            <View className="flex-row"><Button size="sm" kind={i === 0 ? "primary" : "secondary"} label={s.action} onPress={() => router.push(s.route as never)} /></View>
          </View>
        </View>
      ))}
    </Card>
  );
}
