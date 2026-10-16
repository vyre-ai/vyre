import type { ReactNode } from "react";
import { View } from "react-native";
import { Card, Text } from "../index";

/** Gallery and panel wrapper: one heading and a flush card around ForkRows. */
export function ChatForkPanel({ title = "Rewind, fork, and move", children }: { title?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text strong>{title}</Text>
      <Card flush>{children}</Card>
    </View>
  );
}
