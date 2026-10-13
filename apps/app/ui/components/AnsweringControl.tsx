import { Pressable, View } from "react-native";
import { useUiTheme } from "../theme";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { ProviderBadge } from "./ProviderBadge";
import { providerOfModel } from "../marks/provider.js";
import { Avatar, type AvatarSize } from "./Avatar";
import { markRef } from "../marks/useMark";

export type AnsweringAi = { id: string; label: string; provider?: string | null };

/** The provider mark for one AI: its own provider, else the one its name tells, else a letter. */
export function AiMark({ ai, size = 22 }: { ai: AnsweringAi; size?: number }) {
  const { color } = useUiTheme();
  const p = ai.provider ?? providerOfModel(ai.label);
  if (p) return <ProviderBadge provider={p} model={ai.label} size={size} />;
  // An assistant with no provider (juno) is drawn as its own face, as everywhere else in the chat.
  if (ai.id) return <Avatar of={markRef("assistant", ai.label, ai.id)} size={size as AvatarSize} />;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.hover, alignItems: "center", justifyContent: "center" }}><Text strong size="caption" tone="muted">{(ai.label.trim()[0] ?? "?").toUpperCase()}</Text></View>;
}

/**
 * The one control for who answers: the stacked marks of the AIs that will reply and, beside them, the words ("Claude", "Claude and Codex", "Everyone"). Press opens the Answering list.
 * 36 high on a desktop, 44 on a phone. `hint` is the shortcut for the tooltip.
 */
export function AnsweringControl({ ais, summary, open, onPress, hint, people }: { ais: readonly AnsweringAi[]; summary: string; /** A chat between people: no AI marks, a people icon. */ people?: boolean; open?: boolean; onPress: () => void; hint?: string }) {
  const { color, phone } = useUiTheme();
  const shown = ais.slice(0, 3);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Answering: ${summary}. ${hint ?? ""}`.trim()}
      accessibilityState={{ expanded: !!open }}
      onPress={onPress}
      style={{ minHeight: phone ? 44 : 36, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, borderRadius: 18, backgroundColor: open ? color.hover : "transparent" }}
    >
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        {people ? <Icon name="users" size={18} /> : null}
        {shown.map((a, i) => <View key={a.id} style={{ marginLeft: i ? -8 : 0, borderRadius: 12, borderWidth: 2, borderColor: color["surface-2"], zIndex: shown.length - i }}><AiMark ai={a} size={22} /></View>)}
      </View>
      <Text size="caption" medium tone="muted" numberOfLines={1} style={{ maxWidth: 180 }}>{summary}</Text>
      <View style={{ transform: [{ rotate: open ? "-90deg" : "90deg" }] }}><Icon name="chev" size={12} tone="label" /></View>
    </Pressable>
  );
}
