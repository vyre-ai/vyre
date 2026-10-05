// The chat header: ONE compact row. A back chevron, stacked faces (three, then "+n"), a one-line
// title, and one quiet line for the record and the space. Nothing else: no chips, no state, no
// Stop. State and Stop live in the status line under the transcript (StatusLine.tsx). Tapping the
// row opens "About this chat" (AboutSheet.tsx).

import { Pressable, View, StyleSheet } from "react-native";
import { AvatarStack, Icon, Text, markRef, useUiTheme } from "@vyre/ui";
import { Face } from "./Face";
import { avatarStack } from "./group.js";

const S = StyleSheet.create({
  s1: { width: 8 },
  s2: { flex: 1, minWidth: 0 },
  stack: { flexDirection: "row", alignItems: "center", gap: 6 },
  bar: { flexDirection: "row", alignItems: "center", minHeight: 56 },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22 },
  open: { flex: 1, minWidth: 0, minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 8, borderRadius: 12 },
});


type Person = { id: string; name: string; family: string };

const fam = (f: string) => (f === "assistant" ? "assistant" : f === "model" ? "model" : "person");

/** Faces overlap by 10; three, then "+n". @vyre/ui's AvatarStack draws it; a model has no art yet, so a stack with one draws the same overlap with Face. */
export function HeaderStack({ faces, more }: { faces: readonly Person[]; more: number }) {
  const { color } = useUiTheme();
  if (!faces.some((f) => f.family === "model")) {
    return (
      <View style={S.stack}>
        <AvatarStack of={faces.map((f) => markRef(f.family === "assistant" ? "assistant" : "person", f.name, f.id))} size={32} max={3} />
        {more > 0 ? <Text size="caption" tone="label">{`+${more}`}</Text> : null}
      </View>
    );
  }
  return (
    <View style={S.stack}>
      {faces.map((f, i) => (
        <View key={f.id} style={{ marginLeft: i === 0 ? 0 : -10, borderRadius: 18, borderWidth: 2, borderColor: color["surface-1"], backgroundColor: color["surface-1"] }}>
          <Face name={f.name} family={fam(f.family)} size={32} id={f.id} />
        </View>
      ))}
      {more > 0 ? <Text size="caption" tone="label">{`+${more}`}</Text> : null}
    </View>
  );
}

export function ChatHeader({ title, participants, viewer, line, phone, onBack, onOpen, onTools }: {
  title: string;
  participants: readonly Person[];
  viewer: string;
  /** The one quiet line: the record and the space ("Northwind Bakery, lease dispute · Harlow Legal"). */
  line?: string;
  phone: boolean;
  onBack?: () => void;
  onOpen: () => void;
  /** The chat tools sheet (fork, effort, mode, mention, context, transcript). */
  onTools?: () => void;
}) {
  const { color } = useUiTheme();
  const stack = avatarStack(participants, viewer, 3);
  return (
    <View style={[S.bar, { paddingHorizontal: phone ? 4 : 12, borderBottomWidth: 1, borderBottomColor: color.edge, backgroundColor: color["surface-1"], zIndex: 2 }]}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Back to chats" onPress={onBack} style={S.back}>
          <Icon name="chev-l" size={20} tone="text" />
        </Pressable>
      ) : <View style={S.s1} />}
      <Pressable accessibilityRole="button" accessibilityLabel={`About this chat: ${title}`} onPress={onOpen} style={S.open}>
        <HeaderStack faces={stack.shown} more={stack.more} />
        <View style={S.s2}>
          <Text strong numberOfLines={1}>{title}</Text>
          {line ? <Text size="caption" tone="label" numberOfLines={1}>{line}</Text> : null}
        </View>
      </Pressable>
      {onTools ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Chat tools" onPress={onTools} style={S.back}>
          <Icon name="more" size={20} tone="text" />
        </Pressable>
      ) : null}
    </View>
  );
}
