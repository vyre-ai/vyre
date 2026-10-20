// Move an item between Mine and Shared, the owner's explicit act (vault.named.move): into one of the Space's folders, or a new one, or back to Mine. What was shared on the item at
// its old place is taken back; afterwards it is held by whoever its folder is shared with.
import { useState } from "react";
import { View } from "react-native";
import { Button, Card, Field, IconTile, Row, Sheet, showToast } from "@vyre/ui";
import { Footnote } from "../places/Frame";
import type { VaultData } from "./redesign-data";
import type { VItem } from "./redesign.js";

export function MoveItem({ api, item, onMoved }: { api: NonNullable<VaultData["folders"]>; item: VItem; onMoved: () => void }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ id: string; name: string; sub: string }[] | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const inShared = Boolean(item.folder);
  const fail = (e: unknown) => setErr(String((e as Error)?.message || "That did not work."));
  const start = () => { setOpen(true); setErr(""); setName(""); api.list().then(setList).catch(fail); };
  const go = (id: string | null, where: string) => { setBusy(true); api.move(item, id).then(() => { setOpen(false); showToast(`${item.name} is now in ${where}.`); onMoved(); }).catch(fail).finally(() => setBusy(false)); };
  const make = () => { if (!name.trim()) { setErr("Name the folder."); return; } setBusy(true); api.make(name.trim()).then((id) => go(id, name.trim())).catch((e) => { fail(e); setBusy(false); }); };
  return (
    <View>
      <Button kind="secondary" size="sm" icon={inShared ? "person" : "share"} label={inShared ? "Move to Mine" : "Move to Shared"} onPress={inShared ? () => go(null, "Mine") : start} disabled={busy} />
      <Sheet open={open} onClose={() => setOpen(false)} title={`Move ${item.name} to Shared`}>
        <View className="gap-s4">
          <Footnote icon="shield">Pick a folder. Whoever the folder is shared with can use the item, without seeing it unless you let them. What was shared on the item before is taken back.</Footnote>
          {list && list.length ? <Card flush>{list.map((v) => <Row key={v.id} dense chevron lead={<IconTile name="vault" />} title={v.name} sub={v.sub} onPress={() => go(v.id, v.name)} />)}</Card> : null}
          <View className="gap-s2">
            <Field label="Or make a folder" value={name} onChangeText={setName} placeholder="Team" onSubmit={make} />
            <View className="flex-row gap-s2"><Button kind="primary" label="Make it and move" disabled={busy} onPress={make} /><Button kind="ghost" label="Cancel" onPress={() => setOpen(false)} /></View>
            <Footnote icon="info">A new folder is shared with everyone in the Space: people and agents can use what is in it, without seeing it.</Footnote>
          </View>
          {err ? <Footnote icon="info">{err}</Footnote> : null}
        </View>
      </Sheet>
    </View>
  );
}
