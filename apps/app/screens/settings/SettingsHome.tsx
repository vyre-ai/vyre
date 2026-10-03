import { View } from "react-native";
import { useRouter } from "expo-router";
import { Card, Divider, IconTile, Row, Text, type IconName } from "@vyre/ui";
import { Frame, Sec } from "../places/Frame";
import { useSpaces } from "../shell/state";
import { loadShell } from "../shell/data";
import { useDevices } from "../devices/state";
import { settingsGroups } from "./logic.js";
import { VERSION } from "./data";

const SPACES = loadShell().spaces;

/** Settings, rebuilt around who sets what: you, your devices, the space showing, more places, Vyre. One card per section; every row opens something. */
export function SettingsHome() {
  const router = useRouter();
  const space = useSpaces((s) => s.space);
  const devices = useDevices((s) => s.items.filter((i) => i.kind === "Device").length);
  const name = (SPACES.find((s) => s.id === space && s.id !== "all") ?? SPACES.find((s) => s.id === "harlow"))!.name;
  const state = (href: string) => (href === "/u/settings/devices" ? `${devices} ${devices === 1 ? "device" : "devices"}` : undefined);
  return (
    <Frame title="Settings" top>
      {settingsGroups(name).map((g) => (
        <Sec key={g.title} title={g.title}>
          <Card flush>
            {g.rows.map(([t, sub, href, icon], i) => (
              <View key={href}>{i ? <Divider inset={60} /> : null}<Row dense chevron state={state(href)} lead={<IconTile name={icon as IconName} />} title={t} sub={sub} onPress={() => router.push(href as never)} /></View>
            ))}
          </Card>
        </Sec>
      ))}
      <View className="items-center pt-s6"><Text size="secondary" tone="faint" style={{ fontSize: 13, lineHeight: 18 }}>{`Vyre ${VERSION}`}</Text></View>
    </Frame>
  );
}
