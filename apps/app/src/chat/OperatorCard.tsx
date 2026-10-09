// The operator card (R031-91): a computer at work, as one card in the chat. What it is doing now in one plain sentence (the newest receipt), a short track of the last steps, and the live screen on a tap, where you
// can also take over the keyboard. Quiet when idle; "Needs you" when it is stuck. The screen itself is Glass's (LiveScreen), so every rule Glass has holds here.
import { useState } from "react";
import { View } from "react-native";
import { Button, Chip, Text, useUiTheme } from "@vyre/ui";
import { LiveScreen } from "./LiveScreen";
import { dots, runWord } from "./screen-model.js";

type Op = { block: "operator"; run: string; computer: string; title: string; state: "working" | "done" | "stuck" | "paused"; line: string; steps: { line: string; state: string }[] };

export function OperatorCard({ block }: { block: Op }) {
  const { color } = useUiTheme();
  const [watch, setWatch] = useState(false);
  const track = dots(block.steps);
  const ink = (s: string) => (s === "done" ? color.ok : s === "stuck" ? color.warn : s === "paused" ? color.label : color.accent);
  return (
    <View style={{ borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], borderRadius: 14, marginVertical: 4, maxWidth: 560, padding: 14, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text strong numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{block.title}</Text>
        <Chip tone={block.state === "done" ? "ok" : block.state === "stuck" ? "warn" : "plain"}>{runWord(block.state)}</Chip>
      </View>
      <Text accessibilityLiveRegion="polite">{block.line || "Getting started"}</Text>
      {track.length ? (
        <View accessibilityLabel={`${track.length} steps`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {track.map((s, i) => <View key={i} accessibilityLabel={s.line} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: i === track.length - 1 && block.state === "working" ? "transparent" : ink(s.state), borderWidth: i === track.length - 1 && block.state === "working" ? 2 : 0, borderColor: ink(s.state) }} />)}
        </View>
      ) : null}
      {watch ? <LiveScreen computer={block.computer} /> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button kind={watch ? "ghost" : "primary"} size="sm" icon="globe" label={watch ? "Hide the screen" : "Watch"} onPress={() => setWatch((w) => !w)} />
      </View>
    </View>
  );
}
