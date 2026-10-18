import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Platform, View, useWindowDimensions } from "react-native";
import { AccessList, Avatar, Banner, Button, IconButton, Card, Chip, EmptyState, ErrorState, Field, GroupedList, LoadingState, IconTile, MenuRow, Row, Segmented, Sheet, Text, SecretField, markRef, showToast, type IconName, type Level } from "@vyre/ui";
import { Footnote, Frame, Sec } from "../places/Frame";
import { usePhone } from "../places/Page";
import { HEALTH_WORDS, breakage, healthOf, navCounts, navEmpty, share, summaryOf, unshare, visible, type VItem } from "./redesign.js";
import { SAMPLE_PEOPLE, type Event } from "./sample-redesign";
import type { Scope, VaultData } from "./redesign-data";
import { AddSheet, type Call } from "./AddSheet";
import { VAULT_PANEL_MIN, useVaultNav } from "./vault-nav";
import ImportPage from "./ImportPage";
import { ItemSharing } from "./ItemSharing";
import { MoveItem } from "./MoveItem";
import { claimBlocked } from "../shell/rc";
import { ON_PHONE } from "../../src/real/on-phone.js";
import { putRefusal } from "./real-model";

import { SECTIONS, sectionOf } from "./vault-groups.js";
import { AccountNames, EarlierVersions, LinkedTo, MoveToVault, TaggedIn } from "./VaultRows";
const ICON: Record<string, IconName> = { "Apps you connected": "link", "AI models": "spark", "Email and sending": "mail", "Phone and texts": "phone", "Google and Microsoft": "globe", "Code and hosting": "term", Messaging: "chat", Logins: "key", "SSH keys": "term", "Secure notes": "file", "Any API key": "key" };
const who = (w: string) => markRef(w === "chris" || w === "alex" ? "person" : w === "iris" ? "assistant" : "teammate", w);
const TONE = { ok: "ok", expiring: "warn", expired: "err", unused: "plain" } as const;

