import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "../components/Text";

/** A section on the record page: a hairline, then a muted heading. No card. */
export function RecordSection({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <View className="pt-s6">
      <View className="h-px bg-edge" />
      <View className="flex-row flex-wrap items-center justify-between gap-s3 py-s3">
        <Text size="secondary" tone="label" medium accessibilityRole="header">{title}</Text>
        {action}
      </View>
      <View className="gap-s2">{children}</View>
    </View>
  );
}
