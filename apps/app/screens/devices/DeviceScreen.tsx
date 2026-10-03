import { useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Avatar, Button, Card, Chip, Divider, EmptyState, Row, Text, showToast } from "@vyre/ui";
import { Group, Page } from "../shell/Page";
import { FaceIdSheet, type FaceAsk } from "../shell/FaceIdSheet";
import { SPACE_NAMES, glyph } from "./data";
import { lendInfo, useDevices } from "./state";
import { lendState, removeText } from "./wink.js";

/** One device: what it is, which spaces it is in, share it with a space, remove it. */
export function DeviceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { items, devSpaces, addToSpace, removeFromSpace, removeItem, meLends, setLend } = useDevices();
  const [face, setFace] = useState<FaceAsk | null>(null);
  const d = items.find((i) => i.id === id);
  if (!d) return <Page title="Device" back="/u/settings/devices"><Card><EmptyState title="That device is not here" body="It may have been removed." action={{ label: "Back to Devices", onPress: () => router.push("/u/settings/devices" as never) }} /></Card></Page>;
  const cur = devSpaces[d.id] ?? [];
  const missing = Object.keys(SPACE_NAMES).filter((k) => !cur.includes(k));
  const lend = lendState({ spaceAllows: lendInfo.spaceAllows, meAllows: meLends });
  const spaceName = SPACE_NAMES[lendInfo.spaceId];
  return (
    <Page title={d.name} sub={`Since ${d.since} · last used ${d.last}`} back="/u/settings/devices">
      <Card><Row lead={<Avatar name={d.name} family="device" size="lg" icon={glyph(d)} />} title={d.name} sub={d.allows} className="px-0" /></Card>
      <Group title="Spaces">
        <Card flush>
          {cur.map((k, i) => (
            <View key={k}>{i ? <Divider /> : null}
              <Row lead={<Avatar name={SPACE_NAMES[k]} family="space" tint />} title={SPACE_NAMES[k]} sub={`Joined ${d.since}`}
                end={<Button kind="ghost" size="sm" label={`Remove from ${SPACE_NAMES[k]}`} onPress={() => setFace({ title: `Remove from ${SPACE_NAMES[k]}`, body: `${d.name} stops reaching ${SPACE_NAMES[k]} now. Its other spaces are untouched.`, onApprove: () => { removeFromSpace(d.id, k); showToast(`Removed from ${SPACE_NAMES[k]}.`); } })} />} />
            </View>
          ))}
          {missing.map((k, i) => (
            <View key={k}>{cur.length + i ? <Divider /> : null}
              <Row lead={<Avatar name={SPACE_NAMES[k]} family="space" />} title={SPACE_NAMES[k]} sub="Not added"
                end={<Button size="sm" label="Add" onPress={() => setFace({ title: `Add to ${SPACE_NAMES[k]}`, body: `Face ID adds ${d.name} to ${SPACE_NAMES[k]}.`, onApprove: () => addToSpace(d.id, k) })} />} />
            </View>
          ))}
        </Card>
      </Group>
      {d.device === "computer" ? (
        <Group title="Share this computer">
          <Card className="gap-s3">
            <Text strong>{`Lend a computer`}</Text>
            <Text tone="muted">{`${spaceName} would use ${d.name}`}</Text>
            <Text size="caption" tone="label">{lendInfo.limits}</Text>
            <View className="gap-s2">
              <View className="flex-row items-center gap-s2"><Chip tone="ok" icon="check">Yes</Chip><Text>{`${spaceName} allows it (${lendInfo.allowedBy})`}</Text></View>
              <View className="flex-row items-center gap-s2"><Chip tone={meLends ? "ok" : "accent"} icon={meLends ? "check" : undefined}>{meLends ? "Yes" : "Waiting"}</Chip><Text>You allow it</Text></View>
            </View>
            <View className="flex-row flex-wrap items-center gap-s2">
              {lend === "sharing"
                ? <><Chip tone="ok">Sharing</Chip><Button kind="ghost" size="sm" label="Stop sharing" onPress={() => { setLend(false); showToast("Stopped sharing."); }} /></>
                : <Button kind="primary" size="sm" icon="faceid" label="Allow with Face ID" onPress={() => setFace({ title: "Share this computer", body: `${spaceName} runs its own work on ${d.name}. Only when it is idle, and nothing of yours.`, label: "Allow with Face ID", onApprove: () => setLend(true) })} />}
            </View>
          </Card>
        </Group>
      ) : null}
      <Group title="Remove">
        <Text size="caption" tone="label">{removeText("Device", d.name)}</Text>
        <View className="flex-row"><Button kind="hold" label={`Remove ${d.name}`} onPress={() => { removeItem(d.id); showToast(`${d.name} was removed.`); router.push("/u/settings/devices" as never); }} /></View>
      </Group>
      <FaceIdSheet ask={face} onClose={() => setFace(null)} />
    </Page>
  );
}
