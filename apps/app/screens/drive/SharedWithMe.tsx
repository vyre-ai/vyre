// Files other people shared with you (files.with.list). Reading one is files.with.read.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Divider, EmptyState, ErrorState, IconTile, LoadingState, Row } from "@vyre/ui";
import { tool } from "../../src/real/box";

type Share = { path: string; by: string; at: number };

const nameOf = (p: string) => p.split("/").pop() || p;

export function SharedWithMe() {
  const [rows, setRows] = useState<Share[] | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    tool<{ shares?: Share[] }>("files.with.list", {}).then((r) => setRows(r?.shares ?? [])).catch((e) => setErr(e instanceof Error ? e.message : "Shared files did not load."));
  }, []);
  useEffect(load, [load]);
  if (err) return <Card flush><ErrorState title="Shared with me did not load" reason={err} retry={load} /></Card>;
  if (rows === null) return <LoadingState rows={3} />;
  return (
    <Card flush>
      {rows.length ? rows.map((r, i) => (
        <View key={`${r.path}:${r.at}`}>{i ? <Divider /> : null}
          <Row dense lead={<IconTile name="share" tone="accent" />} title={nameOf(r.path)} sub={`Shared by ${r.by}`} />
        </View>
      )) : <EmptyState title="Nothing shared with you" body="When someone shares a file with you, it shows up here." />}
    </Card>
  );
}
