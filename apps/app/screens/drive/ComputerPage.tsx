// "On your computer" in Files: what the server shares with this computer over VyreDrive and how, and the files your computers send each other. Every act is an existing files.* tool (files.drive.offer,
// unshare, access, audit, files.receive, files.drop.targets, files.drop.pending); what a tool answers in a shape this page does not know is shown as its plain count or left out, never guessed.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, Field, LoadingState, Row, Segmented, Text, showToast } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { workedInLately, workedLine, type WorkedFolder } from "./computer-recent";
import type { Status } from "./real-model";

const say = (e: unknown) => (e instanceof Error && e.message ? e.message : "Vyre did not do that.");
type Device = { id: string; name: string; kind?: string; online?: boolean; ready?: boolean };

export function ComputerPage({ status, reload }: { status: Status | null; reload: () => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [audit, setAudit] = useState<string | null>(null);
  const [offer, setOffer] = useState({ path: "", name: "", access: "ro" as "ro" | "rw" });
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState<boolean | null>(null);
  const [worked, setWorked] = useState<WorkedFolder[] | null>(null);
  const load = useCallback(() => {
    tool<{ devices?: Device[] }>("files.drop.targets", {}).then((r) => setDevices(r?.devices ?? [])).catch(() => setDevices([]));
    tool<{ drops?: unknown[] }>("files.drop.pending", {}).then((r) => setPending(Array.isArray(r?.drops) ? r!.drops!.length : 0)).catch(() => setPending(null));
    tool<unknown>("files.recent", { limit: 8 }).then((r) => setWorked(workedInLately(r))).catch(() => setWorked([]));
  }, []);
  useEffect(load, [load]);
  const run = (f: () => Promise<unknown>, done: string) => { setBusy(true); f().then(() => { showToast(done); reload(); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  const shares = (status?.shares ?? []).filter((s) => s.shared);
  return (
    <View className="gap-s3">
      <Card>
        {status ? <View className="gap-s2"><Text strong>{status.enabled ? "Sharing to your computer is on" : "Sharing to your computer is off"}</Text>{status.why ? <Text tone="muted">{status.why}</Text> : null}{status.fix ? <Text tone="label">{status.fix}</Text> : null}</View> : <LoadingState rows={2} />}
      </Card>
      <Card flush>
        <View className="p-s3"><Text strong>Worked in lately</Text><Text size="caption" tone="muted">Folders chats worked in, newest first.</Text></View>
        <Divider />
        {worked === null ? <LoadingState rows={2} /> : worked.length ? worked.map((f, i) => (
          <View key={f.path}>{i ? <Divider /> : null}<Row title={f.name} sub={workedLine(f)} /></View>
        )) : <EmptyState title="No folders yet" body="Folders your chats work in show up here." />}
      </Card>
      <Card flush>
        <View className="p-s3"><Text strong>Folders shared with this computer</Text></View>
        <Divider />
        {shares.length ? shares.map((s, i) => (
          <View key={s.name}>{i ? <Divider /> : null}
            <Row title={s.name} sub={s.access === "rw" ? "Read and write" : "Read only"}
              end={<View className="flex-row gap-s2">
                <Button size="sm" kind="ghost" label={s.access === "rw" ? "Make read only" : "Allow writing"} disabled={busy} onPress={() => run(() => tool("files.drive.access", { name: s.name, mode: s.access === "rw" ? "ro" : "rw" }), "Changed.")} />
                <Button size="sm" kind="holdText" label="Stop sharing" disabled={busy} onPress={() => run(() => tool("files.drive.unshare", { name: s.name }), "Stopped sharing.")} />
              </View>} />
          </View>
        )) : <EmptyState title="Nothing is shared" body="Share one of the server's folders below, and it opens on this computer." />}
      </Card>
      <Card>
        <View className="gap-s2">
          <Text strong>Share a folder from the server</Text>
          <Field label="Folder on the server" value={offer.path} onChangeText={(path: string) => setOffer({ ...offer, path })} placeholder="/srv/clients" />
          <Field label="Name (optional)" value={offer.name} onChangeText={(name: string) => setOffer({ ...offer, name })} />
          <Segmented label="Access" value={offer.access} onChange={(access: "ro" | "rw") => setOffer({ ...offer, access })} options={[["ro", "Read only"], ["rw", "Read and write"]]} />
          <View className="self-start"><Button kind="primary" size="sm" label={busy ? "Working" : "Share"} disabled={busy || !offer.path.trim()} onPress={() => run(() => tool("files.drive.offer", { path: offer.path.trim(), ...(offer.name.trim() ? { name: offer.name.trim() } : {}), access: offer.access }), "Shared.")} /></View>
        </View>
      </Card>
      <Card>
        <View className="gap-s2">
          <Text strong>Who else can reach these folders</Text>
          <Text tone="muted">Checks the network policy for any other online device that could open them.</Text>
          <View className="self-start"><Button kind="ghost" size="sm" label="Check now" disabled={busy} onPress={() => { setBusy(true); tool<{ findings?: unknown[] }>("files.drive.audit", {}).then((r) => setAudit(Array.isArray(r?.findings) ? (r!.findings!.length ? `${r!.findings!.length} other device${r!.findings!.length === 1 ? "" : "s"} can reach them.` : "Nobody else can reach them.") : "Checked.")).catch((e) => showToast(say(e))).finally(() => setBusy(false)); }} /></View>
          {audit ? <Banner><Text>{audit}</Text></Banner> : null}
        </View>
      </Card>
      <Card flush>
        <View className="p-s3 gap-s2"><Text strong>Send files between your computers</Text><Text tone="muted">A file sent from the server waits, sealed, until the other computer is on and receiving.</Text></View>
        <Divider />
        {devices === null ? <LoadingState rows={2} /> : devices.length ? devices.map((d, i) => <View key={d.id}>{i ? <Divider /> : null}<Row title={d.name} sub={[d.kind, d.online ? "online" : "offline", d.ready ? "can receive" : "not set up to receive"].filter(Boolean).join(", ")} /></View>) : <EmptyState title="No other computers" body="Pair another computer to send it files." />}
        <Divider />
        <Row title="Receive files on this computer" sub={pending ? `${pending} waiting` : "Off by default"} end={<View className="flex-row gap-s2"><Button size="sm" kind="ghost" label="Turn on" disabled={busy} onPress={() => run(() => tool("files.receive", { on: true }).then(() => setReceiving(true)), "Receiving is on.")} /><Button size="sm" kind="ghost" label="Turn off" disabled={busy} onPress={() => run(() => tool("files.receive", { on: false }).then(() => setReceiving(false)), "Receiving is off.")} /></View>} />
        {receiving !== null ? <View className="p-s3"><Text size="caption" tone="label">{receiving ? "This computer takes in files your other computers send." : "This computer does not take in files."}</Text></View> : null}
      </Card>
    </View>
  );
}
