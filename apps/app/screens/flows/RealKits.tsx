// Kits from the real box: the Kits installed in the space (flows.kit.list), Remove (flows.kit.remove, a person's own act), and the library the box offers
// (flows.kit.library, when the box has it): read the install card, then ask to install, which lands as a card in Now for a person to approve.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, Row, Sheet, Text, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { IconTile } from "../places/Page";
import { Frame, Sec } from "../places/Frame";
import { useRouter } from "expo-router";
import { InstalledKits, AvailableKits } from "./KitsLists";
import { addsLine, available, cardLines, kitLine, kitName, kitRefusal, listed, proposeNote, statusWord, updatesOf, type KitRow, type LibraryKit } from "./kits-model";
import { kitCard, listKits, listLibrary, proposeKit, removeKit } from "./kits";

const say = (e: unknown) => kitRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

export function RealKits() {
  const router = useRouter();
  const [rows, setRows] = useState<KitRow[] | null>(null);
  const [err, setErr] = useState("");
  const [lib, setLib] = useState<LibraryKit[] | null>(null);
  const [open, setOpen] = useState<{ id: string; name: string; kit: unknown; card: ReturnType<typeof cardLines> } | null>(null);
  const [loadingCard, setLoadingCard] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setErr(""); listKits().then(setRows).catch((e) => setErr(say(e))); listLibrary().then(setLib).catch(() => setLib(null)); }, []);
  const read = (k: LibraryKit) => {
    setLoadingCard(k.id); setNote(null);
    kitCard(k.id).then((r) => setOpen({ id: k.id, name: k.name ?? kitName(k.id), kit: r.kit, card: cardLines(r.card as never) })).catch((e) => showToast(say(e))).finally(() => setLoadingCard(""));
  };
  const ask = () => {
    if (!open) return;
    setBusy(true);
    proposeKit(open.kit).then((r) => { const n = proposeNote(r); setNote(n); if (n.ok) { showToast(n.text); setOpen(null); load(); } }).catch((e) => setNote({ ok: false, text: say(e) })).finally(() => setBusy(false));
  };
  useEffect(load, [load]);
  const remove = (k: KitRow) => { setBusy(true); removeKit(k.id).then(() => { showToast(`${kitName(k.id)} is removed. Your records stay.`); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  const shown = rows ? listed(rows) : [];
  const offer = lib && rows ? available(lib, rows) : [];
  const newer = lib && rows ? updatesOf(rows, lib) : {};
  return (
    <Frame back="/u/flows" title="Kits" sub="Ready-made record types, Flows and views for a kind of work. Installing one is a grant you approve.">
      <Sec title="Installed">
        {err ? <Card flush><ErrorState title="Kits did not load" reason={err} retry={load} /></Card> : null}
        {rows === null && !err ? <LoadingState rows={3} /> : null}
        {rows && !shown.length ? <Card><EmptyState title="No Kits installed" body={offer.length ? "Pick one below to read what it adds. Removing one later takes its definitions away and never your records." : "A Kit proposed to this space waits for your yes in Now. Removing one later takes its definitions away and never your records."} /></Card> : null}
        {shown.length ? (
          <InstalledKits shown={shown} newer={newer} busy={busy} onUpdate={(k) => router.push(`/u/kits/${k.id}` as never)} onRemove={remove} />
        ) : null}
      </Sec>
      {offer.length ? (
        <Sec title="Available">
          <AvailableKits offer={offer} loadingCard={loadingCard} onRead={read} />
        </Sec>
      ) : null}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open ? `Install ${open.name}` : ""}>
        {open ? (
          <View className="gap-s3">
            <Text size="caption" tone="label">What this Kit adds. Its own text counts as outside text until you have read it.</Text>
            {open.card.lines.length ? <Card flush>{open.card.lines.map((l, i) => <View key={l}>{i ? <Divider /> : null}<Row title={l} /></View>)}</Card> : <Text>This Kit adds nothing the box could list.</Text>}
            {open.card.notes.map((n) => <Banner key={n}><Text>{n}</Text></Banner>)}
            {open.card.blocked ? <Banner tone="warn"><Text>{open.card.blocked}</Text></Banner> : null}
            {note && !note.ok ? <Banner tone="warn"><Text>{note.text}</Text></Banner> : null}
            <Button kind="primary" label={busy ? "Asking" : "Ask to install"} disabled={!!open.card.blocked} onPress={busy ? () => {} : ask} />
            <Text size="caption" tone="label">This changes nothing yet. It puts a card in Now for you to approve.</Text>
          </View>
        ) : null}
      </Sheet>
      <Text size="caption" tone="label">The Kit's own text counts as outside text until you have read it. Removing a Kit never removes records.</Text>
    </Frame>
  );
}
