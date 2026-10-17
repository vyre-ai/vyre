// Move an item to another vault (or back to the Space's own): the list of vaults, and one plain line about what it does before the person picks. The tool takes back what was shared on the item at its old place;
// who holds it afterwards is whoever the vault it lands in is shared with.
import { useState } from "react";
import { View } from "react-native";
import { Button, Card, IconTile, Row, Sheet, showToast } from "@vyre/ui";
import { Footnote } from "../places/Frame";
import type { VaultData } from "./redesign-data";
import type { VItem } from "./redesign.js";

export function MoveItem({ api, item, onMoved }: { api: NonNullable<VaultData["moving"]>; item: VItem; onMoved: () => void }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ id: string; name: string; sub: string }[] | null>(null);
  const [err, setErr] = useState("");
  const start = () => { setOpen(true); setErr(""); api.list().then(setList).catch((e) => setErr(String((e as Error)?.message || "That did not load."))); };
  const go = (id: string | null, name: string) => api.move(item, id).then(() => { setOpen(false); showToast(`${item.name} is now in ${name}.`); onMoved(); }).catch((e) => setErr(String((e as Error)?.message || "That did not work.")));
  return (
    <View>
      <Button kind="ghost" size="sm" label="Move" onPress={start} />
      <Sheet open={open} onClose={() => setOpen(false)} title={`Move ${item.name}`}>
        <View className="gap-s4">
          <Footnote icon="shield">What was shared on it is taken back. Afterwards it is held by the people and agents the vault you pick is shared with, and by nobody else.</Footnote>
          <Card flush>
            <Row dense lead={<IconTile name="vault" />} title="The Space's own" sub="Where only you hold it until you share it" onPress={() => void go(null, "the Space's own vault")} />
            {(list ?? []).map((v) => <Row key={v.id} dense lead={<IconTile name="vault" />} title={v.name} sub={v.sub} onPress={() => void go(v.id, v.name)} />)}
          </Card>
          {err ? <Footnote icon="info">{err}</Footnote> : null}
          <View className="flex-row gap-s2"><Button kind="ghost" label="Cancel" onPress={() => setOpen(false)} /></View>
        </View>
      </Sheet>
    </View>
  );
}
