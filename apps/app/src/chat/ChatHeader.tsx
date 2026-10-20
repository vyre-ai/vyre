// The chat header: ONE compact row. A back chevron, stacked faces (three, then "+n"), a one-line
// title, and one quiet line for the record and the space; on the right, where the chat runs ("Runs on") and the "..." menu. No state, no
// Stop. State and Stop live in the status line under the transcript (StatusLine.tsx). Tapping the
// row opens "About this chat" (AboutSheet.tsx).

import { Pressable, View, StyleSheet } from "react-native";
import { AvatarStack, Icon, IconButton, Menu, Text, markRef, useUiTheme } from "@vyre/ui";
import type { MenuItem } from "@vyre/ui";
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

export function ChatHeader({ title, participants, viewer, phone, onBack, onOpen, onOpenWho, menu, project, sub, place }: {
  /** Where the chat runs: the compact "Runs on" switch, beside the "..." menu (placement.tsx). */
  place?: React.ReactNode;
  /** A quiet word after the name: an agent chat's current thread. */
  sub?: string;
  /** The project the chat is in; its name follows the title on the same line. */
  project?: { slug: string; name: string } | null;
  title: string;
  participants: readonly Person[];
  viewer: string;
  phone: boolean;
  onBack?: () => void;
  /** One tap on the header opens the side panel. */
  onOpen: () => void;
  /** The name and avatar open the who's side pane (WhoPane) instead of the details panel; the details stay in the ... menu. */
  onOpenWho?: () => void;
  /** The ... menu: everything that is not the name. */
  menu?: MenuItem[];
}) {
  const { color } = useUiTheme();
  const stack = avatarStack(participants, viewer, 3);
  const lone = stack.shown.length === 1 ? stack.shown[0] : null;
  return (
    <View style={[S.bar, { paddingHorizontal: phone ? 4 : 16, backgroundColor: color["surface-1"], zIndex: 2 }]}>
      <View style={{ width: 88, flexDirection: "row", alignItems: "center" }}>
        {phone && onBack ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Back to chats" onPress={onBack} style={S.back}>
            <Icon name="chev-l" size={20} tone="text" />
          </Pressable>
        ) : null}
      </View>
      <View style={{ flex: 1, alignItems: "center", minWidth: 0 }}>
        {/* One small centred chip: the face (or the group's stack), the name and, quieter, the project. A tap opens the side panel. */}
        <Pressable accessibilityRole="button" accessibilityLabel={`${title}${project ? `, ${project.name}` : ""}. ${onOpenWho ? "Open the side pane" : "Open details"}`} onPress={onOpenWho ?? onOpen}
          style={({ hovered }: any) => [{ flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "100%", minHeight: 40, paddingLeft: 6, paddingRight: 14, borderRadius: 20, backgroundColor: hovered ? color.hover : color["surface-3"] }]}>
          {lone ? <Face name={lone.name} family={fam(lone.family)} size={28} id={lone.id} /> : <HeaderStack faces={stack.shown} more={stack.more} />}
          <Text numberOfLines={1} style={{ flexShrink: 1 }}>
            <Text medium>{title}</Text>
            {sub ? <Text tone="label">{`  ${sub}`}</Text> : project ? <Text tone="label">{`  ${project.name}`}</Text> : null}
          </Text>
        </Pressable>
      </View>
      <View style={{ minWidth: 88, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
        {place}
        {menu && menu.length ? <Menu align="end" trigger={<IconButton icon="more" label="More" kind="ghost" />} items={menu} /> : null}
        {!phone && onBack ? <IconButton icon="x" label="Close this chat" kind="ghost" onPress={onBack} /> : null}
      </View>
    </View>
  );
}
