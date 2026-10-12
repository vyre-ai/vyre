// /u/settings/servers: the servers this device is paired to and the Space on each, with an always-there door to add another. A phone, browser or Windows PC lists its own pairings and each server's Spaces
// (src/real/space-servers.ts); the Mac lists what its own daemon is paired to (spaces.servers). Adding goes through the same card every server joins by (AddServerCard).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, EmptyState, Row, Text } from "@vyre/ui";
import { Page } from "../places/Frame";
import { listPairings, loadPairing, subscribePairings } from "../../src/api/relay";
import { peerWanted } from "../../src/real/peer";
import { tool } from "../../src/real/box";
import { AddServerCard } from "./AddServerCard";
import { ADD, serverRows, serversLine } from "./servers-model.js";

export default function ServersScreen() {
  const [rows, setRows] = useState<ReturnType<typeof serverRows> | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    if (peerWanted()) {
      const { listAllSpaces, offlineServers } = await import("../../src/real/space-servers");
      const [pairings, active, spaces] = await Promise.all([listPairings(), loadPairing(), listAllSpaces().catch(() => null)]);
      setRows(serverRows({ pairings, spaces: spaces ?? (await tool<any[]>("spaces.list").catch(() => [])), offline: offlineServers(), active: active?.box ?? null }));
      return;
    }
    const d = await tool<{ servers?: { id: string; name: string }[] }>("spaces.servers").catch(() => null);
    setRows(serverRows({ pairings: (d?.servers ?? []).map((s) => ({ box: s.id, name: s.name })), spaces: [], offline: [], active: null }));
  }, []);
  useEffect(() => { void load(); return subscribePairings(() => { void load(); }); }, [load]);
  return (
    <Page title="Servers" sub={serversLine(rows?.length ?? 0)} back="/u/settings">
      {rows && rows.length ? (
        <Card flush>{rows.map((r) => <Row key={r.key} title={r.name} sub={r.sub} end={r.active && rows.length > 1 ? <Chip>Main</Chip> : undefined} />)}</Card>
      ) : rows ? (
        <Card><EmptyState title="No server yet" body={serversLine(0)} /></Card>
      ) : null}
      {adding ? (
        <AddServerCard onDone={() => { setAdding(false); void load(); }} />
      ) : (
        <Card className="gap-s2">
          <Text strong>{ADD.title}</Text>
          <Text tone="muted">{ADD.body}</Text>
          <View className="flex-row"><Button label={ADD.action} onPress={() => setAdding(true)} /></View>
        </Card>
      )}
    </Page>
  );
}
