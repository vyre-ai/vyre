// Vault health on Now (R031-80s): ONE calm card, never a row per item. It says how many vault items need to be rotated or fixed (counts only; each item is named in the Vault) and offers Rotate, Fix and Dismiss.
// Rotate and Fix open the Vault, where Watchtower names the items; Dismiss hides the card for a week.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Text, showToast } from "@vyre/ui";
import { useRouter } from "expo-router";
import { callT } from "../../src/real/call-tool";
import { healthLines, type VaultHealth } from "./vault-health-model.js";

export function VaultHealthCard() {
  const router = useRouter();
  const [h, setH] = useState<VaultHealth | null>(null);
  const load = useCallback(() => { void callT<VaultHealth>("vault.health.summary", {}).then((r) => setH(r.error ? null : r.data ?? null)); }, []);
  useEffect(load, [load]);
  const l = h ? healthLines(h) : null;
  if (!h || !l) return null;
  const open = () => router.push("/u/vault" as never);
  const dismiss = async () => { const r = await callT("vault.health.dismiss", { days: 7 }); if (r.error) showToast(r.error.message || "That did not go through."); else { showToast("Hidden for a week."); setH(null); } };
  return (
    <Banner>
      <View className="gap-s2">
        <Text strong>{l.title}</Text>
        <Text>{l.detail}</Text>
        <View className="flex-row gap-s2">
          {h.rotate > 0 ? <Button size="sm" label="Rotate" onPress={open} /> : null}
          {h.fix > 0 ? <Button size="sm" label="Fix" onPress={open} /> : null}
          <Button size="sm" kind="ghost" label="Dismiss" onPress={() => void dismiss()} />
        </View>
      </View>
    </Banner>
  );
}
