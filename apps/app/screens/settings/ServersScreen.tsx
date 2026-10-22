// /u/settings/servers: the servers this device is paired to and the Space on each, with an always-there door to add another. A phone, browser or Windows PC lists its own pairings and each server's Spaces
// (src/real/space-servers.ts); the Mac lists what its own daemon is paired to (spaces.servers). Adding goes through the same card every server joins by (AddServerCard).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, EmptyState, ErrorState, Row, Text } from "@vyre/ui";
import { EmbedPage } from "./embed";
import { within } from "../../src/state/kept-model.js";
import { listPairings, loadPairing, subscribePairings } from "../../src/api/relay";
import { peerWanted } from "../../src/real/peer";
import { tool } from "../../src/real/box";
import { AddServerCard } from "./AddServerCard";
import { ADD, FOUND, foundLine, foundRows, serverRows, serversLine } from "./servers-model.js";

export default function ServersScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const [rows, setRows] = useState<ReturnType<typeof serverRows> | null>(null);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  // What the person's other devices found (the list in the personal vault). Read when this screen opens and not again; it is gone when the screen is.
  const [found, setFound] = useState<{ found: any[]; confirm: any[]; failed: any[] }>({ found: [], confirm: [], failed: [] });
  const [connecting, setConnecting] = useState(false);
  const [fromList, setFromList] = useState<string[]>([]);
  const refreshFromList = useCallback(() => { void import("../../src/real/space-list-app").then((m) => m.fromListBoxes()).then(setFromList).catch(() => {}); }, []);
  useEffect(refreshFromList, [refreshFromList, rows]);
  const load = useCallback(async () => {
    setErr("");
    if (peerWanted()) {
      const { listAllSpaces, offlineServers } = await import("../../src/real/space-servers");
      const [pairings, active] = await Promise.all([listPairings(), loadPairing()]);
      let spaces: any[] = [];
      let offline: string[] = [];
      try {
        const listed = await listAllSpaces().catch(() => null);
        spaces = listed ?? (await tool<any[]>("spaces.list").catch(() => [])) ?? [];
        offline = offlineServers();
      } catch { /* a server that did not answer still leaves its pairing on the list */ }
      setRows(serverRows({ pairings, spaces, offline, active: active?.box ?? null }));
      return;
    }
    const d = await tool<{ servers?: { id: string; name: string }[] }>("spaces.servers").catch(() => null);
    setRows(serverRows({ pairings: (d?.servers ?? []).map((s) => ({ box: s.id, name: s.name })), spaces: [], offline: [], active: null }));
  }, []);
  useEffect(() => {
    const go = () => { void within(load()).catch((e) => setErr(e instanceof Error ? e.message : "Servers did not load.")); };
    go();
    return subscribePairings(go);
  }, [load]);
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
  const dropServer = (r: { key: string; spaceId: string; offline: boolean }) => {
    void (async () => {
      if (fromList.includes(r.key)) {
        await import("../../src/real/space-list-app").then((m) => m.removeFromList(r.key));
        refreshFromList();
      }
      if (r.offline) await import("../../src/real/drop-space").then((m) => m.removeFromComputer({ box: r.key, space: r.spaceId || undefined }));
      void load();
    })();
  };
  return (
    <EmbedPage embedded={embedded} title="Servers" sub={serversLine(rows?.length ?? 0)} back="/u/settings">
      {err ? <Card flush><ErrorState title="Servers did not load" reason={err} retry={() => { void within(load()).catch((e) => setErr(e instanceof Error ? e.message : "Servers did not load.")); }} /></Card> : null}
      {rows && rows.length ? (
        <Card flush>{rows.map((r) => <Row key={r.key} title={r.name} sub={fromList.includes(r.key) ? `Connected to ${r.name} from your list. ${r.sub}` : r.sub} end={r.offline || fromList.includes(r.key) ? <Button label="Remove" onPress={() => dropServer(r)} /> : r.active && rows.length > 1 ? <Chip>Main</Chip> : undefined} />)}</Card>
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
    </EmbedPage>
  );
}
