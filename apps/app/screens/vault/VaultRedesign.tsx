import { useMemo, useState } from "react";
import { View } from "react-native";
import { AccessList, Avatar, Banner, Button, Card, Chip, EmptyState, Field, GroupedList, IconTile, MenuRow, Row, Segmented, Sheet, Text, SecretField, markRef, showToast, type IconName, type Level } from "@vyre/ui";
import { Footnote, Frame, Sec } from "../places/Frame";
import { usePhone } from "../places/Page";
import { HEALTH_WORDS, breakage, groupsOf, healthOf, share, summaryOf, unshare, visible, type VItem } from "./redesign.js";
import { SAMPLE_EVENTS, SAMPLE_ITEMS, SAMPLE_PEOPLE } from "./sample-redesign";

type Scope = "space" | "mine";
const ICON: Record<string, IconName> = { "Firm keys": "key", "Sending services": "mail", "API keys": "key", Phone: "phone", Logins: "key", "MCP keys": "link", "SSH and notes": "file" };
const who = (w: string) => markRef(w === "chris" || w === "alex" ? "person" : w === "iris" ? "assistant" : "teammate", w);
const TONE = { ok: "ok", expiring: "warn", expired: "err", unused: "plain" } as const;

/** The redesigned Vault in the sample world: Space or Mine, items in groups, one item's detail with the SecretField, where it is used, who has it, health and what happened to it, and the locked card. */
export default function VaultRedesign() {
  const phone = usePhone();
  const [scope, setScope] = useState<Scope>("mine");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<VItem[]>(SAMPLE_ITEMS);
  const [sel, setSel] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const [log, setLog] = useState(SAMPLE_EVENTS);
  const shown = useMemo(() => visible(items, scope, q), [items, scope, q]);
  const cur = shown.find((v) => v.id === sel) ?? (phone ? undefined : shown[0]);
  const sum = summaryOf(visible(items, scope));
  const audit = (item: VItem) => (what: "reveal" | "copy") => setLog((l) => [{ id: `n${l.length}`, item: item.id, who: "alex", what: what === "reveal" ? "Revealed the value" : "Copied the value", when: "Just now" }, ...l]);

  if (scope === "mine" && locked) {
    return (
      <Frame title="Vault" sub="Your own vault is locked.">
        <Scoper scope={scope} onScope={setScope} />
        <Card>
          <View className="items-center gap-s3 py-s6">
            <IconTile name="lock" />
            <Text size="title" strong>Your vault is locked</Text>
            <Text tone="label" className="text-center">Unlock it with your master password. Nothing in it is shown until you do.</Text>
            <Button kind="primary" label="Unlock" onPress={() => setLocked(false)} />
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

  const list = (
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
          <SecretField key={cur.id} label={cur.name} read={() => cur.secret} onAudit={audit(cur)} />
        </View>
        <Sec title="Used by">
          {cur.usedBy.length ? <Card flush>{cur.usedBy.map((u) => <Row key={u.kind + u.name} dense title={u.name} sub={u.kind} />)}</Card> : <Text tone="muted">Nothing uses it yet.</Text>}
        </Sec>
        <Sec title="Who has it">
          <AccessList rows={cur.shared} candidates={SAMPLE_PEOPLE} of={who}
            onChange={(w, l: Level) => setItems((xs) => share(xs, cur.id, w, l))} onRemove={(w) => { setItems((xs) => unshare(xs, cur.id, w)); showToast(`${w} no longer has ${cur.name}.`); }}
            onAdd={(w, l: Level) => { setItems((xs) => share(xs, cur.id, w, l)); showToast(`${w} can now use ${cur.name}.`); }} />
        </Sec>
        <Sec title="Activity">
          <Card flush>{log.filter((e) => e.item === cur.id).slice(0, 5).map((e) => <Row key={e.id} dense lead={<Avatar of={who(e.who)} size={24} />} title={e.what} sub={`${e.who}, ${e.when}`} />)}
            {log.some((e) => e.item === cur.id) ? null : <View className="p-s3"><Text tone="muted">No activity yet.</Text></View>}</Card>
        </Sec>
        <View className="flex-row gap-s2"><Button kind="ghost" size="sm" label="Delete" onPress={() => setDel(cur.id)} /></View>
      </View>
    </Card>
  ) : null;

  const gone = items.find((v) => v.id === del);
  const sheet = (
    <Sheet open={!!gone} onClose={() => setDel(null)} title={gone ? `Delete ${gone.name}?` : undefined}>
      {gone ? (
        <View className="gap-s3">
          <Text>{breakage(gone)}</Text>
          <View className="flex-row gap-s2"><Button kind="danger" label="Delete" onPress={() => { setItems((xs) => xs.filter((v) => v.id !== gone.id)); setSel(null); setDel(null); showToast(`${gone.name} deleted.`); }} /><Button kind="ghost" label="Keep it" onPress={() => setDel(null)} /></View>
        </View>
      ) : null}
    </Sheet>
  );

  if (phone && cur && sel) return <Frame title={cur.name} sub={cur.detail} onBack={() => setSel(null)}>{detail}{sheet}</Frame>;

  return (
    <Frame title="Vault" sub="Logins, keys and connections." actions={<><Button kind="ghost" size="sm" icon="lock" label="Lock" onPress={() => { setScope("mine"); setLocked(true); }} /><Button kind="primary" size="sm" icon="plus" label="Add" onPress={() => showToast("Add opens one sheet: pick the kind, then fill it.")} /></>}>
      <Scoper scope={scope} onScope={setScope} />
      <Footnote icon="shield">Values stay hidden until you reveal one. Assistants use an item without ever seeing it, and every use is logged.</Footnote>
      {sum.expired + sum.expiring + sum.unused > 0 ? <Banner tone={sum.expired ? "err" : "warn"} icon="shield">{sum.line}</Banner> : <Text tone="label">{sum.line}</Text>}
      <View className={phone ? "gap-s4" : "flex-row items-start gap-s4"}>
        <View className={phone ? "" : "min-w-0 flex-1"}>{list}</View>
        {phone ? null : <View className="min-w-pane min-w-0 flex-[1.2]">{detail}</View>}
      </View>
      {sheet}
    </Frame>
  );
}

function Scoper({ scope, onScope }: { scope: Scope; onScope: (s: Scope) => void }) {
  return <Segmented<Scope> label="Which vault" options={[["mine", "Mine"], ["space", "Space"]]} value={scope} onChange={onScope} />;
}
