// Chat's one face: @vyre/ui's Avatar for people, assistants, teammates and agents. Models (Sonnet, Opus,
// Local) have no art yet, so they get a letter in a quiet circle here and nowhere else.

import { View } from "react-native";
import { Avatar, Text, markRef, useUiTheme } from "@vyre/ui";

export type FaceSize = 16 | 20 | 24 | 28 | 32 | 40 | 44 | 56;
export type FaceFamily = "person" | "assistant" | "model" | "agent" | "teammate";

export function Face({ name, family = "person", size = 32, id }: { name: string; family?: FaceFamily | string; size?: FaceSize; id?: string }) {
  const { color } = useUiTheme();
  if (family === "model") {
    return (
      <View accessibilityLabel={name} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.hover, alignItems: "center", justifyContent: "center" }}>
        <Text strong size="caption" tone="muted">{(name.trim()[0] ?? "?").toUpperCase()}</Text>
      </View>
    );
  }
  const kind = family === "assistant" ? "assistant" : family === "teammate" ? "teammate" : family === "agent" ? "agent" : "person";
  return <Avatar of={markRef(kind, name, id ?? name)} size={size} />;
}
