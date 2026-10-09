// Vault from the real vyred. A list of the box's own items (names, kinds, who has them, how they were used), and Reveal per field, which is a
// person's own call: the box asks for presence, the app's person session answers it, and the value lives in this screen's state for 30 seconds.
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, Field, IconTile, Row, SealedMask, Segmented, Sheet, Tabs, Text, showToast, ErrorState, LoadingState, useRecordsWorld } from "@vyre/ui";
import { usePhone } from "../places/Page";
import { Footnote, Frame, Sec } from "../places/Frame";
import { REVEAL_MS } from "./logic.js";
import { grantReal, listReal, putReal, revealHeldReal, revealReal, revokeReal, stateReal, unlockPersonalReal, unlockReal, usesReal } from "./real";
import { claimBlocked } from "../shell/rc";
import { ON_PHONE, howApprove } from "../../src/real/on-phone.js";
import { presenceText } from "../shell/FaceIdSheet";
import ImportPage from "./ImportPage";
import { DevicesPage, EditSheet, ItemHistory, PassesPage, SharedPage, SshSheet, WatchtowerPage } from "./RealVaultMore";
import { heldByRecord, heldFields, heldLine, shareInput, shareNote, shareRefusal, type Share } from "./held-model";
import { REVEAL_PURPOSE } from "../../ui/fields/logic.js";
import { NEW_KINDS, putProblems, personalUnlockRefusal, itemsOf, tabOf, kindWord, putInput, putRefusal, revealRefusal, useCount, usesLine, type ListRow, type NewItem, type RealItem, type Tab, type UseRow } from "./real-model";

