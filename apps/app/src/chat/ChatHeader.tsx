// The chat header: ONE compact row. A back chevron, stacked faces (three, then "+n"), a one-line
// title, and one quiet line for the record and the space. Nothing else: no chips, no state, no
// Stop. State and Stop live in the status line under the transcript (StatusLine.tsx). Tapping the
// row opens "About this chat" (AboutSheet.tsx).

import { Pressable, View, StyleSheet } from "react-native";
import { Icon, Text, useUiTheme } from "@vyre/ui";
import { ChatAvatar } from "./ChatAvatar";
import { avatarStack } from "./group.js";

const S = StyleSheet.create({
  s1: { width: 8 },
  s2: { flex: 1, minWidth: 0 },
});


type Face = { id: string; name: string; family: string };

const avatarFamily = (f: string) => (f === "assistant" ? "assistant" : f === "model" ? "agent" : "person");

export function AvatarStack({ faces, more, size = "sm" }: { faces: readonly Face[]; more: number; size?: "sm" | "md" }) {
  const { color } = useUiTheme();
  const ring = size === "sm" ? 16 : 20;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: ring / 2 }}>
      {faces.map((f, i) => (
        <View key={f.id} style={{ marginLeft: i === 0 ? 0 : -8, borderRadius: 16, borderWidth: 2, borderColor: color["surface-1"], backgroundColor: color["surface-1"] }}>
          <ChatAvatar name={f.name} family={avatarFamily(f.family)} size={size} />
        </View>
      ))}
      {more > 0 ? (
        <View accessibilityLabel={`${more} more`} style={{ marginLeft: -8, minWidth: 28, height: 28, paddingHorizontal: 4, borderRadius: 14, borderWidth: 2, borderColor: color["surface-1"], backgroundColor: color.hover, alignItems: "center", justifyContent: "center" }}>
          <Text size="caption" strong tone="muted">{`+${more}`}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function ChatHeader({ title, participants, viewer, line, phone, onBack, onOpen }: {
  title: string;
  participants: readonly Face[];
  viewer: string;
  /** The one quiet line: the record and the space ("Northwind Bakery, lease dispute · Harlow Legal"). */
  line?: string;
  phone: boolean;
  onBack?: () => void;
  onOpen: () => void;
}) {
  const { color } = useUiTheme();
  const stack = avatarStack(participants, viewer, 3);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 56, paddingHorizontal: phone ? 4 : 12, borderBottomWidth: 1, borderBottomColor: color.edge }}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Back to chats" onPress={onBack} style={({ pressed, hovered }: any) => ({ width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: pressed ? color.press : hovered ? color.hover : "transparent" })}>
          <Icon name="chev-l" size={20} tone="text" />
        </Pressable>
      ) : <View style={S.s1} />}
      <Pressable accessibilityRole="button" accessibilityLabel={`About this chat: ${title}`} onPress={onOpen} style={({ pressed, hovered }: any) => ({ flex: 1, minWidth: 0, minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 8, borderRadius: 12, backgroundColor: pressed ? color.press : hovered ? color.hover : "transparent" })}>
        <AvatarStack faces={stack.shown} more={stack.more} size="md" />
        <View style={S.s2}>
          <Text strong numberOfLines={1}>{title}</Text>
          {line ? <Text size="caption" tone="label" numberOfLines={1}>{line}</Text> : null}
        </View>
      </Pressable>
    </View>
  );
}
