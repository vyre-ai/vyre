import { useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Divider, EmptyState, IconTile, Menu, Row, SealedMask, Tabs, Text, showToast, type IconName, markRef } from "@vyre/ui";
import { FaceIdSheet, usePhone } from "../places/Page";
import { Footnote, Frame, Sec } from "../places/Frame";
import { SpaceBadge } from "../places/badge";
import { SPACES } from "../places/scope";
import { useScope } from "../places/scope";
import { PEOPLE, vaultRepo, type Held, type Item, type Right } from "./data";
import { addGrant, heldIn, listOf, removeGrant, REVEAL_MS, RIGHTS, useLine } from "./logic.js";

type Tab = "Login" | "Key" | "Card" | "Held";
const ICON: Record<Item["kind"], IconName> = { Login: "key", Key: "key", Card: "file" };
const who = (w: string) => markRef(w === "chris" ? "person" : w === "iris" ? "assistant" : w === "kit" ? "teammate" : "assistant", w);

/** A value that is masked until a person passes Face ID, then shown for 30 seconds. */
function useReveal() {
  const [shown, setShown] = useState<string | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), REVEAL_MS);
    return () => clearTimeout(t);
  }, [shown]);
  return { shown, ask, request: setAsk, cancel: () => setAsk(null), approve: () => { setShown(ask); setAsk(null); }, hide: () => setShown(null) };
}

