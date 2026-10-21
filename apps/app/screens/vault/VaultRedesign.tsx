// The Vault: an .env you can share safely. Two places, Mine (only you) and Shared (the Space: its people and agents, in folders). An item is a name and fields named like
// environment variables; the list shows each item's fields, who can use it and what uses it, and search finds an item by its name or any field's name. What Vyre's modules
// still need is asked for at the top, one tap from the Add sheet on that app's template. Everything rare is on Advanced.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Platform, View, useWindowDimensions } from "react-native";
import { Banner, Button, Card, Chip, EmptyState, ErrorState, Field, GroupedList, IconButton, IconTile, LoadingState, MenuRow, Row, Segmented, Sheet, Text, showToast, type IconName } from "@vyre/ui";
import { Footnote, Frame } from "../places/Frame";
import { usePhone } from "../places/Page";
import { breakage, healthOf, HEALTH_WORDS, navCounts, navEmpty, visible, type VItem } from "./redesign.js";
import type { Scope, Suggestion, VaultData } from "./redesign-data";
import { AddSheet, type Call } from "./AddSheet";
import { VAULT_PANEL_MIN, useVaultNav } from "./vault-nav";
import { VaultItem } from "./VaultItem";
import { VaultsScreen } from "./VaultsScreen";
import VaultAdvanced from "./VaultAdvanced";
import { within } from "../../src/state/kept-model.js";
import { needPrompts, type Need, type Saved } from "./add-model.js";
import { fieldLabel } from "./env-model.js";
import { putRefusal } from "./real-model";
import type { Event } from "./sample-redesign";

const ICON: Record<string, IconName> = { "Apps you connected": "link", "AI models": "spark", "Email and sending": "mail", "Phone and texts": "phone", "Google and Microsoft": "globe", "Code and hosting": "term", Messaging: "chat", Logins: "globe", "SSH keys": "term", "Secure notes": "file", "Any API key": "key" };
const TONE = { ok: "ok", expiring: "warn", expired: "err", unused: "plain" } as const;
/** The words for a save the computer could not approve (the owner's ruling of 19 Oct: with no approval device set up, a person's own act goes through). */
const saveWords = (e: unknown) => {
  const code = (e as { code?: string }).code;
  if (code === "presence_required" || code === "needs_presence") return "This needs your approval. Approve it in Vyre on your phone, or with Touch ID in a signed app on this computer. With no approval device set up, your own changes go through without one.";
  return putRefusal(code, String((e as Error)?.message || ""));
};
/** Who can use an item, in one line for the list. */
const whoLine = (v: VItem) => (v.sp === "mine" ? (v.shared.length ? "You, and what you lent it to" : "Only you") : v.can ? (v.can.includes("edit") ? "You can change it" : v.can.includes("reveal") ? "You can see it" : "You can use it") : v.folder ? `Everyone in ${v.folder.name}` : "Shared");

