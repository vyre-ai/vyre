import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Card, Divider, IconTile, Row, Text, type IconName } from "@vyre/ui";
import { Frame, Sec } from "../places/Frame";
import { useSpaces } from "../shell/state";
import { useShell } from "../shell/shared";
import { showingName } from "../shell/real-model";
import { useDevices } from "../devices/state";
import { settingsGroups } from "./logic.js";
import { backupLine } from "../shell/basic.js";
import { VERSION } from "./data";
import { MOCK, tool } from "../../src/real/box";
import { useMembers } from "../spaces/state";

/** Settings, rebuilt around who sets what: you, your devices, the space showing, more places, Vyre. One card per section; every row opens something. */
export function SettingsHome() {
  const router = useRouter();
  const space = useSpaces((s) => s.space);
  const devices = useDevices((s) => s.items.filter((i) => i.kind === "Device").length);
  const loadDevices = useDevices((s) => s.load);
  useEffect(() => { void loadDevices(); }, [loadDevices]);
  const shell = useShell((s) => s.data);
  const name = showingName(shell, space);
  const loadMembers = useMembers((s) => s.load);
  const role = useMembers((s) => s.spaces.find((x) => x.id === space)?.role);
  useEffect(() => { void loadMembers(); }, [loadMembers]);
  // On a Basic personal space (no server) say where it is backed up, or that it is not.
  const showing = shell.spaces.find((x) => x.id === space);
  const [backupStatus, setBackupStatus] = useState<{ to?: string | null; last?: number | string | null; state?: string } | null>(null);
  useEffect(() => { if (showing?.basic && !MOCK) tool("memory.backup.status").then((d) => setBackupStatus(d as never)).catch(() => setBackupStatus(null)); }, [showing?.basic]);
  const backup = backupLine({ basic: Boolean(showing?.basic), teams: shell.spaces.filter((x) => x.id !== "all" && !x.basic), status: backupStatus });
  const state = (href: string) => (href === "/u/settings/devices" ? `${devices} ${devices === 1 ? "device" : "devices"}` : undefined);
  return (
    <Frame title="Settings" top>
      {settingsGroups(name, MOCK ? undefined : role).map((g) => (
        <Sec key={g.title} title={g.title}>
          <Card flush>
            {g.rows.map(([t, sub, href, icon], i) => (
              <View key={href}>{i ? <Divider inset={60} /> : null}<Row dense chevron state={state(href)} lead={<IconTile name={icon as IconName} />} title={t} sub={sub} onPress={() => router.push(href as never)} /></View>
            ))}
          </Card>
        </Sec>
      ))}
      {backup ? <Sec title="Backup"><Card flush><Row dense lead={<IconTile name="shield" />} title={backup} /></Card></Sec> : null}
      <View className="items-center pt-s6"><Text size="secondary" tone="faint">{`Vyre ${VERSION}`}</Text></View>
    </Frame>
  );
}
