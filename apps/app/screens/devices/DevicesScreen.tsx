import { useEffect } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Button, Card, Divider, Row, Switch, Text, showToast, markRef } from "@vyre/ui";
import { Group, Page } from "../places/Frame";
import { useDevices } from "./state";
import { deviceLine, deviceSub } from "./wink.js";

/** Devices under your identity: each joins each space on its own. */
export function DevicesScreen() {
  const router = useRouter();
  const { items, devSpaces, spaceNames, faster, setFaster, load, loading, error } = useDevices();
  useEffect(() => { void load(); }, [load]);
  const devices = items.filter((i) => i.kind === "Device");
  return (
    <Page title="Devices" sub="Each device joins each space on its own." back="/u/settings"
      actions={<Button kind="primary" icon="plus" label="Add a device" onPress={() => router.push("/u/wink/add" as never)} />}>
      {devices.length ? (
        <Card flush>
          {devices.map((d, i) => (
            <View key={d.id}>
              {i ? <Divider inset={68} /> : null}
              <Row lead={<Avatar of={{ ...markRef("device", d.name, d.id), device: d.device }} size={40} />} title={deviceLine(d.name, (devSpaces[d.id] ?? []).map((s) => spaceNames[s] ?? s))}
                sub={<View>{deviceSub(d.device === "phone" ? "Phone" : d.device === "server" ? "Server" : "Computer", d.last, d.software).map((l, n) => <Text key={n} size="secondary" tone="label">{l}</Text>)}</View>} onPress={() => router.push(`/u/settings/device/${d.id}` as never)}
                chevron />
            </View>
          ))}
        </Card>
      ) : <Card><Text tone={error ? "warn" : "muted"}>{error ?? (loading ? "Reading your devices." : "No devices. Add one to reach your spaces from it.")}</Text></Card>}
      <Group>
        <Card flush><Row dense title="Make it faster" sub="Let your devices talk to each other directly when they can." end={<Switch label="Make it faster" on={faster} onChange={(v) => { setFaster(v); showToast(v ? "Direct connections are on." : "Direct connections are off."); }} />} /></Card>
      </Group>
    </Page>
  );
}
