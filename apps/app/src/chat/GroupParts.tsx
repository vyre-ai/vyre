// The small pieces a group message wears: the "New" divider, reactions, the pin mark, the thread
// line, the Reply / React / Pin tools, and the read-only card an approval becomes for a viewer who
// did not ask.

import { useState } from "react";
import { Pressable, View } from "react-native";
import { Chip, Icon, Text, useUiTheme } from "@vyre/ui";

export function UnreadDivider({ count }: { count: number }) {
  const { color } = useUiTheme();
  return (
    <View accessibilityRole="text" accessibilityLabel={`New, ${count} unread`} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: color.accent, opacity: 0.6 }} />
      <Text size="caption" strong tone="accent">New</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: color.accent, opacity: 0.6 }} />
    </View>
  );
}

export function Reactions({ items, onToggle, big }: { items: readonly { emoji: string; count: number; mine: boolean }[]; onToggle: (emoji: string, mine: boolean) => void; big: boolean }) {
  const { color } = useUiTheme();
  if (!items.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
      {items.map((r) => (
        <Pressable key={r.emoji} accessibilityRole="button" accessibilityState={{ selected: r.mine }} accessibilityLabel={`${r.emoji} ${r.count}`} onPress={() => onToggle(r.emoji, r.mine)} style={{ minHeight: big ? 36 : 26, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, borderRadius: 13, borderWidth: 1, borderColor: r.mine ? color.accent : color.edge, backgroundColor: r.mine ? color["accent-wash"] : "transparent" }}>
          <Text size="caption">{r.emoji}</Text>
          <Text size="caption" tone="muted" strong>{String(r.count)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const QUICK = ["\u{1F44D}", "✅", "\u{1F440}"];

/** Reply in a thread, React, Pin: three quiet words under a message. */
export function MessageTools({ big, pinned, onReply, onReact, onPin }: { big: boolean; pinned: boolean; onReply?: () => void; onReact?: (emoji: string) => void; onPin?: (pinned: boolean) => void }) {
  const { color } = useUiTheme();
  const [picking, setPicking] = useState(false);
  const h = big ? 44 : 28;
  const act = (label: string, run?: () => void) => run ? (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={run} style={({ pressed, hovered }: any) => ({ minHeight: h, justifyContent: "center", paddingHorizontal: 8, marginLeft: -8, borderRadius: 8, backgroundColor: pressed ? color.press : hovered ? color.hover : "transparent" })}>
      <Text size="caption" tone="label">{label}</Text>
    </Pressable>
  ) : null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2, flexWrap: "wrap" }}>
      {act("Reply", onReply)}
      {onReact ? (picking ? QUICK.map((e) => (
        <Pressable key={e} accessibilityRole="button" accessibilityLabel={`React ${e}`} onPress={() => { setPicking(false); onReact(e); }} style={{ minHeight: h, minWidth: h, alignItems: "center", justifyContent: "center" }}><Text>{e}</Text></Pressable>
      )) : act("React", () => setPicking(true))) : null}
      {act(pinned ? "Unpin" : "Pin", onPin && (() => onPin(!pinned)))}
    </View>
  );
}

/** An approval that is somebody else's: read-only, "waiting for Chris". */
export function WaitingCard({ title, who, by }: { title: string; who: string; by?: string }) {
  const { color } = useUiTheme();
  return (
    <View accessibilityLabel={`${title}, waiting for ${who}`} style={{ borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], borderRadius: 12, padding: 12, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="todo" />
        <Text strong numberOfLines={2} style={{ flex: 1 }}>{title}</Text>
        <Chip icon="clock">{`Waiting for ${who}`}</Chip>
      </View>
      <Text size="caption" tone="label">{by ? `${by} asked on ${who}'s behalf.` : `It goes to ${who}, who asked.`} You can read it; only they can approve it.</Text>
    </View>
  );
}