/** The redesigned Vault: Space or Mine, items in groups, one item's detail with the SecretField, where it is used, who has it, health and what happened to it, and the locked card. `data` is the sample world or the real tools. */
export default function VaultRedesign({ data }: { data: VaultData }) {
  const phone = usePhone();
  const router = useRouter();
  // which vault and which group are open live in a store, so the sidebar's Vault panel and this page agree
  const { scope, nav, setScope, setNav, setCounts } = useVaultNav();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<VItem[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [noAccount, setNoAccount] = useState(false);
  const [noSpaceVault, setNoSpaceVault] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [local, setLocal] = useState<Event[]>([]);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  // A Needs you card for a stuck password or key opens the Add sheet for that item: /u/vault?add=<name>&kind=<login|api-key>.
  const want = useLocalSearchParams<{ add?: string; kind?: string; item?: string; site?: string }>();
  const wanted = want.add ? { name: want.add === "1" ? "" : String(want.add), kind: String(want.kind || "api-key") } : null;
  useEffect(() => { if (want.add) setAdding(true); }, [want.add]);
  const [addProblem, setAddProblem] = useState("");
  // The chat's "Add the site to this login" opens /u/vault?item=<name>&site=1: the member's own vault, that login selected, its site box open.
  const [siteFor, setSiteFor] = useState<string | null>(null);
  const [siteText, setSiteText] = useState("");
  const [siteProblem, setSiteProblem] = useState("");
  useEffect(() => { if (want.item) { setScope("mine"); setSel(String(want.item)); if (want.site) setSiteFor(String(want.item)); } }, [want.item, want.site]);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    setErr(""); setItems(null);
    data.load(scope).then((r) => { setItems(r.items); setLocked(r.locked); setNoAccount(Boolean(r.noAccount)); setNoSpaceVault(Boolean(r.noSpaceVault)); }).catch((e) => setErr(String(e?.message || "The vault did not answer.")));
  }, [data, scope]);
  useEffect(load, [load]);

  const shown = useMemo(() => (items ? visible(items, scope, q, nav) : []), [items, scope, q, nav]);
  useEffect(() => { if (items) setCounts(navCounts(visible(items, scope))); }, [items, scope, setCounts]);
  const cur = shown.find((v) => v.id === sel) ?? (phone ? undefined : shown[0]);
  useEffect(() => {
    setEvents([]);
    if (cur) data.events(scope, cur).then(setEvents).catch(() => setEvents([]));
  }, [cur?.id, scope, data]);
  const sum = summaryOf(items ? visible(items, scope) : []);
  const audit = (item: VItem) => (what: "reveal" | "copy") => setLocal((l) => [{ id: `n${l.length}`, item: item.id, who: "you", what: what === "reveal" ? "Revealed the value" : "Copied the value", when: "Just now" }, ...l]);
  const fail = (e: unknown, fallback: string) => showToast(String((e as Error)?.message || fallback));
  const doLock = () => data.lock().then(() => { setLocked(true); }).catch((e) => fail(e, "That did not lock it."));
  const startAdd = () => { setAddProblem(""); setAdding(true); };
  const doAdd = (c: Call, name: string) => {
    setBusy(true); setAddProblem("");
    data.add(scope, c).then(() => { setAdding(false); showToast(`${name} added.`); load(); }).catch((e) => setAddProblem(putRefusal((e as { code?: string }).code, String((e as Error)?.message || "")))).finally(() => setBusy(false));
  };
  const setShare = (fn: (xs: VItem[]) => VItem[]) => setItems((xs) => (xs ? fn(xs) : xs));

  if (scope === "mine" && noAccount) {
    return (
      <Frame title="Vault" sub="Make your own vault.">
        <Scoper scope={scope} onScope={setScope} />
        <Card>
          <View className="gap-s3 py-s4">
            <View className="items-center gap-s2"><IconTile name="vault" /><Text size="title" strong>Make your own vault</Text>
              <Text tone="label" className="text-center">It holds your AI sign-ins and your own connections. Only you can open it, with a password you choose. This device keeps the key that goes with it.</Text></View>
            <Field name="Password" kind="password" value={pw} onChangeText={setPw} placeholder="Choose a password (12 or more characters)" />
            <Button kind="primary" label="Make my vault" disabled={busy} onPress={() => { if (pw.length < 12) { showToast("A password is at least 12 characters."); return; } setBusy(true); data.create(pw).then(() => { setPw(""); load(); }).catch((e) => fail(e, "That did not work.")).finally(() => setBusy(false)); }} />
          </View>
        </Card>
      </Frame>
    );
  }

  if (scope === "mine" && locked) {
    return (
      <Frame title="Vault" sub="Your own vault is locked.">
        <Scoper scope={scope} onScope={setScope} />
        <Card>
          <View className="gap-s3 py-s4">
            <View className="items-center gap-s2"><IconTile name="lock" /><Text size="title" strong>Your vault is locked</Text>
              <Text tone="label" className="text-center">Unlock it with your password. Nothing in it is shown until you do.</Text></View>
            <Field name="Password" kind="password" value={pw} onChangeText={setPw} placeholder="Password" />
            <Button kind="primary" label="Unlock" disabled={busy} onPress={() => { if (!pw) { showToast("Type your password."); return; } setBusy(true); data.unlock(pw).then(() => { setPw(""); load(); }).catch((e) => fail(e, "That did not unlock it.")).finally(() => setBusy(false)); }} />
          </View>
        </Card>
      </Frame>
    );
  }

  const row = (v: VItem) => {
    const h = healthOf(v);
    return (
      <MenuRow key={v.id} items={[
        { label: "Open", onPress: () => setSel(v.id) },
        { label: "Share", onPress: () => setSel(v.id) },
        { label: "Delete", danger: true, onPress: () => setDel(v.id) },
      ]}>
        {(menu) => (
          <Row dense chevron={phone} selected={!phone && cur?.id === v.id} lead={<IconTile name={ICON[(v as VItem & { kindGroup?: string }).kindGroup ?? v.group] ?? "key"} />} title={v.name} sub={v.detail}
            end={<View className="flex-row items-center gap-s1">{h !== "ok" ? <Chip tone={TONE[h]}>{HEALTH_WORDS[h]}</Chip> : null}{menu}</View>} onPress={() => setSel(v.id)} />
        )}
      </MenuRow>
    );
  };

  const list = err ? <ErrorState title="The vault did not answer" reason={err} retry={load} /> : items === null ? <LoadingState /> : (
    <View className="gap-s3">
      {scope === "space" && noSpaceVault ? <Text tone="muted">Your vault opens the first time something is saved to it with Touch ID or a passkey.</Text> : null}
      {nav.kind !== "all" ? <View className="flex-row items-center justify-between gap-s2"><Text tone="label">{nav.kind === "group" ? nav.group : nav.kind === "expiring" ? "Expiring" : "Shared with me"}</Text><Button kind="ghost" size="sm" label="Show everything" onPress={() => setNav({ kind: "all" })} /></View> : null}
      <AccountNames />
      <Field name="Search the vault" value={q} onChangeText={setQ} placeholder="Search by name, group or account" />
      {shown.length ? (
        <GroupedList groups={SECTIONS.filter((s) => shown.some((v) => sectionOf(v.group, v.kind) === s)).map((name) => ({ name }))}
          items={shown.map((v) => ({ ...v, kindGroup: v.group, group: sectionOf(v.group, v.kind) }))} itemNoun="items"
          renderItems={(xs) => <Card flush>{(xs as VItem[]).map(row)}</Card>} />
      ) : <EmptyState title="Nothing here" body={q ? "No item matches that search." : nav.kind !== "all" ? navEmpty(nav) : scope === "mine" ? "Your own vault is empty. Add a sign-in or a key." : "The Space has no items yet."} />}
    </View>
  );

  const detail = cur ? (
    <Card>
      <View className="gap-s4">
        <View className="gap-s1">
          <View className="flex-row flex-wrap items-center gap-s2"><Text size="title" strong>{cur.name}</Text><Chip>{cur.group}</Chip><Chip tone={TONE[healthOf(cur)]}>{HEALTH_WORDS[healthOf(cur)]}</Chip></View>
          <Text tone="label">{cur.detail}</Text>
          {cur.daysLeft != null ? <Text size="caption" tone="label">{cur.daysLeft < 0 ? `Expired ${-cur.daysLeft} days ago` : `Expires in ${cur.daysLeft} days`}</Text> : null}
        </View>
        {cur.kind === "provisioned" ? (
          <Sec title="The account">
            <Card flush>
              <Row dense title="Acts as" sub={cur.detail.replace(/^Acts as /, "")} />
              <Row dense title="How it got here" sub="Provided by the firm key. Only your own mailbox, calendar and Drive." />
              <Row dense title="Token" sub="None is stored. The firm key is used for you each time, and no one is given it." />
            </Card>
          </Sec>
        ) : cur.kind === "connection" ? (
          <Sec title="The connection">
            <Card flush>
              <Row dense title="Connects to" sub={cur.detail} />
              <Row dense title="Token" sub="Kept in the Vault. Nobody sees it, and no agent or tool is given it." />
            </Card>
            <View className="flex-row gap-s2 pt-s2"><Button kind="secondary" size="sm" label="Connect again" onPress={() => router.push("/u/connections" as never)} /></View>
          </Sec>
        ) : (
        <View className="gap-s2 rounded-card border border-edge bg-surface-3 p-s3">
          <Text size="caption" strong tone="label">The value</Text>
          <SecretField key={cur.id} label={cur.name} read={() => data.read(scope, cur)} onAudit={audit(cur)} />
        </View>
        )}
        {cur.kind !== "provisioned" && cur.kind !== "connection" ? (
          <View className="gap-s4">
            <TaggedIn item={cur.name} />
            <LinkedTo item={cur.name} />
            {scope === "mine" ? <MoveToVault item={cur.name} onMoved={load} /> : null}
            <EarlierVersions name={cur.name} onChanged={load} canPutBack={scope === "mine"} />
          </View>
        ) : null}
        {scope === "mine" && cur.sites && data.addSite ? (
          <Sec title="Sites">
            {cur.sites.length ? <Card flush>{cur.sites.map((u) => <Row key={u} dense title={u} />)}</Card> : <Text tone="muted">No site saved. An agent cannot be lent this login until it has one.</Text>}
            {siteFor === cur.id || cur.sites.length ? null : <Button kind="secondary" label="Add the site" onPress={() => setSiteFor(cur.id)} />}
            {siteFor === cur.id ? (
              <View className="gap-s2">
                <Field name="Site" value={siteText} onChangeText={setSiteText} placeholder="https://example.com" />
                {siteProblem ? <Text tone="muted">{siteProblem}</Text> : null}
                <View className="flex-row gap-s2">
                  <Button kind="primary" label="Save site" disabled={busy} onPress={() => { setBusy(true); setSiteProblem(""); data.addSite!(cur, siteText).then(() => { setSiteFor(null); setSiteText(""); showToast("Site saved."); load(); }).catch((e) => setSiteProblem(String((e as Error)?.message || "That did not save."))).finally(() => setBusy(false)); }} />
                  <Button kind="secondary" label="Cancel" onPress={() => { setSiteFor(null); setSiteProblem(""); }} />
                </View>
              </View>
            ) : cur.sites.length ? <Button kind="secondary" label="Add another site" onPress={() => setSiteFor(cur.id)} /> : null}
          </Sec>
        ) : null}
        {cur.kind === "provisioned" ? null : <Sec title="Used by">
          {cur.usedBy.length ? <Card flush>{cur.usedBy.map((u) => <Row key={u.kind + u.name} dense title={u.name} sub={u.kind} />)}</Card> : <Text tone="muted">Nothing uses it yet.</Text>}
        </Sec>}
        {cur.kind === "provisioned" ? null : <Sec title={cur.kind === "connection" ? "Who can use it" : "Who has it"}>
          {scope === "space" && data.sharing ? <ItemSharing api={data.sharing} item={cur} /> : scope === "mine" && cur.kind === "connection" && data.connectionSharing ? <ItemSharing api={data.connectionSharing} item={cur} connection /> : (
            <View className="gap-s2"><Text tone="muted">Only you. Your own vault is not shared.</Text></View>
          )}
        </Sec>}
        <Sec title="Activity">
          <Card flush>{[...local.filter((e) => e.item === cur.id), ...events].slice(0, 6).map((e) => <Row key={e.id} dense lead={<Avatar of={who(e.who)} size={24} />} title={e.what} sub={`${e.who}, ${e.when}`} />)}
            {local.some((e) => e.item === cur.id) || events.length ? null : <View className="p-s3"><Text tone="muted">No activity yet.</Text></View>}</Card>
        </Sec>
        {cur.kind === "provisioned" ? null : <View className="flex-row gap-s2"><Button kind="ghost" size="sm" label="Delete" onPress={() => setDel(cur.id)} />{scope === "space" && data.moving ? <MoveItem api={data.moving} item={cur} onMoved={load} /> : null}</View>}
      </View>
    </Card>
  ) : null;

  const gone = items?.find((v) => v.id === del);
  const sheet = (
    <Sheet open={!!gone} onClose={() => setDel(null)} title={gone ? `Delete ${gone.name}?` : undefined}>
      {gone ? (
        <View className="gap-s3">
          <Text>{breakage(gone)}</Text>
          <View className="flex-row gap-s2"><Button kind="danger" label="Delete" onPress={() => { data.remove(scope, gone).then(() => { setSel(null); setDel(null); showToast(`${gone.name} deleted.`); load(); }).catch((e) => fail(e, "That did not delete.")); }} /><Button kind="ghost" label="Keep it" onPress={() => setDel(null)} /></View>
        </View>
      ) : null}
    </Sheet>
  );

  const addSheet = (
    <AddSheet want={wanted} open={adding} scope={scope} busy={busy} problem={addProblem} onClose={() => setAdding(false)} onSave={doAdd}
      onImport={() => setImporting(true)} onSignIn={() => { setAdding(false); router.push("/u/connections" as never); }} />
  );

  if (importing) {
    return (
      <Frame title="Bring in passwords and keys" sub="From another password manager or your project files." onBack={() => { setImporting(false); load(); }}>
        {claimBlocked() ? <Text tone="muted">{ON_PHONE.replace("Do this", "Import")}</Text> : <ImportPage reload={load} />}
      </Frame>
    );
  }

  if (phone && cur && sel) return <Frame title={cur.name} sub={cur.detail} onBack={() => setSel(null)}>{detail}{sheet}{addSheet}</Frame>;

  return (
    <Frame title="Vault" sub="Logins, keys and connections." actions={<View className="flex-row items-center gap-s2">{scope === "mine" ? (phone ? <IconButton icon="lock" label="Lock" onPress={doLock} /> : <Button kind="ghost" size="sm" icon="lock" label="Lock" onPress={doLock} />) : null}{scope === "space" ? <Button kind="ghost" size="sm" label="Vaults" onPress={() => router.push("/u/vaults" as never)} /> : null}{data.real ? <Button kind="ghost" size="sm" label="More" onPress={() => router.push("/u/vault-more" as never)} /> : null}{phone ? <IconButton icon="plus" label="Add" kind="primary" onPress={startAdd} /> : <Button kind="primary" size="sm" icon="plus" label="Add" onPress={startAdd} />}</View>}>
      <Scoper scope={scope} onScope={setScope} />
      <Footnote icon="shield">Values stay hidden until you reveal one. Agents use an item without ever seeing it, and every use is logged.</Footnote>
      {items && sum.expired + sum.expiring + sum.unused > 0 ? <Banner tone={sum.expired ? "err" : "warn"} icon="shield">{sum.line}</Banner> : <Text tone="label">{sum.line}</Text>}
      <View className={phone ? "gap-s4" : "flex-row items-start gap-s4"}>
        <View className={phone ? "" : "min-w-0 flex-1"}>{list}</View>
        {phone ? null : <View className="min-w-pane min-w-0 flex-[1.2]">{detail}</View>}
      </View>
      {sheet}{addSheet}
    </Frame>
  );
}

/** Mine or Space. On a wide web screen the sidebar's Vault panel has it, so the page does not repeat it. */
function Scoper({ scope, onScope }: { scope: Scope; onScope: (s: Scope) => void }) {
  const { width } = useWindowDimensions();
  if (Platform.OS === "web" && width >= VAULT_PANEL_MIN) return null;
  return <Segmented<Scope> label="Which vault" options={[["mine", "Mine"], ["space", "Space"]]} value={scope} onChange={onScope} />;
}
