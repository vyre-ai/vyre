import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { AccessList, Avatar, Banner, Button, Card, Chip, EmptyState, ErrorState, Field, GroupedList, LoadingState, IconTile, MenuRow, Row, Segmented, Sheet, Text, SecretField, markRef, showToast, type IconName, type Level } from "@vyre/ui";
import { Footnote, Frame, Sec } from "../places/Frame";
import { usePhone } from "../places/Page";
import { HEALTH_WORDS, breakage, groupsOf, healthOf, share, summaryOf, unshare, visible, type VItem } from "./redesign.js";
import { SAMPLE_PEOPLE, type Event } from "./sample-redesign";
import type { NewItem, Scope, VaultData } from "./redesign-data";

const ICON: Record<string, IconName> = { "Firm keys": "key", "Sending services": "mail", "API keys": "key", Phone: "phone", Logins: "key", "MCP keys": "link", "SSH and notes": "file" };
const who = (w: string) => markRef(w === "chris" || w === "alex" ? "person" : w === "iris" ? "assistant" : "teammate", w);
const TONE = { ok: "ok", expiring: "warn", expired: "err", unused: "plain" } as const;

/** The redesigned Vault: Space or Mine, items in groups, one item's detail with the SecretField, where it is used, who has it, health and what happened to it, and the locked card. `data` is the sample world or the real tools. */
export default function VaultRedesign({ data }: { data: VaultData }) {
  const phone = usePhone();
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("mine");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<VItem[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [noAccount, setNoAccount] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [local, setLocal] = useState<Event[]>([]);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<NewItem | null>(null);
  const [acc, setAcc] = useState<{ rows: { who: string; level: Level }[]; people: { id: string; name: string }[] }>({ rows: [], people: [] });

  const load = useCallback(() => {
    setErr(""); setItems(null);
    data.load(scope).then((r) => { setItems(r.items); setLocked(r.locked); setNoAccount(Boolean(r.noAccount)); }).catch((e) => setErr(String(e?.message || "The vault did not answer.")));
  }, [data, scope]);
  useEffect(load, [load]);

  const shown = useMemo(() => (items ? visible(items, scope, q) : []), [items, scope, q]);
  const cur = shown.find((v) => v.id === sel) ?? (phone ? undefined : shown[0]);
  useEffect(() => {
    setEvents([]);
    if (cur) data.events(scope, cur).then(setEvents).catch(() => setEvents([]));
    setAcc({ rows: [], people: [] });
    if (cur && data.access && scope === "space") data.access(cur).then(setAcc).catch(() => {});
  }, [cur?.id, scope, data]);
  const sum = summaryOf(items ? visible(items, scope) : []);
  const audit = (item: VItem) => (what: "reveal" | "copy") => setLocal((l) => [{ id: `n${l.length}`, item: item.id, who: "you", what: what === "reveal" ? "Revealed the value" : "Copied the value", when: "Just now" }, ...l]);
  const fail = (e: unknown, fallback: string) => showToast(String((e as Error)?.message || fallback));
  const setShare = (fn: (xs: VItem[]) => VItem[]) => setItems((xs) => (xs ? fn(xs) : xs));

  if (scope === "mine" && noAccount) {
    return (
      <Frame title="Vault" sub="Make your own vault.">
        <Scoper scope={scope} onScope={setScope} />
        <Card>
          <View className="gap-s3 py-s4">
            <View className="items-center gap-s2"><IconTile name="vault" /><Text size="title" strong>Make your own vault</Text>
              <Text tone="label" className="text-center">It holds your AI sign-ins and your own connections. Only you can open it, with a master password you choose. This device keeps the key that goes with it.</Text></View>
            <Field name="Master password" kind="password" value={pw} onChangeText={setPw} placeholder="Choose a master password (12 or more characters)" />
            <Button kind="primary" label="Make my vault" disabled={busy || pw.length < 12} onPress={() => { setBusy(true); data.create(pw).then(() => { setPw(""); load(); }).catch((e) => fail(e, "That did not work.")).finally(() => setBusy(false)); }} />
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
              <Text tone="label" className="text-center">Unlock it with your master password. Nothing in it is shown until you do.</Text></View>
            <Field name="Master password" kind="password" value={pw} onChangeText={setPw} placeholder="Master password" />
            <Button kind="primary" label="Unlock" disabled={busy || !pw} onPress={() => { setBusy(true); data.unlock(pw).then(() => { setPw(""); load(); }).catch((e) => fail(e, "That did not unlock it.")).finally(() => setBusy(false)); }} />
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
          <Row dense chevron={phone} selected={!phone && cur?.id === v.id} lead={<IconTile name={ICON[v.group] ?? "key"} />} title={v.name} sub={v.detail}
            end={<View className="flex-row items-center gap-s1">{h !== "ok" ? <Chip tone={TONE[h]}>{HEALTH_WORDS[h]}</Chip> : null}{menu}</View>} onPress={() => setSel(v.id)} />
        )}
      </MenuRow>
    );
  };

  const list = err ? <ErrorState title="The vault did not answer" reason={err} retry={load} /> : items === null ? <LoadingState /> : (
    <View className="gap-s3">
      <Field name="Search the vault" value={q} onChangeText={setQ} placeholder="Search by name, group or account" />
      {shown.length ? (
        <GroupedList groups={groupsOf(shown)} items={shown.map((v) => ({ ...v }))} itemNoun="items"
          renderItems={(xs) => <Card flush>{(xs as VItem[]).map(row)}</Card>} />
      ) : <EmptyState title="Nothing here" body={q ? "No item matches that search." : scope === "mine" ? "Your own vault is empty. Add a sign-in or a key." : "The Space has no items yet."} />}
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
        <View className="gap-s2 rounded-card border border-edge bg-surface-3 p-s3">
          <Text size="caption" strong tone="label">The value</Text>
          <SecretField key={cur.id} label={cur.name} read={() => data.read(scope, cur)} onAudit={audit(cur)} />
        </View>
        <Sec title="Used by">
          {cur.usedBy.length ? <Card flush>{cur.usedBy.map((u) => <Row key={u.kind + u.name} dense title={u.name} sub={u.kind} />)}</Card> : <Text tone="muted">Nothing uses it yet.</Text>}
        </Sec>
        <Sec title="Who has it">
          {data.real ? (
            <View className="gap-s2">
              {cur.usedBy.length ? <Card flush>{cur.usedBy.map((u) => <Row key={u.name} dense title={u.name} sub="Can use, without seeing it" end={data.revokeModule ? <Button kind="holdText" size="sm" label="Remove" onPress={() => data.revokeModule!(cur, u.name).then(() => { showToast(`${u.name} no longer has ${cur.name}.`); load(); }).catch((e) => fail(e, "That did not work."))} /> : undefined} />)}</Card> : <Text tone="muted">Only you.</Text>}
              {data.access ? <AccessList rows={acc.rows} candidates={acc.people.map((p) => p.id)} of={who}
                onChange={(w, l: Level) => data.setAccess!(cur, w, l).then(() => data.access!(cur).then(setAcc)).catch((e) => fail(e, "That did not work."))}
                onRemove={(w) => data.setAccess!(cur, w, null).then(() => { showToast(`${w} no longer has ${cur.name}.`); return data.access!(cur).then(setAcc); }).catch((e) => fail(e, "That did not work."))}
                onAdd={(w, l: Level) => data.setAccess!(cur, w, l).then(() => data.access!(cur).then(setAcc)).catch((e) => fail(e, "That did not work."))} empty="Not shared with a person." /> : null}
            </View>
          ) : (
            <AccessList rows={cur.shared} candidates={SAMPLE_PEOPLE} of={who}
              onChange={(w, l: Level) => setShare((xs) => share(xs, cur.id, w, l))} onRemove={(w) => { setShare((xs) => unshare(xs, cur.id, w)); showToast(`${w} no longer has ${cur.name}.`); }}
              onAdd={(w, l: Level) => { setShare((xs) => share(xs, cur.id, w, l)); showToast(`${w} can now use ${cur.name}.`); }} />
          )}
        </Sec>
        <Sec title="Activity">
          <Card flush>{[...local.filter((e) => e.item === cur.id), ...events].slice(0, 6).map((e) => <Row key={e.id} dense lead={<Avatar of={who(e.who)} size={24} />} title={e.what} sub={`${e.who}, ${e.when}`} />)}
            {local.some((e) => e.item === cur.id) || events.length ? null : <View className="p-s3"><Text tone="muted">No activity yet.</Text></View>}</Card>
        </Sec>
        <View className="flex-row gap-s2"><Button kind="ghost" size="sm" label="Delete" onPress={() => setDel(cur.id)} /></View>
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
    <Sheet open={!!adding} onClose={() => setAdding(null)} title={scope === "mine" ? "Add to your vault" : "Add to the Space vault"}>
      {adding ? (
        <View className="gap-s3">
          <Field label="Name" value={adding.name} onChangeText={(name) => setAdding({ ...adding, name })} placeholder="For example Stripe" />
          <Segmented label="Kind" options={[["api-key", "Key"], ["login", "Login"], ["note", "Note"]]} value={["api-key", "login", "note"].includes(adding.kind) ? adding.kind : "api-key"} onChange={(kind) => setAdding({ ...adding, kind })} />
          <Field label="Value" kind="password" value={adding.value} onChangeText={(value) => setAdding({ ...adding, value })} />
          <View className="flex-row gap-s2"><Button kind="primary" label="Add" disabled={busy || !/^[A-Za-z0-9._-]{1,128}$/.test(adding.name) || !adding.value}
            onPress={() => { setBusy(true); data.add(scope, adding).then(() => { setAdding(null); showToast(`${adding.name} added.`); load(); }).catch((e) => fail(e, "That did not save.")).finally(() => setBusy(false)); }} /><Button kind="ghost" label="Cancel" onPress={() => setAdding(null)} /></View>
          <Text size="caption" tone="label">A name is letters, digits, dot, dash and underscore.</Text>
        </View>
      ) : null}
    </Sheet>
  );

  if (phone && cur && sel) return <Frame title={cur.name} sub={cur.detail} onBack={() => setSel(null)}>{detail}{sheet}{addSheet}</Frame>;

  return (
    <Frame title="Vault" sub="Logins, keys and connections." actions={<>{scope === "mine" ? <Button kind="ghost" size="sm" icon="lock" label="Lock" onPress={() => data.lock().then(() => { setLocked(true); }).catch((e) => fail(e, "That did not lock it."))} /> : null}{data.real ? <Button kind="ghost" size="sm" label="More" onPress={() => router.push("/u/vault-more" as never)} /> : null}<Button kind="primary" size="sm" icon="plus" label="Add" onPress={() => setAdding({ name: "", kind: scope === "mine" ? "secret" : "api-key", value: "" })} /></>}>
      <Scoper scope={scope} onScope={setScope} />
      <Footnote icon="shield">Values stay hidden until you reveal one. Assistants use an item without ever seeing it, and every use is logged.</Footnote>
      {items && sum.expired + sum.expiring + sum.unused > 0 ? <Banner tone={sum.expired ? "err" : "warn"} icon="shield">{sum.line}</Banner> : <Text tone="label">{sum.line}</Text>}
      <View className={phone ? "gap-s4" : "flex-row items-start gap-s4"}>
        <View className={phone ? "" : "min-w-0 flex-1"}>{list}</View>
        {phone ? null : <View className="min-w-pane min-w-0 flex-[1.2]">{detail}</View>}
      </View>
      {sheet}{addSheet}
    </Frame>
  );
}

function Scoper({ scope, onScope }: { scope: Scope; onScope: (s: Scope) => void }) {
  return <Segmented<Scope> label="Which vault" options={[["mine", "Mine"], ["space", "Space"]]} value={scope} onChange={onScope} />;
}
