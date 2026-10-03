import { View } from "react-native";
import { Chip, IconButton, Text } from "@vyre/ui";
import type { TermState } from "./Terminal";

/** What the state chip says, in plain words, and its tone. */
export function stateWords(s: TermState | null): { text: string; tone: "ok" | "warn" | "err" | "plain" } {
  if (!s || s.state === "idle" || s.state === "connecting") return { text: "Connecting", tone: "plain" };
  if (s.state === "live") return { text: s.owner ? "Live" : "Live, sized by another screen", tone: "ok" };
  if (s.state === "reconnecting") return { text: "Reconnecting", tone: "warn" };
  if (s.state === "ended") return { text: s.reason ? `Ended: ${s.reason}` : "Ended", tone: "err" };
  return { text: "Closed", tone: "plain" };
}

/** The strip above a terminal: its title, its state, and copy and paste (the phone has no other way to do either). */
export function TerminalHeader({ title, subtitle, state, onCopy, onPaste, left, right }: { title: string; subtitle?: string; state: TermState | null; onCopy: () => void; onPaste: () => void; left?: React.ReactNode; right?: React.ReactNode }) {
  const w = stateWords(state);
  return (
    <View className="flex-row items-center gap-s2 px-s3 border-b border-edge bg-panel" style={{ minHeight: 48 }}>
      {left}
      <View className="flex-1">
        <Text strong numberOfLines={1}>{title}</Text>
        {subtitle ? <Text size="caption" tone="label" mono numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <View className="justify-center"><Chip tone={w.tone} className="self-center">{w.text}</Chip></View>
      <IconButton icon="copy" label="Copy" onPress={onCopy} />
      <IconButton icon="share" label="Paste" onPress={onPaste} />
      {right}
    </View>
  );
}