const say = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export default function RealVault() {
  const phone = usePhone();
  const [tab, setTab] = useState<Tab | "Held">("Login");
  const [sharing, setSharing] = useState<Share | null>(null);
  const records = useRecordsWorld();
  const held = records.data ? heldFields(records.data.types, records.data.byType) : [];
  const [heldShown, setHeldShown] = useState<{ id: string; value: string } | null>(null);
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [pushed, setPushed] = useState(false);
  const [personal, setPersonal] = useState("none");
  const [pw, setPw] = useState("");
  const [pwProblem, setPwProblem] = useState("");
  const [unlock, setUnlock] = useState<"passphrase" | "none">("none");
  // a save that went through says the vault is open, whatever the list said before it
  const savedOpen = useRef(false);
  const [fieldErr, setFieldErr] = useState<Partial<Record<"name" | "username" | "secret" | "url", string>>>({});
  const [pass, setPass] = useState("");
  const [adding, setAdding] = useState<NewItem | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<"items" | "passes" | "shared" | "devices" | "health" | "import">("items");
  const [editing, setEditing] = useState(false);
  const [ssh, setSsh] = useState(false);
  const [uses, setUses] = useState<Record<string, UseRow[]>>({});
  const [shown, setShown] = useState<{ key: string; value: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; setShown(null); setHeldShown(null); }, []);
  useEffect(() => hide, [hide]);

  const load = useCallback(() => {
    setErr("");
    listReal().then((r) => { setRows(r.items); setLocked(r.locked && !savedOpen.current); setPersonal(r.personal); }).catch((e) => setErr(say(e, "The vault did not answer.")));
    stateReal().then((s) => { if (s) setUnlock(s.unlock); }).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const items: RealItem[] = rows && tab !== "Held" ? itemsOf(rows, tab) : [];
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

  const revealHeld = (h: { id: string; urn: string; field: string }) => {
    revealHeldReal(h.urn, h.field, REVEAL_PURPOSE)
      .then((value) => { hide(); setHeldShown({ id: h.id, value }); timer.current = setTimeout(hide, REVEAL_MS); })
      .catch((e: unknown) => showToast(revealRefusal((e as { code?: string }).code, say(e, ""), Platform.OS === "web" ? (howApprove() === "touchid" ? "touchid" : "browser") : "phone")));
  };
  const doShare = (item: RealItem) => {
    if (!sharing) return;
    const p = shareInput(item.id, sharing);
    if ("error" in p) { setProblem(p.error); return; }
    setBusy(true); setProblem("");
    grantReal(p.input).then((r) => { showToast(shareNote(sharing.module.trim(), item.name, r)); setSharing(null); load(); }).catch((e) => setProblem(shareRefusal((e as { code?: string }).code, say(e, "")))).finally(() => setBusy(false));
  };

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
    const bad = putProblems(adding);
    if (Object.keys(bad).length) { setFieldErr(bad); setProblem(""); return; }
    const p = putInput(adding);
    if ("error" in p) { setProblem(p.error); return; }
    setBusy(true); setProblem(""); setFieldErr({});
    putReal(p.input).then(() => { savedOpen.current = true; setLocked(false); showToast(`${adding.name.trim()} is in the vault.`); setAdding(null); load(); }).catch((e) => setProblem(putRefusal((e as { code?: string }).code, say(e, "")))).finally(() => setBusy(false));
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
          ) : <Text tone="muted">Only you. No module or assistant can use this item until you share it.</Text>}
          {claimBlocked() ? null : <View className="self-start pt-s2"><Button kind="ghost" size="sm" icon="plus" label="Share with a module or assistant" onPress={() => { setProblem(""); setSharing({ module: "", project: "" }); }} /></View>}
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
      {!err && rows && !locked && section !== "import" ? <Segmented label="Vault" value={section} onChange={(v) => { hide(); setSection(v); }} options={[["items", "Items"], ["passes", "Passes"], ["shared", "Shared"], ["devices", "Devices"], ["health", "Health"]]} /> : null}
      {!err && rows && !locked && section === "passes" ? <PassesPage rows={rows} reload={load} openItem={openFrom} /> : null}
      {!err && rows && !locked && section === "shared" ? <SharedPage rows={rows} reload={load} openItem={openFrom} /> : null}
      {!err && rows && !locked && section === "devices" ? <DevicesPage rows={rows} reload={load} openItem={openFrom} /> : null}
      {!err && rows && !locked && section === "health" ? <WatchtowerPage rows={rows} reload={load} openItem={openFrom} /> : null}
      {!err && rows && !locked && section === "import" ? <View className="gap-s3">
        <View className="self-start"><Button kind="ghost" size="sm" icon="chevron-left" label="Vault" onPress={() => setSection("items")} /></View>
        <Text size="title" strong accessibilityRole="header">Bring in passwords and keys</Text>
        {claimBlocked() ? <Text tone="muted">{ON_PHONE.replace("Do this", "Import")}</Text> : <ImportPage reload={load} />}
      </View> : null}
      {section !== "items" ? null : <>
      <Tabs<Tab | "Held"> value={tab} onChange={(t) => { hide(); setSel(null); setTab(t); }} items={[["Login", "Logins"], ["Key", "Keys"], ["Card", "Cards"], ["Held", "Held fields"]]} />
      {!err && rows && !locked && personal === "locked" ? <Card><View className="gap-s3">
        <Text strong>Your personal vault is locked</Text>
        {claimBlocked() ? <Text tone="muted">{ON_PHONE.replace("Do this", "Unlock it")}</Text> : <>
          <Text tone="muted">{presenceText("Enter its password and confirm with Face ID.")}</Text>
          <Field label="Password" value={pw} onChangeText={setPw} kind="password" />
          {pwProblem ? <Banner tone="warn"><Text>{pwProblem}</Text></Banner> : null}
          <View className="self-start"><Button kind="primary" label={busy ? "Opening" : "Unlock"} disabled={busy || !pw} onPress={doUnlockPersonal} /></View>
        </>}
      </View></Card> : null}
      {!err && rows && !locked ? (claimBlocked() ? <Text size="caption" tone="label">{ON_PHONE.replace("Do this", "Add items")}</Text> : <View className="self-start"><View className="flex-row flex-wrap gap-s2"><Button kind="primary" icon="plus" label="Add an item" onPress={() => { setProblem(""); setAdding({ kind: "login", name: "", username: "", secret: "", url: "" }); }} /><Button kind="ghost" label="Make an SSH key" onPress={() => setSsh(true)} /><Button kind="ghost" label="Import" onPress={() => { hide(); setSection("import"); }} /></View></View>) : null}
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
      {tab === "Held" ? (
        records.error && !records.data ? <Card flush><EmptyState title="Held fields did not load" body={records.error.message} action={{ label: "Try again", onPress: () => void records.reload() }} /></Card>
        : records.loading && !records.data ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card>
        : <><Text size="caption" tone="label">A held field is a sealed value on a record, such as a tax ID. The Vault keeps the value; the record keeps only a reference, and an assistant sees that it is on file, not what it says.</Text><Card flush>
            {held.length ? heldByRecord(held).map((g, gi) => (
              <View key={g.urn}>{gi ? <Divider /> : null}
                <Row dense title={g.title} sub={g.typeLabel} />
                {g.fields.map((h) => (
                  <Row key={h.id} dense lead={<IconTile name="sealed" tone="warn" />} title={h.label} sub={heldShown?.id === h.id ? undefined : heldLine(h)}
                    end={heldShown?.id === h.id ? <><Text mono selectable>{heldShown.value}</Text><Button kind="ghost" size="sm" label="Hide" onPress={hide} /></>
                      : claimBlocked() ? <Text size="caption" tone="label">Reveal in Vyre on your phone</Text> : <Button kind="ghost" size="sm" icon="face" label="Reveal" onPress={() => revealHeld(h)} />} />
                ))}
              </View>
            )) : <EmptyState title="No sealed fields" body="Seal a field on a record and its value moves into the Vault." />}
          </Card></>
      ) : null}
      {tab !== "Held" && !err && rows && !locked ? (
        <View className={phone ? "gap-s4" : "flex-row items-start gap-s4"}>
          <View className={phone ? "" : "min-w-0 flex-1"}>
            <Card flush>
              {items.length ? items.map((v, i) => (
                <View key={v.id}>{i ? <Divider inset={60} /> : null}
                  <Row dense chevron={phone} selected={!phone && cur?.id === v.id} lead={<IconTile name={v.tab === "Card" ? "file" : "key"} />} title={v.name}
                    sub={uses[v.id] ? `${v.line} · ${useCount(uses[v.id], Date.now())} uses today` : v.line} onPress={() => { hide(); setSel(v.id); setPushed(true); }} />
                </View>
              )) : <EmptyState title="Nothing here yet" body={rows.length ? `No ${tab.toLowerCase()}s in the vault.` : claimBlocked() ? "No items yet. Add items in Vyre on your phone." : "No items yet. Use Add an item, or bring them in from 1Password, LastPass or a browser under Import."} />}
            </Card>
          </View>
          {phone ? null : <View className="min-w-pane min-w-0 flex-[1.2]">{detail}</View>}
        </View>
      ) : null}
      </>}
      {editSheet}
      <SshSheet open={ssh} onClose={() => setSsh(false)} onMade={load} />
      <Sheet open={!!sharing} onClose={() => setSharing(null)} title={cur ? `Share ${cur.name}` : "Share"}>
        {sharing && cur ? (
          <View className="gap-s3">
            <Field label="Who" value={sharing.module} onChangeText={(module) => setSharing({ ...sharing, module })} placeholder="mail" help="A module or assistant by name. Use name/watcher for one watcher." />
            <Field label="Only in this project (optional)" value={sharing.project} onChangeText={(project) => setSharing({ ...sharing, project })} />
            {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
            <Button kind="primary" label={busy ? "Sharing" : "Share with Face ID"} onPress={busy ? () => {} : () => doShare(cur)} />
            <Text size="caption" tone="label">Use only. It never sees the value, and you can take it back under Who has it.</Text>
          </View>
        ) : null}
      </Sheet>
      <Sheet open={!!adding} onClose={() => { setAdding(null); setFieldErr({}); }} title="Add to the vault">
        {adding ? (
          <View className="gap-s3">
            <Segmented label="Kind" value={adding.kind} onChange={(kind) => setAdding({ ...adding, kind })} options={NEW_KINDS} />
            <Field label="Name" error={fieldErr.name} value={adding.name} onChangeText={(name) => { setFieldErr((e) => ({ ...e, name: undefined })); setAdding({ ...adding, name }); }} placeholder={adding.kind === "login" ? "Juniper Drive" : "OpenAI key"} />
            {adding.kind === "login" ? <Field label="Username" error={fieldErr.username} value={adding.username} onChangeText={(username) => { setFieldErr((e) => ({ ...e, username: undefined })); setAdding({ ...adding, username }); }} /> : null}
            <Field label={adding.kind === "login" ? "Password" : "Value"} error={fieldErr.secret} value={adding.secret} onChangeText={(secret) => { setFieldErr((e) => ({ ...e, secret: undefined })); setAdding({ ...adding, secret }); }} kind="password" />
            {adding.kind === "login" ? <Field label="Web address (optional)" error={fieldErr.url} value={adding.url} onChangeText={(url) => { setFieldErr((e) => ({ ...e, url: undefined })); setAdding({ ...adding, url }); }} placeholder="https://drive.juniper.example" /> : null}
            {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
            <Button kind="primary" label={busy ? "Saving" : "Save with Face ID"} onPress={busy ? () => {} : doAdd} />
            <Text size="caption" tone="label">The box asks you to approve this save. Assistants never see the value.</Text>
          </View>
        ) : null}
      </Sheet>
    </Frame>
  );
}
