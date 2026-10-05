// Chat's one face: @vyre/ui's Avatar for people, assistants, teammates and agents. A model (Sonnet, Opus, GPT, Grok) is its provider's own mark in a quiet circle, and a reply that says which provider wrote it
// carries that mark at its avatar's lower right. A model whose provider the name does not tell gets a letter, never a guess.

import { View } from "react-native";
import { Avatar, ProviderBadge, Text, markRef, providerOfModel, useUiTheme } from "@vyre/ui";
import { badgeSize } from "@vyre/ui/marks/provider.js";

export type FaceSize = 16 | 20 | 24 | 28 | 32 | 40 | 44 | 56;
export type FaceFamily = "person" | "assistant" | "model" | "agent" | "teammate";

export function Face({ name, family = "person", size = 32, id, provider }: { name: string; family?: FaceFamily | string; size?: FaceSize; id?: string; /** The provider that wrote this reply, when the frame says. */ provider?: string | null }) {
  const { color } = useUiTheme();
  if (family === "model") {
    const p = provider ?? providerOfModel(name);
    if (p) return <ProviderBadge provider={p} model={name} size={size} />;
    return (
      <View accessibilityLabel={name} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.hover, alignItems: "center", justifyContent: "center" }}>
        <Text strong size="caption" tone="muted">{(name.trim()[0] ?? "?").toUpperCase()}</Text>
      </View>
    );
  }
  const kind = family === "assistant" ? "assistant" : family === "teammate" ? "teammate" : family === "agent" ? "agent" : "person";
  const face = <Avatar of={markRef(kind, name, id ?? name)} size={size} />;
  if (!provider || family === "person") return face;
  return <View style={{ width: size, height: size }}>{face}<ProviderBadge provider={provider} size={badgeSize(size)} onAvatar /></View>;
}
