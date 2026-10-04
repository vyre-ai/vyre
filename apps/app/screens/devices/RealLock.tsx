// On the owner's phone: a device the server locked after wrong sign-in answers, and a "Let it sign in again" button (presence.person.renew-allow, the owner's presence). The lock lifts by itself too.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Button, Text, showToast } from "@vyre/ui";
import { Group } from "../places/Frame";
import { tool } from "../../src/real/box";
import { LOCK_CONTROL, LOCK_HELP, LOCK_TITLE, lockOf, lockTime, lockedToast, unlockLine, unlockRefusal } from "./lock-model.js";

export function RealLock({ device, name }: { device: string; name: string }) {
  const [lock, setLock] = useState<{ until: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { tool<{ locked?: unknown[] }>("presence.person.locked").then((a) => setLock(lockOf(a, device, Date.now()))).catch(() => setLock(null)); }, [device]);
  useEffect(load, [load]);
  if (!lock) return null;
  const allow = () => {
    setBusy(true);
    tool("presence.person.renew-allow", { device }).then(() => { showToast(lockedToast(name)); load(); }).catch((e) => showToast(unlockRefusal((e as { code?: string }).code, lockTime(lock.until)))).finally(() => setBusy(false));
  };
  return (
    <Group title={LOCK_TITLE}>
      <Card className="gap-s3">
        <Text>{LOCK_HELP}</Text>
        <Text size="caption" tone="label">{unlockLine(lock.until, Date.now())}</Text>
        <View className="self-start"><Button kind="primary" label={busy ? "Allowing" : LOCK_CONTROL} disabled={busy} onPress={allow} /></View>
      </Card>
    </Group>
  );
}
