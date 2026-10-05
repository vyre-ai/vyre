// Shared links on the real box: the links made from the space's Drive (files.drive.link.list), Copy, and Stop (files.drive.link.revoke, which deletes the copy). Making one is the
// Ask card in SpaceDrive: nothing is shared until the person says yes to it.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Button, Card, Divider, EmptyState, ErrorState, IconTile, LoadingState, Row, showToast } from "@vyre/ui";
import { boxOrigin } from "../../src/api/box";
import { linkAddress, linkLine, linkRefusal, linksSorted, type LinkRow } from "./space-model";
import { linkList, linkRevoke } from "./real";

const say = (e: unknown) => linkRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

/** `refresh` changes when SpaceDrive makes a link, so the tab shows it without a reload. */
export function SharedLinks({ refresh }: { refresh: number }) {
  const [rows, setRows] = useState<LinkRow[] | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => { setErr(""); linkList().then(setRows).catch((e) => setErr(say(e))); }, []);
  useEffect(load, [load, refresh]);
  const copy = async (l: LinkRow) => {
    try { await Clipboard.setStringAsync(linkAddress(boxOrigin() || "", l)); showToast("Link copied."); } catch { showToast("This device would not copy it."); }
  };
  const stop = (l: LinkRow) => linkRevoke(l.code).then(() => { showToast("Link stopped. It no longer opens."); load(); }).catch((e) => showToast(say(e)));
  if (err) return <Card flush><ErrorState title="Shared links did not load" reason={err} retry={load} /></Card>;
  if (rows === null) return <LoadingState rows={3} />;
  const now = Date.now();
  return (
    <Card flush>
      {rows.length ? linksSorted(rows).map((l, i) => (
        <View key={l.code}>{i ? <Divider /> : null}
          <Row dense lead={<IconTile name="share" tone={l.active ? "accent" : "text-2"} />} title={l.name} sub={linkLine(l, now)}
            end={l.active ? <View className="flex-row items-center"><Button kind="ghost" size="sm" label="Copy" onPress={() => copy(l)} /><Button kind="holdText" size="sm" label="Stop" onPress={() => stop(l)} /></View> : undefined} />
        </View>
      )) : <EmptyState title="No shared links" body="Open a file and choose Share a link. You say yes before anything is made." />}
    </Card>
  );
}
