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
import { TypeCode, redeemPairing } from "../devices/TypeCode";
import { ADD, FOUND, foundLine, foundRows, serverRows, serversLine } from "./servers-model.js";

export default function ServersScreen() {
  const [rows, setRows] = useState<ReturnType<typeof serverRows> | null>(null);
  const [adding, setAdding] = useState(false);
  // What the person's other devices found (the list in the personal vault). Read when this screen opens and not again; it is gone when the screen is.
  const [found, setFound] = useState<{ found: any[]; confirm: any[]; failed: any[] }>({ found: [], confirm: [], failed: [] });
  const [connecting, setConnecting] = useState(false);
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
  useEffect(() => {
    if (!peerWanted()) return;
    let live = true;
    void import("../../src/real/space-list-app").then((m) => m.listFound()).then((r) => { if (live) setFound({ found: r.found, confirm: r.confirm, failed: [] }); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const connect = async (entries: any[]) => {
    setConnecting(true);
    try {
      const out = await (await import("../../src/real/space-list-app")).connectFound(entries);
      const tried = new Set(entries.map((e) => e.id));
      setFound((f) => ({ found: f.found.filter((e) => !tried.has(e.id)), confirm: f.confirm, failed: [...f.failed.filter((x) => !tried.has(x.entry.id)), ...out.failed] }));
    } finally { setConnecting(false); void load(); }
  };
  const foundList = foundRows(found);
  return (
    <Page title="Servers" sub={serversLine(rows?.length ?? 0)} back="/u/settings">
      {rows && rows.length ? (
        <Card flush>{rows.map((r) => <Row key={r.key} title={r.name} sub={r.sub} end={r.active && rows.length > 1 ? <Chip>Main</Chip> : undefined} />)}</Card>
      ) : rows ? (
        <Card><EmptyState title="No server yet" body={serversLine(0)} /></Card>
      ) : null}
      {foundList.length ? (
        <Card className="gap-s2">
          <Text strong>{FOUND.title}</Text>
          <Text tone="muted">{foundLine(foundList.length)}. {FOUND.body}</Text>
          {foundList.map((r) => (
            <Row key={r.key} title={r.name} sub={r.sub} end={r.action ? <Button label={r.action} disabled={connecting} onPress={() => void connect([[...found.found, ...found.failed.map((f) => f.entry)].find((e) => e.id === r.key)].filter(Boolean))} /> : undefined} />
          ))}
          {foundList.filter((r) => r.action).length > 1 ? <View className="flex-row"><Button label="Connect all" disabled={connecting} onPress={() => void connect([...found.found, ...found.failed.map((f) => f.entry)])} /></View> : null}
        </Card>
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
      {adding ? null : (
        <Card className="gap-s2">
          <Text strong>Have a code from another device?</Text>
          <Text tone="muted">On a device already paired to that server, open Devices, Add a device, and type the code it shows here.</Text>
          <TypeCode redeem={redeemPairing} onDone={() => { void load(); }} />
        </Card>
      )}
    </Page>
  );
}
