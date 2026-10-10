import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { BlockScreen, Card, Divider, IconTile, Row, Text, type BlockScreenData, type IconName } from "@vyre/ui";
import { Frame, Sec } from "../places/Frame";
import { shell as macShell } from "../../src/shell/shell";
import { useSpaces } from "../shell/state";
import { useShell } from "../shell/shared";
import { showingName } from "../shell/real-model";
import { useDevices } from "../devices/state";
import { settingsGroups } from "./logic.js";
import { backupLine, storedLine } from "../shell/basic.js";
import { MakeServer } from "./MakeServer";
import { PersonalHost } from "./PersonalHost";
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
  const stored = storedLine({ basic: Boolean(showing?.basic), teams: shell.spaces.filter((x) => x.id !== "all" && !x.basic) });
  const backup = backupLine({ basic: Boolean(showing?.basic), teams: shell.spaces.filter((x) => x.id !== "all" && !x.basic), status: backupStatus });
  const state = (href: string) => (href === "/u/settings/devices" ? `${devices} ${devices === 1 ? "device" : "devices"}` : undefined);
  // Settings home is one list block: each row opens its page, each group is a card, the devices row says how many.
  const screen: BlockScreenData = {
    v: 2, id: "settings", layout: { block: "places" },
    blocks: { places: { type: "list", props: { density: "tight" }, content: { rows: settingsGroups(name, MOCK ? undefined : role).flatMap((g) => g.rows.map(([title, sub, href, icon]) => ({ id: href, title, subtitle: sub, icon, group: g.title, ...(state(href) ? { accessory: state(href) } : {}) }))) } } },
  };
  return (
    <Frame title="Settings" top>
      <BlockScreen screen={screen} handlers={{
        open: (_b, row) => router.push(row.id as never),
        // the Mac's "make this Mac a server" card sits under the Devices group, where it always has
        slot: (_b, at) => (at === "after:Devices" && macShell()?.identity?.makeServer ? <View className="pt-s4"><MakeServer /></View> : null),
      }} />
      {showing?.basic ? <PersonalHost /> : null}
      {backup || stored ? <Sec title="Backup"><Card flush>{stored ? <Row dense lead={<IconTile name="vault" />} title={stored} /> : null}{stored && backup ? <Divider inset={60} /> : null}{backup ? <Row dense lead={<IconTile name="shield" />} title={backup} /> : null}</Card></Sec> : null}
      <View className="items-center pt-s6"><Text size="secondary" tone="faint">{`Vyre ${VERSION}`}</Text></View>
    </Frame>
  );
}
