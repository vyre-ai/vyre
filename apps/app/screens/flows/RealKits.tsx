// Kits from the real box: the Kits installed in the space (flows.kit.list) and Remove (flows.kit.remove, a person's own act). The box has no library of Kits to install from, so
// nothing is offered here that could not be installed.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, Divider, EmptyState, Row, Text, showToast } from "@vyre/ui";
import { IconTile } from "../places/Page";
import { Frame, Sec } from "../places/Frame";
import { kitLine, kitName, kitRefusal, listed, statusWord, type KitRow } from "./kits-model";
import { listKits, removeKit } from "./kits";

const say = (e: unknown) => kitRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

export function RealKits() {
  const [rows, setRows] = useState<KitRow[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setErr(""); listKits().then(setRows).catch((e) => setErr(say(e))); }, []);
  useEffect(load, [load]);
  const remove = (k: KitRow) => { setBusy(true); removeKit(k.id).then(() => { showToast(`${kitName(k.id)} is removed. Your records stay.`); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  const shown = rows ? listed(rows) : [];
  return (
    <Frame back="/u/flows" title="Kits" sub="Ready-made record types, Flows and views for a kind of work. Installing one is a grant you approve.">
      <Sec title="Installed">
        {err ? <Card flush><EmptyState title="Kits did not answer" body={err} action={{ label: "Try again", onPress: load }} /></Card> : null}
        {rows === null && !err ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
        {rows && !shown.length ? <Card><EmptyState title="No Kits installed" body="A Kit proposed to this space waits for your yes in Now. Removing one later takes its definitions away and never your records." /></Card> : null}
        {shown.length ? (
          <Card flush>
            {shown.map((k, i) => (
              <View key={k.id}>{i ? <Divider /> : null}
                <Row lead={<IconTile icon="box" />} title={kitName(k.id)} sub={kitLine(k)}
                  end={k.status === "installed" ? <Button kind="holdText" size="sm" label="Remove" disabled={busy} onPress={() => remove(k)} /> : <Chip>{statusWord(k.status)}</Chip>} />
              </View>
            ))}
          </Card>
        ) : null}
      </Sec>
      <Text size="caption" tone="label">The Kit's own text counts as outside text until you have read it. Removing a Kit never removes records.</Text>
    </Frame>
  );
}
