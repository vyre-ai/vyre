// The Computer tab of the chat's side panel: the screen, one line under it, and Reset kept small at the bottom.
// Asleep, the whole screen is the wake control: dimmed, a sleeping mark that breathes gently (still with reduced motion, through Pulse), and "Press to wake". Once the screen is live, the next press opens it full screen.
// It draws what computer-model.js shapes and calls nothing itself.

import { useState } from "react";
import { Image, Pressable, View } from "react-native";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Text } from "../components/Text";
import { Banner } from "../components/Banner";
import { useUiTheme } from "../theme";
import { Pulse } from "../motion/Pulse";
import { computerActions, computerWords, type ComputerView } from "./computer-model.js";

export type { ComputerView };

export function AgentComputerPane({ name, view, busy, problem, onWake, onOpen, onReset, onSettings }: {
  name: string; view: ComputerView | null; busy?: boolean; problem?: string;
  /** The next step beside a problem: the agent computer's settings (Settings, This computer). */
  onSettings?: () => void;
  onWake: () => void; onOpen: () => void;
  /** Empties this agent's home (browser logins, files, terminal). Asks once more before it does. */
  onReset?: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const { color } = useUiTheme();
  const v = view ?? { state: "asleep" as const, lastActive: 0, thumbnail: "" };
  const actions = computerActions(v);
  const frame = { aspectRatio: 16 / 10, borderRadius: 12, overflow: "hidden" as const, borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-3"], alignItems: "center" as const, justifyContent: "center" as const };
  return (
    <View style={{ gap: 12 }}>
      {problem ? <Banner tone="warn"><View style={{ gap: 8, alignItems: "flex-start" }}><Text>{problem}</Text>{onSettings ? <Button kind="secondary" size="sm" label="Open settings" onPress={onSettings} /> : null}</View></Banner> : null}
      {actions.includes("wake") ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`${name}'s computer is asleep. Press to wake`} accessibilityState={{ disabled: !!busy }} disabled={busy} onPress={onWake}
          style={({ hovered }: any) => ({ ...frame, borderColor: hovered ? color["edge-strong"] : color.edge })}>
          <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.scrim, opacity: 0.35 }} />
          <View pointerEvents="none" style={{ alignItems: "center", gap: 8 }}>
            <Pulse active={!busy}><Icon name="moon" size={24} tone="text-2" /></Pulse>
            <Text size="secondary" medium>{busy ? "Waking" : "Press to wake"}</Text>
          </View>
        </Pressable>
      ) : v.state === "live" ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Open ${name}'s computer`} disabled={busy} onPress={onOpen} style={frame}>
          {v.thumbnail ? <Image source={{ uri: v.thumbnail }} accessibilityIgnoresInvertColors style={{ width: "100%", height: "100%" }} resizeMode="cover" /> : <Icon name="laptop" size={24} tone="text-2" />}
        </Pressable>
      ) : (
        <View accessibilityLabel={`${name}'s screen, ${v.state}`} style={frame}>
          {v.state === "waking" ? <Pulse active><Icon name="laptop" size={24} tone="text-2" /></Pulse> : <Icon name="laptop" size={24} tone="text-2" />}
        </View>
      )}
      <Text size="secondary" tone="muted">{computerWords(v, name)}</Text>
      {onReset ? (
        <View style={{ gap: 6 }}>
          {armed ? <Text size="caption" tone="label">{`This empties ${name}'s browser logins, files and terminal. Nobody else's are touched.`}</Text> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind={armed ? "danger" : "ghost"} size="sm" label={armed ? "Yes, reset it" : "Reset its computer"} disabled={busy} onPress={() => { if (armed) { setArmed(false); onReset(); } else setArmed(true); }} />
            {armed ? <Button kind="ghost" size="sm" label="Cancel" onPress={() => setArmed(false)} /> : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}
