// The status line under the transcript, above the composer. Left: who is active ("alex is typing",
// "kit is running the tests") or the session's state in plain words. Right: Stop, only while there
// is something to stop (never a disabled-looking control). The row keeps its height whether or not
// it has anything to say, so presence coming and going never moves the transcript.

import { Pressable, View, StyleSheet } from "react-native";
import { Chip, Text } from "@vyre/ui";

const S = StyleSheet.create({
  s1: { flex: 1 },
});


export function StatusLine({ presence, state, busy, canStop, stopping, offline, phone, onStop, place, starting }: {
  /** Where the session runs, with its chip (R031-95): drawn before Stop. */
  place?: React.ReactNode;
  /** "Starting on <computer>..." while the session's process starts on one of the person's computers (thread.placing); it comes before every other word. */
  starting?: string;
  presence: string;
  state: string;
  busy: boolean;
  canStop: boolean;
  stopping: boolean;
  offline: boolean;
  phone: boolean;
  onStop: () => void;
}) {
  const words = starting || presence || (offline ? "Offline, showing what was saved" : state === "asking" ? "Waiting for you" : busy ? "Working" : "");
  return (
    <View accessibilityRole="text" accessibilityLiveRegion="polite" style={{ width: "100%", maxWidth: 860, alignSelf: "center", minHeight: phone ? 44 : 32, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: phone ? 16 : 24 }}>
      <Text size="caption" tone="label" numberOfLines={1} style={S.s1}>{words}</Text>
      {place}
      {canStop ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={onStop} style={{ minHeight: phone ? 44 : 32, justifyContent: "center" }}>
          <Chip icon="stop" tone="err">Stop</Chip>
        </Pressable>
      ) : stopping ? <Chip>Stopping</Chip> : null}
    </View>
  );
}
