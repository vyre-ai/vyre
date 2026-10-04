// A device's spaces on the real box: where it is enrolled (spaces.devices.list), "Remove from <space>" per space (spaces.devices.remove), and sharing a computer as a stored
// grant (spaces.devices.lend, which asks presence only at the first grant for that computer, never on switching off).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Banner, Button, Card, Chip, Divider, EmptyState, Row, Text, showToast, spaceRef } from "@vyre/ui";
import { Group } from "../places/Frame";
import { tool, said } from "../../src/real/box";
import { REMOVE_NOTE, deviceRefusal, lentToast, removedToast, rowLine, spaceTitle, split, type SpaceRow } from "./device-model.js";

const why = (e: unknown) => deviceRefusal((e as { code?: string }).code, said(e));

export function RealDeviceSpaces({ device, name, computer }: { device: string; name: string; computer: boolean }) {
  const [rows, setRows] = useState<SpaceRow[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => { setErr(""); tool<{ spaces?: SpaceRow[] }>("spaces.devices.list", { device }).then((r) => setRows(r?.spaces ?? [])).catch((e) => { setErr(why(e)); setRows(null); }); }, [device]);
  useEffect(load, [load]);
  const remove = (r: SpaceRow) => { setBusy(r.space); tool("spaces.devices.remove", { space: r.space, device }).then(() => { showToast(removedToast(name, spaceTitle(r))); load(); }).catch((e) => showToast(why(e))).finally(() => setBusy("")); };
  const lend = (r: SpaceRow, on: boolean) => { setBusy(r.space); tool("spaces.devices.lend", { space: r.space, device, on }).then(() => { showToast(lentToast(on, name, spaceTitle(r))); load(); }).catch((e) => showToast(why(e))).finally(() => setBusy("")); };
  const { inIt, notIn } = split(rows ?? []);
  return (
    <>
      <Group title="Spaces">
        {err ? <Card flush><EmptyState title="The spaces did not load" body={err} action={{ label: "Try again", onPress: load }} /></Card> : null}
        {!err && rows === null ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
        {rows && !rows.length ? <Card><EmptyState title="This device is not in any space yet" body="Add it to a space from Spaces." /></Card> : null}
        {rows?.length ? (
          <Card flush>
            {[...inIt, ...notIn].map((r, i) => {
              const live = inIt.includes(r);
              return (
                <View key={r.space}>{i ? <Divider /> : null}
                  <Row lead={<Avatar of={spaceRef(spaceTitle(r))} size={40} />} title={spaceTitle(r)} sub={rowLine(r, name)}
                    end={live ? <Button kind="hold" size="sm" label={`Remove from ${spaceTitle(r)}`} onPress={busy ? () => {} : () => remove(r)} /> : undefined} />
                </View>
              );
            })}
          </Card>
        ) : null}
        {inIt.length ? <Text size="caption" tone="label">{REMOVE_NOTE}</Text> : null}
      </Group>
      {computer && inIt.length ? (
        <Group title="Share this computer">
          <Card flush>
            {inIt.map((r, i) => (
              <View key={r.space}>{i ? <Divider /> : null}
                <Row title={spaceTitle(r)} sub={r.lent ? `${spaceTitle(r)} may run its own work on ${name} when it is idle.` : `Not shared with ${spaceTitle(r)}.`}
                  end={r.lent ? <View className="flex-row items-center gap-s2"><Chip tone="ok">Sharing</Chip><Button kind="ghost" size="sm" label="Stop sharing" onPress={busy ? () => {} : () => lend(r, false)} /></View> : <Button kind="primary" size="sm" label="Share" onPress={busy ? () => {} : () => lend(r, true)} />} />
              </View>
            ))}
          </Card>
          <Banner><Text>The first time you share this computer with a space, the box asks for your approval. After that it does not ask again.</Text></Banner>
        </Group>
      ) : null}
    </>
  );
}
