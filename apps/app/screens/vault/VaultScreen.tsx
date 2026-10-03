import { useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Divider, EmptyState, Menu, Row, Tabs, Text, showToast, type IconName } from "@vyre/ui";
import { Block, FaceIdSheet, IconTile, Note, Page, Section, SpaceChip, usePhone } from "../places/Page";
import { useScope } from "../places/scope";
import { PEOPLE, vaultRepo, type Held, type Item, type Right } from "./data";
import { addGrant, heldIn, listOf, removeGrant, REVEAL_MS, RIGHTS, useLine } from "./logic.js";

type Tab = "Login" | "Key" | "Card" | "Held";
const ICON: Record<Item["kind"], IconName> = { Login: "key", Key: "key", Card: "file" };
// The mask is fixed: it says nothing about the value, not even its length. The field renderers (ui/fields) replace this when they land.
const Masked = () => <Text mono>{"••••••••••••"}</Text>;

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
  const reveal = useReveal();
  const held: Held[] = heldIn(vaultRepo.held(), scope);
  const list = tab === "Held" ? [] : (listOf(items, scope, tab) as Item[]);
  const cur = list.find((v) => v.id === sel) ?? list[0];
  const askTitle = reveal.ask?.startsWith("h") ? held.find((h) => h.id === reveal.ask) : items.find((v) => v.id === reveal.ask);

  const detail = cur ? (
    <Card>
      <View className="gap-s3">
        <View className="flex-row flex-wrap items-center gap-s2"><Text size="title" strong>{cur.name}</Text><SpaceChip sp={cur.sp} /><Chip>{cur.kind}</Chip></View>
        <Text tone="label">{cur.user}</Text>
        <Block label="The value">
          <View className="flex-row flex-wrap items-center gap-s2">
            {reveal.shown === cur.id ? <Text mono>{cur.secret}</Text> : <Masked />}
            {reveal.shown === cur.id
              ? <><Chip tone="ok">Shown for 30 s</Chip><Button kind="ghost" size="sm" label="Hide" onPress={reveal.hide} /></>
              : <Button size="sm" icon="faceid" label="Reveal" onPress={() => reveal.request(cur.id)} />}
          </View>
        </Block>
        <Section title="Used by assistants, without seeing it">
          {cur.use.length ? cur.use.map((u) => (
            <Row key={u.who + u.for} lead={<Avatar name={u.who} family="assistant" size="sm" />} title={`Used for ${u.for}, ${u.times} ${u.times === 1 ? "time" : "times"} today`} sub={`${u.who} · ${u.note}`} />
          )) : <Text tone="muted">Not used yet.</Text>}
        </Section>
        <Section title="Who has it">
          {cur.grants.length ? cur.grants.map((g) => (
            <Row key={g.who} lead={<Avatar name={g.who} family={g.who === "chris" ? "person" : "assistant"} />} title={g.who} sub={<Text size="caption" tone="label">{`${RIGHTS[g.right].label}. ${RIGHTS[g.right].help}`}</Text>}
              end={<Button kind="danger" size="sm" label="Remove" onPress={() => { setItems((xs) => removeGrant(xs, cur.id, g.who)); showToast(`${g.who} no longer has ${cur.name}.`); }} />} />
          )) : <Text tone="muted">Only you.</Text>}
          <View className="self-start">
            <Menu trigger={<Button size="sm" icon="plus" label="Share with a person or assistant" />}
              items={PEOPLE.filter((p) => !cur.grants.some((g) => g.who === p)).flatMap((p) => (["use", "fill", "copy"] as Right[]).map((r) => ({ label: `${p}: ${RIGHTS[r].label}`, onPress: () => { setItems((xs) => addGrant(xs, cur.id, p, r)); showToast(`${p} can now ${RIGHTS[r].label.toLowerCase()} ${cur.name}.`); } })))} />
          </View>
        </Section>
      </View>
    </Card>
  ) : null;

  return (
    <Page title="Vault" sub="Logins, keys and cards, per space.">
      <Note title="An assistant never sees a credential." body="Each use is written down. Sharing is a grant you can remove." />
      <Tabs<Tab> value={tab} onChange={setTab} items={[["Login", "Logins"], ["Key", "Keys"], ["Card", "Cards"], ["Held", "Held fields"]]} />
      {tab === "Held" ? (
        <Card flush>
          {held.length ? held.map((h, i) => (
            <View key={h.id}>
              {i ? <Divider /> : null}
              <Row lead={<IconTile icon="shield" tone="warn" />} title={`${h.title}, ${h.field}`} sub={`Held by the Vault. Assistants see "${h.field} on file, sealed".`}
                end={<><SpaceChip sp={h.sp} />{reveal.shown === h.id ? <Text mono>{h.value}</Text> : null}{reveal.shown === h.id ? <Button kind="ghost" size="sm" label="Hide" onPress={reveal.hide} /> : <Button size="sm" icon="faceid" label="Reveal" onPress={() => reveal.request(h.id)} />}</>} />
            </View>
          )) : <EmptyState title="No sealed fields" body="Seal a field on a record and it moves into the Vault." />}
        </Card>
      ) : (
        <View className={phone ? "gap-s4" : "flex-row items-start gap-s4"}>
          <View className={phone ? "" : "min-w-0 flex-1"}>
            <Card flush>
              {list.length ? list.map((v, i) => (
                <View key={v.id}>
                  {i ? <Divider /> : null}
                  <Row selected={cur?.id === v.id} lead={<IconTile icon={ICON[v.kind]} />} title={v.name} sub={useLine(v)} end={<SpaceChip sp={v.sp} />} onPress={() => setSel(v.id)} />
                </View>
              )) : <EmptyState title="Nothing here" body={`No ${tab.toLowerCase()}s in this space.`} />}
            </Card>
          </View>
          <View className={phone ? "" : "min-w-0 flex-[1.2]"}>{detail}</View>
        </View>
      )}
      <FaceIdSheet open={!!reveal.ask} onClose={reveal.cancel} title="Reveal with Face ID"
        body={`${askTitle ? ("name" in askTitle ? askTitle.name : `${askTitle.title}, ${askTitle.field}`) : "The value"} shows for 30 seconds, then masks again. Assistants never see it.`}
        confirm="Approve with Face ID" onConfirm={reveal.approve} />
    </Page>
  );
}
