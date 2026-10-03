import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Card, Divider, Row, type IconName } from "@vyre/ui";
import { Group, Page } from "../shell/Page";
import { useSpaces } from "../shell/state";
import { loadShell } from "../shell/data";
import { settingsGroups } from "./logic.js";

const SPACES = loadShell().spaces;

/** Settings, rebuilt around who sets what: you, your devices, the space showing, more places, Vyre. */
export function SettingsHome() {
  const router = useRouter();
  const space = useSpaces((s) => s.space);
  const name = (SPACES.find((s) => s.id === space && s.id !== "all") ?? SPACES.find((s) => s.id === "harlow"))!.name;
  return (
    <Page title="Settings">
      {settingsGroups(name).map((g) => (
        <Group key={g.title} title={g.title}>
          <Card flush>
            {g.rows.map(([t, sub, href, icon], i) => (
              <View key={href}>{i ? <Divider /> : null}<Row lead={<Avatar name={t} family="device" icon={icon as IconName} />} title={t} sub={sub} onPress={() => router.push(href as never)} /></View>
            ))}
          </Card>
        </Group>
      ))}
    </Page>
  );
}
