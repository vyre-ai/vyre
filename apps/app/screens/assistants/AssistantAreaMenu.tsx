// A screen's own way to limit the assistant (G23): a small menu in its header, "Assistant access", with "Turn this off for my assistant" and a way to the Settings page. It narrows only; turning it back on is in Settings.
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Menu, showToast } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { refusal } from "./access-model.js";

/** @param {{ area: string, label: string }} p area is one of the Settings areas (vault, mail, records, files, flows, projects, documents, publish, connections, memory, calendar) */
export function AssistantAreaMenu({ area, label }: { area: string; label: string }) {
  const router = useRouter();
  const off = async () => {
    try { await tool("assistant.access.narrow", { screens: [area] }); showToast(`Your agent cannot use ${label} now. Turn it back on in Settings.`); }
    catch (e) { showToast(refusal((e as { code?: string }).code, e instanceof Error ? e.message : "")); }
  };
  return (
    <View>
      <Menu trigger={<Button kind="ghost" size="sm" label="Agent access" />}
        items={[{ label: `Turn ${label} off for my agent`, onPress: () => void off() }, { label: "Agent access settings", onPress: () => router.push("/u/settings/assistant-access" as never) }]} />
    </View>
  );
}
