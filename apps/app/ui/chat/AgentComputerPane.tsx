// The Computer tab of the chat's side panel: an agent's computer as asleep, waking or live, a thumbnail of its screen when it has one, and the few things a person can do from there.
// Open goes full screen (the screen share view, where Watching and Take control live). It draws what computer-model.js shapes and calls nothing itself.

import { useState } from "react";
import { Image, View } from "react-native";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { Text } from "../components/Text";
import { Banner } from "../components/Banner";
import { useUiTheme } from "../theme";
import { DOCK, computerActions, computerWords, type ComputerView } from "./computer-model.js";

export type { ComputerView };

export function AgentComputerPane({ name, view, busy, problem, onWake, onSleep, onOpen, onDock, onReset, onFiles }: {
  name: string; view: ComputerView | null; busy?: boolean; problem?: string;
  onWake: () => void; onSleep: () => void; onOpen: () => void;
  /** A dock app opened on the live screen (Chrome, Files, Terminal). */
  onDock?: (id: string) => void;
  /** Empties this agent's home (Chrome logins, files, terminal). Asks once more before it does. */
  onReset?: () => void;
  /** Opens this agent's files in Vyre Files. */
  onFiles?: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const { color } = useUiTheme();
  const v = view ?? { state: "asleep" as const, lastActive: 0, thumbnail: "" };
  const actions = computerActions(v);
  return (
    <View style={{ gap: 12 }}>
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      <View accessibilityLabel={`${name}'s screen, ${v.state}`} style={{ aspectRatio: 16 / 10, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-3"], alignItems: "center", justifyContent: "center" }}>
        {v.state === "live" && v.thumbnail ? <Image source={{ uri: v.thumbnail }} accessibilityIgnoresInvertColors style={{ width: "100%", height: "100%" }} resizeMode="cover" /> : <Icon name="laptop" size={24} tone="text-2" />}
      </View>
      <Text size="secondary" tone="muted">{computerWords(v, name)}</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {actions.includes("wake") ? <Button kind="primary" size="sm" label="Wake" disabled={busy} onPress={onWake} /> : null}
        {actions.includes("open") ? <Button kind="primary" size="sm" label="Open" disabled={busy} onPress={onOpen} /> : null}
        {actions.includes("sleep") ? <Button kind="secondary" size="sm" label="Sleep" disabled={busy} onPress={onSleep} /> : null}
      </View>
      {onFiles ? <Row dense lead={<Icon name="folder" size={20} />} title={`${name}'s files`} sub="Open in Vyre Files" chevron onPress={onFiles} /> : null}
      {onReset ? (
        <View style={{ gap: 6 }}>
          {armed ? <Text size="caption" tone="label">{`This empties ${name}'s Chrome logins, files and terminal. Nobody else's are touched.`}</Text> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind={armed ? "danger" : "ghost"} size="sm" label={armed ? "Yes, reset it" : "Reset its computer"} disabled={busy} onPress={() => { if (armed) { setArmed(false); onReset(); } else setArmed(true); }} />
            {armed ? <Button kind="ghost" size="sm" label="Cancel" onPress={() => setArmed(false)} /> : null}
          </View>
        </View>
      ) : null}
      {v.state === "live" && onDock ? DOCK.map((d) => <Row key={d.id} dense lead={<Icon name={d.icon as never} size={20} />} title={d.label} chevron onPress={() => onDock(d.id)} />) : null}
    </View>
  );
}
