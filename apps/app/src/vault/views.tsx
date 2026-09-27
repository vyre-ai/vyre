import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { askTrust, canAskTrust, useAsked, useSelfName, useTrust } from "../state/devices";
import { fieldLabel, fieldsOf, HIDDEN, howText, kindLabel, siteOf, vaultDetail, vaultFooter, type VaultItem } from "../state/devices-model";
import { copy, reveal } from "../state/vault";
import { MONO } from "../theme/fonts";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { Button } from "../ui/Button";
import { List } from "../ui/List";
import { Row, ROW_HEIGHT } from "../ui/Row";

// The Vault place (the Vault and TrustBrowser boards): the list of names, kinds and sites, and an
// item with its values hidden. Where Reveal and Copy would be, an untrusted browser gets the card
// that says why, so the reason shows at the moment the secret is wanted.

/** The quiet row on top of the list on an untrusted browser. */
export function NamesOnly() {
  const { color } = useTheme();
  return (
    <View testID="vault-names-only" style={[styles.namesOnly, { backgroundColor: color.panel, borderBottomColor: color.rule }]}>
      <Text style={[styles.strong, { color: color.text }]}>Names only on this browser</Text>
      <Text style={[styles.meta, { color: color.text2 }]}>Trust it from your Mac or phone to use secrets here.</Text>
    </View>
  );
}

export function VaultList({ items, onOpen }: { items: VaultItem[]; onOpen: (name: string) => void }) {
  const { color } = useTheme();
  const trust = useTrust();
  return (
    <List
      items={items}
      keyOf={(i) => i.name}
      rowHeight={ROW_HEIGHT}
      header={trust === "untrusted" ? <NamesOnly /> : null}
      render={(i) => <Row avatar={i.name} title={i.name} detail={vaultDetail(i)} meta={i.description || ""} testID="vault-row" onPress={() => onOpen(i.name)} />}
      footer={<Text style={[styles.meta, styles.footer, { color: color.label }]}>{vaultFooter(items.length)}</Text>}
    />
  );
}

/** One item: its fields with values hidden, then Reveal and Copy, or the trust card. */
export function ItemDetail({ item }: { item: VaultItem }) {
  const { color } = useTheme();
  const trust = useTrust();
  const site = siteOf(item);
  const fields = fieldsOf(item);
  const limited = trust === "untrusted";
  return (
    <ScrollView contentContainerStyle={styles.detail}>
      <Text style={[styles.title, { color: color.text }]}>{item.name}</Text>
      <Text style={[styles.meta, { color: color.label }]}>{[kindLabel(item.kind), item.description].filter(Boolean).join(" · ")}</Text>
      <View>
        {fields.map((f) => (
          <FieldRow key={f} name={item.name} field={f} limited={limited} />
        ))}
        {site ? (
          <View style={[styles.field, { borderTopColor: color.rule }]}>
            <Text style={[styles.meta, styles.fieldLabel, { color: color.label }]}>Site</Text>
            <Text selectable style={[styles.body, styles.fieldValue, { color: color.text }]}>{site}</Text>
          </View>
        ) : null}
      </View>
      {limited ? (
        <TrustCard />
      ) : (
        <Text style={[styles.meta, { color: color.label }]}>Reveal and Copy ask for presence once; one proof covers 30 min.</Text>
      )}
    </ScrollView>
  );
}

function FieldRow({ name, field, limited }: { name: string; field: string; limited: boolean }) {
  const { color } = useTheme();
  const [shown, setShown] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  // Trust taken away while a value shows: hide it at once.
  useEffect(() => {
    if (limited) setShown(null);
  }, [limited]);
  const onReveal = async () => {
    if (shown !== null) {
      setShown(null);
      return;
    }
    setBusy(true);
    const r = await reveal(name, field);
    setBusy(false);
    if (!r.ok) {
      setNote(r.denied ? null : r.message);
      return;
    }
    setNote(null);
    setShown(r.value ?? "");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(null), (r.hideAfter ?? 10) * 1000);
  };
  const onCopy = async () => {
    setBusy(true);
    const r = await copy(name, field);
    setBusy(false);
    setNote(r.ok ? r.said ?? null : r.denied ? null : r.message);
  };
  return (
    <View style={[styles.field, { borderTopColor: color.rule }]}>
      <Text style={[styles.meta, styles.fieldLabel, { color: color.label }]}>{fieldLabel(field)}</Text>
      <View style={styles.fieldValue}>
        <Text selectable={shown !== null} numberOfLines={shown !== null ? undefined : 1} style={[styles.body, shown !== null && styles.mono, { color: color.text }]}>
          {shown ?? HIDDEN}
        </Text>
        {note ? <Text style={[styles.meta, { color: color.text2 }]}>{note}</Text> : null}
      </View>
      {limited ? null : (
        <View style={styles.fieldButtons}>
          <Button small kind="secondary" label={shown !== null ? "Hide" : "Reveal"} disabled={busy} onPress={onReveal} testID="vault-reveal" />
          <Button small kind="ghost" label="Copy" disabled={busy} onPress={onCopy} testID="vault-copy" />
        </View>
      )}
    </View>
  );
}

