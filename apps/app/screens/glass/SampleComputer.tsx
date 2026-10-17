// The sample world's full-screen view of an agent's computer, for the design preview only (sample build): the screen, Watching or You're in control, and the dock. The real view is GlassScreen,
// which stays off until the agent computer's own proof turns it on.
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Banner, Button, Chip, Icon, Text, DOCK, useUiTheme } from "@vyre/ui";
import type { ComputerView } from "@vyre/ui";
import { Page } from "../places/Frame";
import { agentComputer } from "../chat-tools/computer-source";

export default function SampleComputer() {
  const { color } = useUiTheme();
  const { name, app, control: startIn } = useLocalSearchParams<{ name: string; app?: string; control?: string }>();
  const who = String(name || "");
  const [view, setView] = useState<ComputerView | null>(null);
  const [control, setControl] = useState(startIn === "1");
  const [dock, setDock] = useState(typeof app === "string" ? app : "chrome");
  useEffect(() => { void agentComputer.status(who).then((r) => { if ("view" in r) setView(r.view); }); }, [who]);
  const label = DOCK.find((d) => d.id === dock)?.label ?? "Chrome";
  return (
    <Page title={`${who}'s computer`} sub={control ? "You're in control. The agent waits." : "Watching. The agent is working."} back="/u/chats">
      <View className="gap-s3">
        <View style={{ aspectRatio: 16 / 10, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-3"], alignItems: "center", justifyContent: "center" }}>
          {view?.thumbnail ? <Image source={{ uri: view.thumbnail }} accessibilityIgnoresInvertColors style={{ width: "100%", height: "100%" }} resizeMode="cover" /> : <Icon name="laptop" size={24} tone="text-2" />}
        </View>
        {control ? <Banner tone="warn">Typing a password here shows it to this agent. Save it in your Vault and let Vyre fill it instead.</Banner> : null}
        <View className="flex-row flex-wrap items-center gap-s2">
          {control ? <Button kind="primary" size="sm" label="Stop" onPress={() => setControl(false)} /> : <Button kind="primary" size="sm" label="Take control" onPress={() => setControl(true)} />}
          <Text size="caption" tone="label">{control ? "You're in control" : "Watching"}</Text>
        </View>
        <View accessibilityLabel="Dock" className="flex-row gap-s2">{DOCK.map((d) => <Chip key={d.id} icon={d.icon as never} selected={dock === d.id} onPress={() => setDock(d.id)}>{d.label}</Chip>)}</View>
        <Banner>{`${label} on ${who}'s computer opens here. This is a sample screen for the design preview.`}</Banner>
      </View>
    </Page>
  );
}