export default function VaultScreen() {
  const scope = useScope((s) => s.scope);
  const phone = usePhone();
  const [tab, setTab] = useState<Tab>("Login");
  const [items, setItems] = useState<Item[]>(() => vaultRepo.items());
  const [sel, setSel] = useState("v1");
  const [pushed, setPushed] = useState(false);
  const reveal = useReveal();
  const held: Held[] = heldIn(vaultRepo.held(), scope);
  const list = tab === "Held" ? [] : (listOf(items, scope, tab) as Item[]);
  const cur = list.find((v) => v.id === sel) ?? list[0];
  const askTitle = reveal.ask?.startsWith("h") ? held.find((h) => h.id === reveal.ask) : items.find((v) => v.id === reveal.ask);

  const detail = cur ? (
    <Card>
      <View className="gap-s3">
        <View className="gap-s1">
          <View className="flex-row flex-wrap items-center gap-s2"><Text size="title" strong>{cur.name}</Text><Chip>{cur.kind}</Chip></View>
          <Text tone="label" numberOfLines={1}>{cur.user}</Text>
        </View>
        <View className="gap-s2 rounded-card border border-edge bg-surface-3 p-s3">
          <Text size="caption" strong tone="label">The value</Text>
          <View className="min-h-control flex-row items-center justify-between gap-s2">
            {reveal.shown === cur.id ? <Text mono size="headline" className="min-w-0 flex-1" selectable>{cur.secret}</Text> : <SealedMask label={cur.name} />}
            {reveal.shown === cur.id
              ? <Button kind="ghost" size="sm" label="Hide" onPress={reveal.hide} />
              : <Button kind="ghost" size="sm" icon="face" label="Reveal" onPress={() => reveal.request(cur.id)} />}
          </View>
          {reveal.shown === cur.id ? <Text size="caption" tone="label">Shown for 30 seconds, then masked again.</Text> : null}
        </View>
        <Sec title="Used by assistants, without seeing it">
          {cur.use.length ? (
            <Card flush>
              {cur.use.map((u, i) => (
                <View key={u.who + u.for}>{i ? <Divider inset={60} /> : null}
                  <Row dense lead={<Avatar of={who(u.who)} size={32} />} title={`Used for ${u.for}, ${u.times} ${u.times === 1 ? "time" : "times"} today`} sub={`${u.who}, ${u.note}`} />
                </View>
              ))}
            </Card>
          ) : <Text tone="muted">Not used yet.</Text>}
        </Sec>
        <Sec title="Who has it">
          {cur.grants.length ? (
            <Card flush>
              {cur.grants.map((g, i) => (
                <View key={g.who}>{i ? <Divider inset={68} /> : null}
                  <Row dense lead={<Avatar of={who(g.who)} size={40} />} title={g.who} sub={`${RIGHTS[g.right].label}. ${RIGHTS[g.right].help}`}
                    end={<Button kind="holdText" size="sm" label="Remove" onPress={() => { setItems((xs) => removeGrant(xs, cur.id, g.who)); showToast(`${g.who} no longer has ${cur.name}.`); }} />} />
                </View>
              ))}
            </Card>
          ) : <Text tone="muted">Only you.</Text>}
          <View className="self-start pt-s2">
            <Menu trigger={<Button kind="ghost" size="sm" icon="plus" label="Share with a person or assistant" />}
              items={PEOPLE.filter((p) => !cur.grants.some((g) => g.who === p)).flatMap((p) => (["use", "fill", "copy"] as Right[]).map((r) => ({ label: `${p}: ${RIGHTS[r].label}`, onPress: () => { setItems((xs) => addGrant(xs, cur.id, p, r)); showToast(`${p} can now ${RIGHTS[r].label.toLowerCase()} ${cur.name}.`); } })))} />
          </View>
        </Sec>
      </View>
    </Card>
  ) : null;

  const faceSheet = (
    <FaceIdSheet open={!!reveal.ask} onClose={reveal.cancel} title="Reveal with Face ID"
      body={`${askTitle ? ("name" in askTitle ? askTitle.name : `${askTitle.title}, ${askTitle.field}`) : "The value"} shows for 30 seconds, then masks again. Assistants never see it.`}
      confirm="Approve with Face ID" onConfirm={reveal.approve} />
  );

  // On a phone the detail is a page of its own, pushed over the list (Back returns to it).
  if (phone && pushed && cur) {
    return (
      <Frame title={cur.name} sub={cur.user} onBack={() => setPushed(false)} marks={[markRef("space", SPACES[cur.sp].name)]}>
        {detail}
        {faceSheet}
      </Frame>
    );
  }

  return (
    <Frame title="Vault" sub="Logins, keys and cards, per space." scope>
      <Footnote icon="shield">Assistants never see a credential. Every use is logged.</Footnote>
      <Tabs<Tab> value={tab} onChange={setTab} items={[["Login", "Logins"], ["Key", "Keys"], ["Card", "Cards"], ["Held", "Held fields"]]} />
      {tab === "Held" ? (
        <Card flush>
          {held.length ? held.map((h, i) => (
            <View key={h.id}>
              {i ? <Divider inset={60} /> : null}
              <Row dense lead={<IconTile name="sealed" tone="warn" badge={<SpaceBadge sp={h.sp} />} />} title={`${h.title}, ${h.field}`} sub={`Held by the Vault. Assistants see "${h.field} on file, sealed".`}
                end={reveal.shown === h.id
                  ? <><Text mono>{h.value}</Text><Button kind="ghost" size="sm" label="Hide" onPress={reveal.hide} /></>
                  : <Button kind="ghost" size="sm" icon="face" label="Reveal" onPress={() => reveal.request(h.id)} />} />
            </View>
          )) : <EmptyState title="No sealed fields" body="Seal a field on a record and it moves into the Vault." />}
        </Card>
      ) : (
        <View className={phone ? "gap-s4" : "flex-row items-start gap-s4"}>
          <View className={phone ? "" : "min-w-0 flex-1"}>
            <Card flush>
              {list.length ? list.map((v, i) => (
                <View key={v.id}>
                  {i ? <Divider inset={60} /> : null}
                  <Row dense chevron={phone} selected={!phone && cur?.id === v.id} lead={<IconTile name={ICON[v.kind]} badge={<SpaceBadge sp={v.sp} />} />} title={v.name} sub={useLine(v)} onPress={() => { setSel(v.id); setPushed(true); }} />
                </View>
              )) : <EmptyState title="Nothing here" body={`No ${tab.toLowerCase()}s in this space.`} />}
            </Card>
          </View>
          {phone ? null : <View className="min-w-pane min-w-0 flex-[1.2]">{detail}</View>}
        </View>
      )}
      {faceSheet}
    </Frame>
  );
}
