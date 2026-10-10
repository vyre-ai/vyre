import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Button, Card, Chip, Divider, EmptyState, Segmented, Text, showToast, markRef, IconTile } from "@vyre/ui";
import { Page } from "../places/Frame";
import { ACCESS_FILTERS, glyph } from "./data";
import { useDevices } from "./state";
import { removeText } from "./wink.js";
import { said, MOCK } from "../../src/real/box";
import { RealPlugin } from "./RealPlugin";
import { AccessList } from "./AccessList";

/** Everything that can reach your things: devices, people, assistants, Kits and Flows, with a held Remove. */
export function AccessScreen() {
  const router = useRouter();
  const { items, removeItem, load, error } = useDevices();
  useEffect(() => { void load(); }, [load]);
  const [f, setF] = useState("all");
  const rows = items.filter((i) => f === "all" || i.kind === f);
  return (
    <Page title="Access" sub="Who and what can reach your spaces." back="/u/settings"
      actions={<Button kind="primary" size="sm" icon="plus" label="Add or invite" onPress={() => router.push("/u/wink" as never)} />}>
      {MOCK ? null : <RealPlugin onChanged={() => void load()} />}
      <Segmented label="Show" value={f} onChange={setF} options={ACCESS_FILTERS} />
      <AccessList rows={rows} empty={error ?? "Nothing of this kind can reach your spaces."} onRemove={(a) => { removeItem(a.id).then(() => showToast(`${a.name} was removed.`)).catch((e) => showToast(said(e))); }} />
    </Page>
  );
}
