import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Divider, Field, Row, Text, showToast } from "@vyre/ui";
import { Group } from "../places/Frame";
import { tool } from "../../src/real/box";
import { cleanCode, extensions, groupDevices, provisioned } from "./vault-devices-model.js";

const words = (e: unknown) => (e instanceof Error && e.message ? e.message : "That did not go through.");

/** The Vault's devices, on Settings > Devices: the devices in the vault group (approve a new one, sync), the autofill extensions paired to it (revoke one), and the apps a member acts as. A part the server does not offer is left out. */
export function VaultDevices() {
  const [group, setGroup] = useState<ReturnType<typeof groupDevices> | null>(null);
  const [ext, setExt] = useState<ReturnType<typeof extensions> | null>(null);
  const [apps, setApps] = useState<ReturnType<typeof provisioned>>([]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    tool<unknown>("vault.device.list", {}).then((d) => setGroup(groupDevices(d))).catch(() => setGroup(null));
    tool<unknown>("vault.devices", {}).then((d) => setExt(extensions(d))).catch(() => setExt(null));
    tool<unknown>("vault.me.provisioned", {}).then((d) => setApps(provisioned(d))).catch(() => setApps([]));
  }, []);
  useEffect(load, [load]);
  const act = (run: () => Promise<unknown>, done: string) => { setBusy(true); run().then(() => { showToast(done); load(); }).catch((e) => showToast(words(e))).finally(() => setBusy(false)); };
  if (!group && !ext && !apps.length) return null;
  return (
    <>
      {group ? (
        <Group title="Vault devices" note="The devices that hold your vault.">
          {group.length ? <Card flush>{group.map((d, i) => <View key={d.id}>{i ? <Divider /> : null}<Row title={d.name} sub={d.line} /></View>)}</Card> : <Card><Text tone="muted">Only this device holds your vault.</Text></Card>}
          <Card className="gap-s2">
            <Field label="Approve a new device" value={code} onChangeText={(v) => setCode(v ?? "")} placeholder="Paste the code the new device shows" />
            <View className="flex-row gap-s2">
              <Button kind="secondary" label="Approve" disabled={busy || !cleanCode(code)} onPress={() => act(() => tool("vault.device.approve", { code: cleanCode(code) }).then(() => setCode("")), "Device approved")} />
              <Button kind="ghost" label="Sync now" disabled={busy} onPress={() => act(() => tool("vault.device.sync", {}), "Synced")} />
            </View>
          </Card>
        </Group>
      ) : null}
      {ext && ext.length ? (
        <Group title="Browser extensions" note="Paired for autofill. Revoke one you no longer use.">
          <Card flush>
            {ext.map((d, i) => <View key={d.id}>{i ? <Divider /> : null}<Row title={d.name} sub={d.line} end={d.revoked ? undefined : <Button kind="ghost" size="sm" label="Revoke" disabled={busy} onPress={() => act(() => tool("vault.device.revoke", { id: d.id }), "Revoked")} />} /></View>)}
          </Card>
        </Group>
      ) : null}
      {apps.length ? (
        <Group title="Apps you act as" note="Accounts your Space lets you use.">
          <Card flush>{apps.map((a, i) => <View key={a.id}>{i ? <Divider /> : null}<Row title={a.title} sub={a.line} /></View>)}</Card>
        </Group>
      ) : null}
    </>
  );
}
