// What a member does with an item shared with her, by what she holds: Fill in (it is used for her, she sees nothing to do), Read (Show: the value on her own screen for a moment, after her yes), Edit and rotate (Change
// a field, or Rotate at its provider, after her yes). The server decides and logs each act; this only offers what the share allows.
import { useState } from "react";
import { View } from "react-native";
import { Button, Field, IconTile, Row, SecretField, Sheet, Text, showToast } from "@vyre/ui";
import { Footnote } from "../places/Frame";
import { tool } from "../../src/real/box";

export type SharedItem = { name: string; kind: string; can: string[] };
const KIND_ICON = (k: string) => (k === "login" ? "key" : k === "note" ? "file" : "vault");

export function SharedItemRow({ item, onChanged }: { item: SharedItem; onChanged?: () => void }) {
  const [showing, setShowing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [field, setField] = useState("value");
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const reads = item.can.includes("reveal"), edits = item.can.includes("edit");
  const sub = edits ? "You can use it, see it, change it and rotate it" : reads ? "You can use it and see it" : "Used for you. You never see it";
  const fail = (e: unknown) => setErr(String((e as Error)?.message || "That did not work."));
  const save = () => { setBusy(true); setErr(""); tool("vault.me.shared.update", { item: item.name, fields: { [field.trim()]: val } }).then(() => { setChanging(false); setVal(""); showToast(`${item.name} changed.`); onChanged?.(); }).catch(fail).finally(() => setBusy(false)); };
  const rotate = () => { setErr(""); tool<{ rotated?: boolean; guided?: { steps?: string } }>("vault.me.shared.rotate", { item: item.name }).then((r) => showToast(r.rotated ? `${item.name} has a new key.` : r.guided?.steps ?? "Rotate it at its service by hand.")).catch(fail); };
  return (
    <View>
      <Row dense lead={<IconTile name={KIND_ICON(item.kind)} />} title={item.name} sub={sub}
        end={<View className="flex-row items-center gap-s2">
          {reads ? <Button kind="secondary" size="sm" icon="eye" label={showing ? "Hide" : "Show"} onPress={() => setShowing((x) => !x)} /> : null}
          {edits ? <Button kind="secondary" size="sm" label="Change" onPress={() => { setErr(""); setChanging(true); }} /> : null}
          {edits ? <Button kind="ghost" size="sm" label="Rotate" onPress={rotate} /> : null}
        </View>} />
      {showing ? <View className="px-s3 pb-s2"><SecretField key={item.name} label={item.name} read={() => tool<{ value: string }>("vault.me.shared.reveal", { item: item.name }).then((r) => r.value)} revealMs={30_000} /></View> : null}
      {err ? <Footnote icon="info">{err}</Footnote> : null}
      <Sheet open={changing} onClose={() => setChanging(false)} title={`Change ${item.name}`}>
        <View className="gap-s4">
          <Field name="Field" value={field} onChangeText={setField} placeholder="value" />
          <Field name="New value" value={val} onChangeText={setVal} placeholder="" kind="password" />
          <Text tone="label">The owner sees that you changed it, and when.</Text>
          {err ? <Footnote icon="info">{err}</Footnote> : null}
          <View className="flex-row gap-s2"><Button kind="primary" label={busy ? "Saving" : "Save"} disabled={busy || !val || !field.trim()} onPress={save} /><Button kind="ghost" label="Cancel" onPress={() => setChanging(false)} /></View>
        </View>
      </Sheet>
    </View>
  );
}
