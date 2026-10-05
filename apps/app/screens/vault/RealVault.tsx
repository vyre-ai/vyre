// Vault from the real vyred. A list of the box's own items (names, kinds, who has them, how they were used), and Reveal per field, which is a
// person's own call: the box asks for presence, the app's person session answers it, and the value lives in this screen's state for 30 seconds.
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, Field, IconTile, Row, SealedMask, Segmented, Sheet, Tabs, Text, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { usePhone } from "../places/Page";
import { Footnote, Frame, Sec } from "../places/Frame";
import { REVEAL_MS } from "./logic.js";
import { listReal, putReal, revealReal, revokeReal, stateReal, unlockPersonalReal, unlockReal, usesReal } from "./real";
import { claimBlocked } from "../shell/rc";
import { ON_PHONE, howApprove } from "../../src/real/on-phone.js";
import { presenceText } from "../shell/FaceIdSheet";
import { DevicesPage, EditSheet, ItemHistory, PassesPage, SharedPage, SshSheet, WatchtowerPage } from "./RealVaultMore";
import { NEW_KINDS, personalUnlockRefusal, itemsOf, tabOf, kindWord, putInput, putRefusal, revealRefusal, useCount, usesLine, type ListRow, type NewItem, type RealItem, type Tab, type UseRow } from "./real-model";