/** Where Reveal and Copy would be on a browser that is not trusted yet (TrustBrowser 1b, 2). */
export function TrustCard() {
  const { color } = useTheme();
  const name = useSelfName();
  const asked = useAsked();
  const [how, setHow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ask = canAskTrust();
  return (
    <View testID="vault-trust-card" style={[styles.card, { backgroundColor: color.panel, borderColor: color.rule }]}>
      <Text style={[styles.strong, { color: color.text }]}>Trust this browser to use the vault here</Text>
      <Text style={[styles.base, { color: color.text2 }]}>
        This browser was paired through the relay. It can see your vault's names, but it can't show, copy or fill a secret until you trust it from your Mac or phone.
      </Text>
      <View style={styles.cardButtons}>
        {ask ? (
          <Button
            kind="primary"
            label={asked ? "Asked · waiting for your Mac" : "Ask to trust"}
            disabled={asked}
            onPress={async () => setErr(await askTrust())}
          />
        ) : null}
        <Button kind="ghost" label="How" onPress={() => setHow((h) => !h)} testID="vault-how" />
      </View>
      {how ? <Text style={[styles.base, { color: color.text }]}>{howText(name)}</Text> : null}
      {err ? <Text style={[styles.meta, { color: color.text2 }]}>{err}</Text> : null}
    </View>
  );
}

/** A pushed item's empty place, or the detail pane's before a pick. */
export function NoItem({ text }: { text: string }) {
  const { color } = useTheme();
  return (
    <View style={styles.none}>
      <Text style={[styles.body, { color: color.label }]}>{text}</Text>
    </View>
  );
}

const phone = tokens.type.phone;
const styles = StyleSheet.create({
  namesOnly: { paddingHorizontal: tokens.layout.gutterPhone, paddingVertical: tokens.space[4], gap: tokens.space[1], borderBottomWidth: StyleSheet.hairlineWidth },
  footer: { paddingHorizontal: tokens.layout.gutterPhone, paddingVertical: tokens.space[4] },
  detail: { padding: tokens.layout.gutterPhone, gap: tokens.space[4], maxWidth: tokens.layout.content, width: "100%" },
  title: { fontSize: phone.title[0], lineHeight: phone.title[1], fontWeight: tokens.font.weight.strong },
  strong: { fontSize: phone.read[0], lineHeight: phone.read[1], fontWeight: tokens.font.weight.strong },
  body: { fontSize: phone.read[0], lineHeight: phone.read[1] },
  base: { fontSize: phone.base[0], lineHeight: phone.base[1] },
  meta: { fontSize: phone.meta[0], lineHeight: phone.meta[1] },
  mono: { fontFamily: MONO, ...(Platform.OS === "web" ? ({ wordBreak: "break-all" } as object) : null) },
  field: { flexDirection: "row", alignItems: "center", gap: tokens.space[4], paddingVertical: tokens.space[4], borderTopWidth: StyleSheet.hairlineWidth },
  fieldLabel: { width: 96 },
  fieldValue: { flex: 1, minWidth: 0, gap: tokens.space[1] },
  fieldButtons: { flexDirection: "row", alignItems: "center", gap: tokens.space[2] },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: tokens.radius.cardPhone, padding: tokens.space[5], gap: tokens.space[3] },
  cardButtons: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: tokens.space[3] },
  none: { flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.layout.gutterPhone },
});
