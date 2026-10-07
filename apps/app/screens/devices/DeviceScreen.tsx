import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Avatar, Button, Card, Chip, Divider, EmptyState, Row, Text, showToast, markRef, spaceRef } from "@vyre/ui";
import { Group, Page } from "../places/Frame";
import { FaceIdSheet, type FaceAsk } from "../shell/FaceIdSheet";
import { lendInfo, useDevices } from "./state";
import { REINSTALL_LINE, lendState, removeText } from "./wink.js";
import { MOCK, said } from "../../src/real/box";
import { RealDeviceSpaces } from "./RealDeviceSpaces";
import { RealLock } from "./RealLock";

/** One device: what it is, which spaces it is in, share it with a space, remove it. */
/** Computers already lent once this session: the first grant is a pairing (Face ID), later ones are not asked again (lead ruling 4 Oct). */
const lentBefore = new Set<string>();

export function DeviceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { items, devSpaces, spaceNames: SPACE_NAMES, addToSpace, removeFromSpace, removeItem, meLends, setLend, load } = useDevices();
  useEffect(() => { void load(); }, [load]);
  const [face, setFace] = useState<FaceAsk | null>(null);
  const d = items.find((i) => i.id === id);
  if (!d) return <Page title="Device" back="/u/settings/devices"><Card><EmptyState title="That device is not here" body="It may have been removed." action={{ label: "Back to Devices", onPress: () => router.push("/u/settings/devices" as never) }} /></Card></Page>;
  const cur = devSpaces[d.id] ?? [];
  const missing = Object.keys(SPACE_NAMES).filter((k) => !cur.includes(k));
  const lend = lendState({ spaceAllows: lendInfo.spaceAllows, meAllows: meLends });
  const spaceName = SPACE_NAMES[lendInfo.spaceId];
  return (
    <Page title={d.name} sub={`Since ${d.since} · last used ${d.last}`} back="/u/settings/devices">
      <Card><Row lead={<Avatar of={{ ...markRef("device", d.name, d.id), device: d.device }} size={40} />} title={d.name} sub={d.allows} className="px-0" /></Card>
      {MOCK ? <Group title="Spaces">
        <Card flush>
          {cur.map((k, i) => (
            <View key={k}>{i ? <Divider /> : null}
              <Row lead={<Avatar of={spaceRef(SPACE_NAMES[k])} size={40} />} title={SPACE_NAMES[k]} sub={`Joined ${d.since}`}
                end={<Button kind="hold" size="sm" label={`Remove from ${SPACE_NAMES[k]}`} onPress={() => { removeFromSpace(d.id, k); showToast(`${d.name} no longer reaches ${SPACE_NAMES[k]}. Its other spaces are untouched.`); }} />} />
            </View>
          ))}
          {missing.map((k, i) => (
            <View key={k}>{cur.length + i ? <Divider /> : null}
              <Row lead={<Avatar of={spaceRef(SPACE_NAMES[k])} size={40} />} title={SPACE_NAMES[k]} sub="Not added"
                end={<Button size="sm" label="Add" onPress={() => setFace({ title: `Add to ${SPACE_NAMES[k]}`, body: `Face ID adds ${d.name} to ${SPACE_NAMES[k]}.`, onApprove: () => addToSpace(d.id, k) })} />} />
            </View>
          ))}
        </Card>
      </Group> : <RealDeviceSpaces device={d.id} name={d.name} computer={d.device === "computer"} />}
      {MOCK && d.device === "computer" ? (
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
                : <Button kind="primary" size="sm" icon="faceid" label="Allow with Face ID" onPress={() => { const grant = () => { lentBefore.add(d.id); setLend(true); }; if (lentBefore.has(d.id)) grant(); else setFace({ title: "Share this computer", body: `${spaceName} runs its own work on ${d.name}. Only when it is idle, and nothing of yours.`, label: "Allow with Face ID", onApprove: grant }); }} />}
            </View>
          </Card>
        </Group>
      ) : null}
      {MOCK ? null : <RealLock device={d.id} name={d.name} />}
      <Group title="Remove">
        {d.device === "phone" ? <Text size="caption" tone="label">{REINSTALL_LINE}</Text> : null}
        <Text size="caption" tone="label">{removeText("Device", d.name)}</Text>
        <View className="flex-row"><Button kind="hold" label={`Remove ${d.name}`} onPress={() => { removeItem(d.id).then(() => { showToast(`${d.name} was removed.`); router.push("/u/settings/devices" as never); }).catch((e) => showToast(said(e))); }} /></View>
      </Group>
      <FaceIdSheet ask={face} onClose={() => setFace(null)} />
    </Page>
  );
}
