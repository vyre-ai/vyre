// "Used with" for one item of the Space's vault: the hosts its secrets may go to. The hosts written on the item are fixed; the ones the person allows here are added and removed with
// vault.use.set (the list is read back with vault.use.find). Adding one asks for the person's proof there; removing one never does. A host not on the list holds a request and asks once.
import { useState } from "react";
import { View } from "react-native";
import { Button, Card, Field, Row, Text, showToast } from "@vyre/ui";
import type { VaultData } from "./redesign-data";
import type { VItem } from "./redesign.js";

export type UsedWithApi = NonNullable<VaultData["usedWith"]>;

/** The host name in what was typed or pasted: no scheme, path, port or case. Null when it is not a host name. */
export function hostOfInput(s: string): string | null {
  const t = s.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(t) ? t : null;
}
/** The host names an item's own origins write. */
const writtenOf = (item: VItem) => (item.hosts ?? []).map((h) => hostOfInput(h)).filter((h): h is string => Boolean(h));

export function UsedWith({ api, item, hosts, onChanged }: { api: UsedWithApi; item: VItem; hosts: string[]; onChanged: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const written = writtenOf(item);
  const allowed = hosts.filter((h) => !written.includes(h));
  const save = (next: string[], done: string) => {
    setBusy(true); setErr("");
    api.set(item, next).then(() => { setTyped(""); showToast(done); onChanged(); }).catch((e) => setErr(String((e as Error)?.message || "That did not save."))).finally(() => setBusy(false));
  };
  const add = () => {
    const h = hostOfInput(typed);
    if (!h) { setErr("Type a host name, like api.example.com."); return; }
    if (hosts.includes(h)) { setErr(`${h} is already on the list.`); return; }
    save([...allowed, h], `${item.name} can now be used with ${h}.`);
  };
  return (
    <View className="gap-s2">
      {hosts.length ? <Card flush>{hosts.map((h) => (
        <Row key={h} dense title={<Text mono selectable>{h}</Text>} sub={written.includes(h) ? "Written on the item" : "You allowed it"}
          end={written.includes(h) ? undefined : <Button kind="ghost" size="sm" label="Remove" disabled={busy} onPress={() => save(allowed.filter((x) => x !== h), `${h} removed.`)} />} />
      ))}</Card> : <Text tone="muted">No host yet. When an agent asks to use this with a host, you are asked once.</Text>}
      <Field label="Allow a host" value={typed} onChangeText={setTyped} placeholder="api.example.com" onSubmit={add} />
      <View className="self-start"><Button kind="secondary" size="sm" label="Allow it" disabled={busy || !typed.trim()} onPress={add} /></View>
      {err ? <Text size="caption" tone="label">{err}</Text> : null}
    </View>
  );
}