export default function VaultRedesign({ data }: { data: VaultData }) {
  const phone = usePhone();
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { scope, nav, setScope, setNav, setCounts } = useVaultNav();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<VItem[] | null>(null);
  const [owner, setOwner] = useState(true);
  const [locked, setLocked] = useState(false);
  const [noAccount, setNoAccount] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addOn, setAddOn] = useState<string | null>(null);
  const [addProblem, setAddProblem] = useState("");
  const [needs, setNeeds] = useState<Need[]>([]);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  // A Needs you card, or a module that needs a key, opens /u/vault?add=1 or /u/vault?need=<module>:<id>; a chat's "Add the site to this login" opens /u/vault?item=<name>.
  // ?add=<name>&kind=<login|api-key> (a stuck task's "Add the key", a Flow step's missing key) opens a login or a blank item with that name.
  const want = useLocalSearchParams<{ add?: string; kind?: string; need?: string; item?: string }>();
  useEffect(() => {
    if (want.need) { setAddOn(`need:${String(want.need)}`); setAdding(true); }
    else if (want.add) { setAddOn(want.add === "1" ? null : `${want.kind === "login" ? "login" : "blank"}:${String(want.add)}`); setAdding(true); }
  }, [want.add, want.need, want.kind]);
  useEffect(() => { if (want.item) { setScope("mine"); setSel(String(want.item)); } }, [want.item]);

  const load = useCallback(() => {
    setErr("");
    within(data.load(scope)).then((r) => { setItems(r.items); setLocked(r.locked); setNoAccount(Boolean(r.noAccount)); setOwner(r.owner !== false); }).catch((e) => setErr(String(e?.message || "The vault did not answer.")));
    data.needs?.().then(setNeeds).catch(() => setNeeds([]));
    data.templates?.().then(setSaved).catch(() => setSaved([]));
    data.folders?.list().then((xs) => setFolders(xs.map((x) => ({ id: x.id, name: x.name })))).catch(() => setFolders([]));
  }, [data, scope]);
  // the last copy stays on screen while the next one loads (the product map's speed rule): only a scope switch starts the list over
  useEffect(() => { setItems(null); }, [scope]);
  useEffect(load, [load]);

  const shown = useMemo(() => (items ? visible(items, scope, q, nav) : []), [items, scope, q, nav]);
  useEffect(() => { if (items) setCounts(navCounts(visible(items, scope))); }, [items, scope, setCounts]);
  const cur = shown.find((v) => v.id === sel) ?? (phone ? undefined : shown[0]);
  useEffect(() => { setEvents([]); if (cur) data.events(scope, cur).then(setEvents).catch(() => setEvents([])); }, [cur?.id, scope, data]);
  const asks = owner ? needPrompts(needs) : [];

  const save = async (calls: Call[], label: string, folder: string | null) => {
    setBusy(true); setAddProblem("");
    try {
      let into = folder;
      if (scope === "shared" && owner && !into && data.folders) into = await data.folders.make("Team");
      for (const c of calls) await data.add(scope, c, into);
      setAdding(false); setAddOn(null); showToast(`${label} added.`); load();
    } catch (e) { setAddProblem(saveWords(e)); } finally { setBusy(false); }
  };
  const suggest = data.suggest ? (app: string): Promise<Suggestion> => data.suggest!(app).then((s) => { if (s.source === "ai") data.templates?.().then(setSaved).catch(() => {}); return s; }) : undefined;

  if (scope === "mine" && noAccount) {
    return (
      <Frame title="Vault" sub="Make your own vault.">
        <Scoper scope={scope} onScope={setScope} />
        <Card>
          <View className="gap-s3 py-s4">
            <View className="items-center gap-s2"><IconTile name="vault" /><Text size="title" strong>Make your own vault</Text>
              <Text tone="label" className="text-center">It holds your own keys and logins. Only you can open it, with a password you choose. This device keeps the key that goes with it.</Text></View>
            <Field name="Password" kind="password" value={pw} onChangeText={setPw} placeholder="Choose a password (12 or more characters)" />
            <Button kind="primary" label="Make my vault" disabled={busy} onPress={() => { if (pw.length < 12) { showToast("A password is at least 12 characters."); return; } setBusy(true); data.create(pw).then(() => { setPw(""); load(); }).catch((e) => showToast(saveWords(e))).finally(() => setBusy(false)); }} />
          </View>
        </Card>
      </Frame>
    );
  }
  if (scope === "mine" && locked && !owner) {
    return (
      <Frame title="Vault" sub="Your own vault is locked.">
        <Scoper scope={scope} onScope={setScope} />
        <Card>
          <View className="gap-s3 py-s4">
            <View className="items-center gap-s2"><IconTile name="lock" /><Text size="title" strong>Your vault is locked</Text><Text tone="label" className="text-center">Unlock it with your password. Nothing in it is shown until you do.</Text></View>
            <Field name="Password" kind="password" value={pw} onChangeText={setPw} placeholder="Password" />
            <Button kind="primary" label="Unlock" disabled={busy} onPress={() => { if (!pw) { showToast("Type your password."); return; } setBusy(true); data.unlock(pw).then(() => { setPw(""); load(); }).catch((e) => showToast(saveWords(e))).finally(() => setBusy(false)); }} />
          </View>
        </Card>
      </Frame>
    );
  }

  const row = (v: VItem) => {
    const h = healthOf(v);
    const names = (v.fields ?? []).map((f) => fieldLabel(v.kind, f.name));
    return (
      <MenuRow key={v.id} items={[{ label: "Open", onPress: () => setSel(v.id) }, ...(owner || v.sp === "mine" ? [{ label: "Delete", danger: true, onPress: () => setDel(v.id) }] : [])]}>
        {(menu) => (
          <Row dense chevron={phone} selected={!phone && cur?.id === v.id} lead={<IconTile name={ICON[v.group] ?? "key"} />} title={v.name}
            sub={`${names.length ? names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "") : v.detail}. ${whoLine(v)}${v.usedBy.length ? `. Used by ${v.usedBy.length}` : ""}.`}
            end={<View className="flex-row items-center gap-s1">{h !== "ok" && h !== "unused" ? <Chip tone={TONE[h]}>{HEALTH_WORDS[h]}</Chip> : null}{menu}</View>} onPress={() => setSel(v.id)} />
        )}
      </MenuRow>
    );
  };

  const folderOf = (v: VItem) => v.folder?.name ?? "Not in a folder";
  const list = err ? <ErrorState title="The vault did not answer" reason={err} retry={load} /> : items === null ? <LoadingState /> : (
    <View className="gap-s3">
      {nav.kind !== "all" ? <View className="flex-row items-center justify-between gap-s2"><Text tone="label">{nav.kind === "folder" ? nav.folder : nav.kind === "group" ? nav.group : nav.kind === "expiring" ? "Expiring" : "Shared with me"}</Text><Button kind="ghost" size="sm" label="Show everything" onPress={() => setNav({ kind: "all" })} /></View> : null}
      <Field name="Search the vault" value={q} onChangeText={setQ} placeholder="Search names and fields, like LOCATION_ID" />
      {shown.length ? (scope === "shared"
        ? <GroupedList groups={[...new Set(shown.map(folderOf))].map((name) => ({ name }))} items={shown.map((v) => ({ ...v, group: folderOf(v) }))} itemNoun="items" renderItems={(xs) => <Card flush>{(xs as VItem[]).map((x) => row(shown.find((v) => v.id === x.id) ?? x))}</Card>} />
        : <Card flush>{shown.map(row)}</Card>)
        : <EmptyState title="Nothing here" body={q ? "No item has that name or field." : nav.kind !== "all" ? navEmpty(nav) : scope === "mine" ? "Nothing in Mine yet. Add an item, or paste an .env." : owner ? "Nothing is shared yet. Add an item here, or move one from Mine." : "Nothing is shared with you yet."} />}
    </View>
  );

  const detail = cur ? <VaultItem item={cur} scope={scope} data={data} owner={owner} needs={needs} events={events} onChanged={load} onDelete={() => setDel(cur.id)} /> : null;

  const gone = items?.find((v) => v.id === del);
  const sheet = (
    <Sheet open={!!gone} onClose={() => setDel(null)} title={gone ? `Delete ${gone.name}?` : undefined}>
      {gone ? (
        <View className="gap-s3">
          <Text>{breakage(gone)}</Text>
          <View className="flex-row gap-s2"><Button kind="danger" label="Delete" onPress={() => { data.remove(scope, gone).then(() => { setSel(null); setDel(null); showToast(`${gone.name} deleted.`); load(); }).catch((e) => showToast(saveWords(e))); }} /><Button kind="ghost" label="Keep it" onPress={() => setDel(null)} /></View>
        </View>
      ) : null}
    </Sheet>
  );
  const canAdd = scope === "mine" || owner;
  const addSheet = (
    <AddSheet open={adding} scope={scope} member={!owner} busy={busy} problem={addProblem} onClose={() => { setAdding(false); setAddOn(null); }} onSave={(c, l, f) => void save(c, l, f)}
      needs={needs} saved={saved} suggest={suggest} want={addOn} folders={folders} />
  );

  if (phone && cur && sel) return <Frame title={cur.name} sub={cur.folder ? cur.folder.name : "Mine"} onBack={() => setSel(null)}>{detail}{sheet}{addSheet}</Frame>;

  const add = () => { setAddProblem(""); setAddOn(null); setAdding(true); };
  return (
    <Frame title="Vault" sub="Your keys and logins, like an .env you can share safely." actions={<View className="flex-row items-center gap-s2">
      {data.real && owner && scope === "shared" ? <Button kind="ghost" size="sm" icon="folder" label="Folders" onPress={() => setFoldersOpen(true)} /> : null}
      {data.real ? <Button kind="ghost" size="sm" label="Advanced" onPress={() => setAdvancedOpen(true)} /> : null}
      {canAdd ? (phone ? <IconButton icon="plus" label="Add" kind="primary" onPress={add} /> : <Button kind="primary" size="sm" icon="plus" label="Add" onPress={add} />) : null}
    </View>}>
      <Scoper scope={scope} onScope={setScope} />
      {asks.map((a) => <Banner key={a.id} tone="warn" icon="bolt"><View className="flex-row flex-wrap items-center gap-s2"><Text>{a.text}</Text><Button kind="secondary" size="sm" label="Add it" onPress={() => { setAddProblem(""); setAddOn(a.template); setAdding(true); }} /></View></Banner>)}
      <Footnote icon="shield">{scope === "mine" ? "Mine is only yours. Agents and Flows use an item by placeholder, and never see a secret." : "Shared is the Space's: its people and agents use these by placeholder, and never see a secret unless you let them."}</Footnote>
      <View className={phone ? "gap-s4" : "flex-row items-start gap-s4"}>
        <View className={phone ? "" : "min-w-0 flex-1"}>{list}</View>
        {phone ? null : <View className="min-w-pane min-w-0 flex-[1.2]">{detail}</View>}
      </View>
      {sheet}{addSheet}
      {foldersOpen ? <Sheet open onClose={() => setFoldersOpen(false)} title="Folders"><VaultsScreen embedded /></Sheet> : null}
      {advancedOpen ? <Sheet open onClose={() => setAdvancedOpen(false)} title="Advanced"><VaultAdvanced embedded /></Sheet> : null}
    </Frame>
  );
}

/** Mine or Shared. On a wide web screen the sidebar's Vault panel has it, so the page does not repeat it. */
function Scoper({ scope, onScope }: { scope: Scope; onScope: (s: Scope) => void }) {
  const { width } = useWindowDimensions();
  if (Platform.OS === "web" && width >= VAULT_PANEL_MIN) return null;
  return <Segmented<Scope> label="Which place" options={[["mine", "Mine"], ["shared", "Shared"]]} value={scope} onChange={onScope} />;
}