const say = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export default function RealVault() {
  const phone = usePhone();
  const [tab, setTab] = useState<Tab>("Login");
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [pushed, setPushed] = useState(false);
  const [personal, setPersonal] = useState("none");
  const [pw, setPw] = useState("");
  const [pwProblem, setPwProblem] = useState("");
  const [unlock, setUnlock] = useState<"passphrase" | "none">("none");
  const [pass, setPass] = useState("");
  const [adding, setAdding] = useState<NewItem | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<"items" | "passes" | "shared" | "devices" | "health">("items");
  const [editing, setEditing] = useState(false);
  const [ssh, setSsh] = useState(false);
  const [uses, setUses] = useState<Record<string, UseRow[]>>({});
  const [shown, setShown] = useState<{ key: string; value: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; setShown(null); }, []);
  useEffect(() => hide, [hide]);

  const load = useCallback(() => {
    setErr("");
    listReal().then((r) => { setRows(r.items); setLocked(r.locked); setPersonal(r.personal); }).catch((e) => setErr(say(e, "The vault did not answer.")));
    stateReal().then((s) => { if (s) setUnlock(s.unlock); }).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const items: RealItem[] = rows ? itemsOf(rows, tab) : [];
  const cur = items.find((v) => v.id === sel) ?? (phone ? undefined : items[0]);
  useEffect(() => {
    if (!cur || uses[cur.id]) return;
    usesReal(cur.id).then((u) => setUses((m) => ({ ...m, [cur.id]: u }))).catch(() => setUses((m) => ({ ...m, [cur.id]: [] })));
  }, [cur?.id]);

  const reveal = (item: RealItem, field: string) => {
    revealReal(item.id, field)
      .then((value) => {
        hide();
        setShown({ key: `${item.id}/${field}`, value });
        timer.current = setTimeout(hide, REVEAL_MS);
        setUses((m) => { const { [item.id]: _gone, ...rest } = m; return rest; });
      })
      .catch((e) => showToast(revealRefusal((e as { code?: string }).code, say(e, ""), Platform.OS === "web" ? (howApprove() === "touchid" ? "touchid" : "browser") : "phone")));
  };
  const remove = (item: RealItem, who: string) =>
    revokeReal(item.id, who).then(() => { showToast(`${who} no longer has ${item.name}.`); load(); }).catch((e) => showToast(say(e, "That did not work.")));

  const doUnlockPersonal = () => {
    setBusy(true); setPwProblem("");
    unlockPersonalReal(pw).then(() => { setPw(""); showToast("Your personal vault is open."); load(); }).catch((e) => setPwProblem(personalUnlockRefusal((e as { code?: string }).code, (e as { detail?: { retry_after_s?: number } }).detail))).finally(() => setBusy(false));
  };
  const doUnlock = () => {
    if (!pass) return;
    setBusy(true); setProblem("");
    unlockReal(pass).then(() => { setPass(""); showToast("The vault is open."); load(); }).catch((e) => setProblem(putRefusal((e as { code?: string }).code, say(e, "")))).finally(() => setBusy(false));
  };
  const doAdd = () => {
    if (!adding) return;
    const p = putInput(adding);
    if ("error" in p) { setProblem(p.error); return; }
    setBusy(true); setProblem("");
    putReal(p.input).then(() => { showToast(`${adding.name.trim()} is in the vault.`); setAdding(null); load(); }).catch((e) => setProblem(putRefusal((e as { code?: string }).code, say(e, "")))).finally(() => setBusy(false));
  };

  /** Open an item from another page (Watchtower): the Items section, on that item's tab. */
  const openFrom = (name: string) => { const r = rows?.find((x) => x.name === name); if (!r) return; hide(); setTab(tabOf(r.kind)); setSel(name); setPushed(true); setSection("items"); };

  const detail = cur ? (
    <Card>
      <View className="gap-s3">
        <View className="gap-s1">
          <View className="flex-row flex-wrap items-center gap-s2">
            <Text size="title" strong>{cur.name}</Text><Chip>{kindWord(cur.kind)}</Chip>
            {cur.unverified ? <Chip tone="warn">Not verified</Chip> : null}
            {cur.rotate ? <Chip tone="warn">Rotate</Chip> : null}
          </View>
          <Text tone="label" numberOfLines={1}>{cur.line}</Text>
        </View>
        <View className="gap-s2 rounded-card border border-edge bg-surface-3 p-s3">
          <Text size="caption" strong tone="label">The values</Text>
          {cur.fields.length ? cur.fields.map((f) => {
            const on = shown?.key === `${cur.id}/${f}`;
            return (
              <View key={f} className="min-h-control flex-row items-center justify-between gap-s2">
                <View className="min-w-0 flex-1 gap-s1">
                  <Text size="caption" tone="label">{f}</Text>
                  {on ? <Text mono size="headline" selectable>{shown!.value}</Text> : <SealedMask label={`${cur.name} ${f}`} />}
                </View>
                {on ? <Button kind="ghost" size="sm" label="Hide" onPress={hide} /> : claimBlocked() ? <Text size="caption" tone="label">Reveal in Vyre on your phone</Text> : <Button kind="ghost" size="sm" icon="face" label="Reveal" onPress={() => reveal(cur, f)} />}
              </View>
            );
          }) : <Text tone="muted">This item has no fields.</Text>}
          {shown?.key.startsWith(`${cur.id}/`) ? <Text size="caption" tone="label">Shown for 30 seconds, then masked again.</Text> : null}
        </View>
        <Sec title="Used, without being seen">
          {(() => {
            const u = usesLine(uses[cur.id] ?? [], Date.now());
            return u.length ? (
              <Card flush>
                {u.map((x, i) => <View key={x.key}>{i ? <Divider /> : null}<Row dense title={x.who} sub={x.text} /></View>)}
              </Card>
            ) : <Text tone="muted">{uses[cur.id] ? "Not used in the last day." : "Loading."}</Text>;
          })()}
        </Sec>
        <Sec title="Who has it">
          {cur.grants.length ? (
            <Card flush>
              {cur.grants.map((g, i) => (
                <View key={g.who + (g.project ?? "")}>{i ? <Divider /> : null}
                  <Row dense title={g.who} sub={g.project ? `Use only, in ${g.project}.` : "Use only. It never sees the value."}
                    end={<Button kind="holdText" size="sm" label="Remove" onPress={() => remove(cur, g.who)} />} />
                </View>
              ))}
            </Card>
          ) : <Text tone="muted">Only you.</Text>}
        </Sec>
        <ItemHistory name={cur.id} />
        {claimBlocked() ? null : <View className="self-start"><Button kind="ghost" size="sm" label="Change" onPress={() => setEditing(true)} /></View>}
      </View>
    </Card>
  ) : null;

  const editSheet = <EditSheet item={editing && cur ? { name: cur.id, description: rows?.find((r) => r.name === cur.id)?.description ?? "", fields: cur.fields } : null} onClose={() => setEditing(false)} onSaved={load} />;

  if (phone && pushed && cur) {
    return <Frame title={cur.name} sub={cur.line} onBack={() => { hide(); setPushed(false); }}>{detail}{editSheet}</Frame>;
  }

  return (
    <Frame title="Vault" sub="Logins, keys and cards.">
      <Footnote icon="shield">Assistants never see a credential. Every use is logged.</Footnote>
      {!err && rows && !locked ? <Segmented label="Vault" value={section} onChange={(v) => { hide(); setSection(v); }} options={[["items", "Items"], ["passes", "Passes"], ["shared", "Shared"], ["devices", "Devices"], ["health", "Health"]]} /> : null}
      {!err && rows && !locked && section === "passes" ? <PassesPage rows={rows} reload={load} openItem={openFrom} /> : null}
      {!err && rows && !locked && section === "shared" ? <SharedPage rows={rows} reload={load} openItem={openFrom} /> : null}
      {!err && rows && !locked && section === "devices" ? <DevicesPage rows={rows} reload={load} openItem={openFrom} /> : null}
      {!err && rows && !locked && section === "health" ? <WatchtowerPage rows={rows} reload={load} openItem={openFrom} /> : null}
      {section !== "items" ? null : <>
      <Tabs<Tab> value={tab} onChange={(t) => { hide(); setSel(null); setTab(t); }} items={[["Login", "Logins"], ["Key", "Keys"], ["Card", "Cards"]]} />
      {!err && rows && !locked && personal === "locked" ? <Card><View className="gap-s3">
        <Text strong>Your personal vault is locked</Text>
        {claimBlocked() ? <Text tone="muted">{ON_PHONE.replace("Do this", "Unlock it")}</Text> : <>
          <Text tone="muted">{presenceText("Enter its password and confirm with Face ID.")}</Text>
          <Field label="Password" value={pw} onChangeText={setPw} kind="password" />
          {pwProblem ? <Banner tone="warn"><Text>{pwProblem}</Text></Banner> : null}
          <View className="self-start"><Button kind="primary" label={busy ? "Opening" : "Unlock"} disabled={busy || !pw} onPress={doUnlockPersonal} /></View>
        </>}
      </View></Card> : null}
      {!err && rows && !locked ? (claimBlocked() ? <Text size="caption" tone="label">{ON_PHONE.replace("Do this", "Add items")}</Text> : <View className="self-start"><View className="flex-row flex-wrap gap-s2"><Button kind="primary" icon="plus" label="Add an item" onPress={() => { setProblem(""); setAdding({ kind: "login", name: "", username: "", secret: "", url: "" }); }} /><Button kind="ghost" label="Make an SSH key" onPress={() => setSsh(true)} /></View></View>) : null}
      {err ? <Card flush><EmptyState title="The vault did not answer" body={err} action={{ label: "Try again", onPress: load }} /></Card> : null}
      {!err && rows === null ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
      {!err && rows && locked ? (
        unlock === "passphrase" ? (
          <Card><View className="gap-s3">
            <Text strong>The vault is locked</Text>
            <Text tone="muted">Enter its passphrase to open it.</Text>
            <Field label="Passphrase" value={pass} onChangeText={setPass} kind="password" help="The first time, the passphrase you type becomes the vault's." />
            {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
            <View className="self-start"><Button kind="primary" label={busy ? "Opening" : "Unlock"} disabled={busy || !pass} onPress={doUnlock} /></View>
          </View></Card>
        ) : <Card flush><ErrorState title="The vault has not answered" reason="Try again in a moment." retry={load} /></Card>
      ) : null}
      {!err && rows && !locked ? (
        <View className={phone ? "gap-s4" : "flex-row items-start gap-s4"}>
          <View className={phone ? "" : "min-w-0 flex-1"}>
            <Card flush>
              {items.length ? items.map((v, i) => (
                <View key={v.id}>{i ? <Divider inset={60} /> : null}
                  <Row dense chevron={phone} selected={!phone && cur?.id === v.id} lead={<IconTile name={v.tab === "Card" ? "file" : "key"} />} title={v.name}
                    sub={uses[v.id] ? `${v.line} · ${useCount(uses[v.id], Date.now())} uses today` : v.line} onPress={() => { hide(); setSel(v.id); setPushed(true); }} />
                </View>
              )) : <EmptyState title="Nothing here yet" body={rows.length ? `No ${tab.toLowerCase()}s in the vault.` : claimBlocked() ? "No items yet. Add items in Vyre on your phone." : "No items yet. Use Add an item."} />}
            </Card>
          </View>
          {phone ? null : <View className="min-w-pane min-w-0 flex-[1.2]">{detail}</View>}
        </View>
      ) : null}
      </>}
      {editSheet}
      <SshSheet open={ssh} onClose={() => setSsh(false)} onMade={load} />
          <Sheet open={!!adding} onClose={() => setAdding(null)} title="Add to the vault">
        {adding ? (
          <View className="gap-s3">
            <Segmented label="Kind" value={adding.kind} onChange={(kind) => setAdding({ ...adding, kind })} options={NEW_KINDS} />
            <Field label="Name" value={adding.name} onChangeText={(name) => setAdding({ ...adding, name })} placeholder={adding.kind === "login" ? "Harlow Drive" : "OpenAI key"} />
            {adding.kind === "login" ? <Field label="Username" value={adding.username} onChangeText={(username) => setAdding({ ...adding, username })} /> : null}
            <Field label={adding.kind === "login" ? "Password" : "Value"} value={adding.secret} onChangeText={(secret) => setAdding({ ...adding, secret })} kind="password" />
            {adding.kind === "login" ? <Field label="Web address (optional)" value={adding.url} onChangeText={(url) => setAdding({ ...adding, url })} placeholder="https://drive.harlow.example" /> : null}
            {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
            <Button kind="primary" label={busy ? "Saving" : "Save with Face ID"} onPress={busy ? () => {} : doAdd} />
            <Text size="caption" tone="label">The box asks you to approve this save. Assistants never see the value.</Text>
          </View>
        ) : null}
      </Sheet>
    </Frame>
  );
}
