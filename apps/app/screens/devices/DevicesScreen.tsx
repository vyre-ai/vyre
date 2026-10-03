import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Button, Card, Chip, Divider, Row, Switch, Text, showToast, markRef } from "@vyre/ui";
import { Group, Page } from "../shell/Page";
import { SPACE_NAMES } from "./data";
import { useDevices } from "./state";
import { deviceLine } from "./wink.js";

/** Devices under your identity: each joins each space on its own. */
export function DevicesScreen() {
  const router = useRouter();
  const { items, devSpaces, faster, setFaster } = useDevices();
  const devices = items.filter((i) => i.kind === "Device");
  return (
    <Page title="Devices" sub="Each device joins each space on its own." back="/u/settings"
      actions={<Button kind="primary" icon="plus" label="Add a device" onPress={() => router.push("/u/wink/add" as never)} />}>
      {devices.length ? (
        <Card flush>
          {devices.map((d, i) => (
            <View key={d.id}>
              {i ? <Divider /> : null}
              <Row lead={<Avatar of={{ ...markRef("device", d.name, d.id), device: d.device }} size={40} />} title={deviceLine(d.name, (devSpaces[d.id] ?? []).map((s) => SPACE_NAMES[s] ?? s))}
                sub={`Last used ${d.last}`} onPress={() => router.push(`/u/settings/device/${d.id}` as never)}
                end={<Chip>{d.device === "phone" ? "Phone" : d.device === "server" ? "Server" : "Computer"}</Chip>} />
            </View>
          ))}
        </Card>
      ) : <Card><Text tone="muted">No devices. Add one to reach your spaces from it.</Text></Card>}
      <Group>
        <Card><Row title="Make it faster" sub="Let your devices talk to each other directly when they can." end={<Switch label="Make it faster" on={faster} onChange={(v) => { setFaster(v); showToast(v ? "Direct connections are on." : "Direct connections are off."); }} />} /></Card>
      </Group>
    </Page>
  );
}
