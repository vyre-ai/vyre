// "Allowed in scripts" for one item of the Space's vault: the one setting that lets an agent's session run a program with the item in its environment (vyre vault run --item). Off by default,
// because the agent can then read the value. It reads the item's state with vault.use.find and writes it with vault.use.set; turning it on asks for the person's proof there, turning it off never does.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Row, Switch, Text, showToast } from "@vyre/ui";
import type { VaultData } from "./redesign-data";
import type { VItem } from "./redesign.js";

export type ScriptsApi = NonNullable<VaultData["scripts"]>;

export function ScriptsSetting({ api, item }: { api: ScriptsApi; item: VItem }) {
  const [on, setOn] = useState<boolean | null>(null);
  const load = useCallback(() => { api.load(item).then(setOn).catch(() => setOn(false)); }, [api, item]);
  useEffect(() => { setOn(null); load(); }, [load]);
  const change = (v: boolean) => {
    setOn(v);
    api.set(item, v).then(() => showToast(v ? "Agents' scripts can use it now." : "Scripts can no longer use it.")).catch((e) => { showToast(String((e as Error)?.message || "That did not work.")); load(); });
  };
  return (
    <View className="gap-s2">
      <Card><Row title="Allowed in scripts" sub="When this is on, the agent can read this value. A script it runs gets the item in its environment." end={<Switch label="Allowed in scripts" on={on === true} disabled={on === null} onChange={change} />} /></Card>
      {on ? <Text tone="muted">When this is on, the agent can read this value. Turn it off when the script no longer needs it.</Text> : null}
    </View>
  );
}
