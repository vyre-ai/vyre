// One Vault item's page: its fields (plain ones shown in full once read, secrets with Reveal and Copy and, after Reveal, their length and last four characters), Copy as .env,
// how agents and Flows use it, who can use it, what uses it, when it was last used, Test it where its app declares a check, Edit, Move and Delete. Every value is read through the
// vault's own reveal, with its presence step; nothing here keeps a value after the screen hides it.
import { useEffect, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Avatar, Banner, Button, Card, Chip, Field, Row, SecretField, Sheet, Text, markRef, showToast } from "@vyre/ui";
import { Footnote, Sec } from "../places/Frame";
import { canonical, clashes, fieldLabel, placeholder, secretHint, toDotenv, type DField } from "./env-model.js";
import { FieldsEditor } from "./FieldsEditor";
import { ItemSharing } from "./ItemSharing";
import { MoveItem } from "./MoveItem";
import { levelWord } from "./share-model.js";
import type { VItem } from "./redesign.js";
import type { Scope, VaultData } from "./redesign-data";
import type { Need } from "./add-model.js";
import type { Event } from "./sample-redesign";

const CLEAR_MS = 30_000;
const who = (w: string) => markRef(w === "alex" ? "person" : "teammate", w);
const say = (e: unknown, fallback: string) => String((e as Error)?.message || fallback);
/** Words for what a refusal for presence means here, so a device that cannot approve is never a dead end (the owner's ruling of 19 Oct: with no approval device set up, a person's own act goes through). */
const presenceWords = (e: unknown, fallback: string) => ((e as { code?: string })?.code === "presence_required" || (e as { code?: string })?.code === "needs_presence"
  ? "This needs your approval. Approve it in Vyre on your phone, or with Touch ID in a signed Mac app. With no approval device set up, your own acts go through without one."
  : say(e, fallback));

/** The names a field is shown by: its one form; a login's and a note's own fields keep their words. */
const shownField = (item: VItem, name: string) => fieldLabel(item.kind, name);

export function VaultItem({ item, scope, data, owner, needs, events, onChanged, onDelete }: {
  item: VItem; scope: Scope; data: VaultData; owner: boolean; needs: Need[]; events: Event[]; onChanged: () => void; onDelete: () => void;
}) {
  const fields = item.fields ?? [];
  const [plainValues, setPlainValues] = useState<Record<string, string> | null>(null);
  const [editing, setEditing] = useState<DField[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [testTo, setTestTo] = useState<string | null>(null);
  useEffect(() => { setPlainValues(null); setEditing(null); setErr(""); setTestTo(null); }, [item.id]);

  // What this person may do with it: the owner and a member's own items everything; an item shared with a member, what the share allows.
  const can = item.can ?? ["use", "reveal", "edit"];
  const mayRead = can.includes("reveal"), mayEdit = can.includes("edit"), memberShared = !owner && scope === "shared";
  const need = needs.find((n) => n.item === item.id && n.test);
  const clash = clashes(fields.map((f) => f.name));

  const readAll = async () => { const out: Record<string, string> = {}; for (const f of fields) out[f.name] = await data.read(scope, item, f.name); return out; };
  const showPlain = () => {
    setBusy(true); setErr("");
    (async () => { const out: Record<string, string> = {}; for (const f of fields.filter((x) => x.plain)) out[f.name] = await data.read(scope, item, f.name); return out; })()
      .then(setPlainValues).catch((e) => setErr(presenceWords(e, "The values did not load."))).finally(() => setBusy(false));
  };
  const copyEnv = () => {
    setBusy(true); setErr("");
    readAll().then(async (v) => {
      await Clipboard.setStringAsync(toDotenv(fields.map((f) => ({ name: f.name, value: v[f.name] ?? "" }))));
      showToast(`Copied as .env. The clipboard is emptied in ${CLEAR_MS / 1000} seconds.`);
      setTimeout(() => { void Clipboard.setStringAsync(""); }, CLEAR_MS);
    }).catch((e) => setErr(presenceWords(e, "That did not copy."))).finally(() => setBusy(false));
  };
  const startEdit = () => {
    setBusy(true); setErr("");
    readAll().then((v) => setEditing(fields.map((f, i) => ({ id: `e${i}`, key: f.name, value: v[f.name] ?? "", secret: !f.plain, on: true, ...(!owner || (item.kind && item.kind !== "env-set") ? { label: shownField(item, f.name) } : {}) }))))
      .catch((e) => setErr(presenceWords(e, "The values did not load."))).finally(() => setBusy(false));
  };
  // An env item's names are saved in their one form: an older spelling is renamed now, at the person's own edit, never on disk behind their back. Other kinds keep their own names.
  const saveEdit = () => {
    if (!editing) return;
    const on = editing.filter((f) => f.on);
    const names = on.map((f) => (item.kind && item.kind !== "env-set" ? f.key : canonical(f.key)));
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) { setErr(`This item already has ${dup}.`); return; }
    if (names.some((n) => !n)) { setErr("Give every field a name, like API_KEY."); return; }
    const out: Record<string, string> = {};
    on.forEach((f, i) => { out[names[i]] = f.value; });
    setBusy(true); setErr("");
    data.update(scope, item, out, on.flatMap((f, i) => (f.secret ? [] : [names[i]]))).then(() => { setEditing(null); showToast(`${item.name} saved.`); onChanged(); })
      .catch((e) => setErr(presenceWords(e, "That did not save."))).finally(() => setBusy(false));
  };
  const runTest = () => {
    if (!need?.test || !data.test) return;
    if (need.test.asks === "email" && testTo === null) { setTestTo(""); return; }
    setBusy(true); setErr("");
    data.test(need.test.tool, need.test.asks === "email" ? { to: String(testTo ?? "") } : {}).then((m) => { showToast(m); setTestTo(null); }).catch((e) => setErr(presenceWords(e, "The test did not pass."))).finally(() => setBusy(false));
  };

  const fieldRow = (f: { name: string; plain: boolean }) => (
    <View key={f.name} className="gap-s1 border-b border-edge p-s3">
      <Text mono strong>{shownField(item, f.name)}</Text>
      {!mayRead ? <Text size="caption" tone="label">{f.plain ? "Plain" : "Secret"}. You can use it, without seeing it.</Text>
        : f.plain ? (plainValues ? <Text mono selectable>{plainValues[f.name] ?? ""}</Text> : <Text size="caption" tone="label">Plain. Shown in full with Show values.</Text>)
        : <SecretField key={`${item.id}.${f.name}`} label={shownField(item, f.name)} read={() => data.read(scope, item, f.name)} hint={secretHint} />}
    </View>
  );

  const first = fields.find((f) => !f.plain) ?? fields[0];
  const last = events[0];
  return (
    <Card>
      <View className="gap-s4">
        <View className="gap-s1">
          <View className="flex-row flex-wrap items-center gap-s2"><Text size="title" strong>{item.name}</Text><Chip icon={item.folder ? "folder" : "person"}>{item.folder ? item.folder.name : "Mine"}</Chip></View>
          <Text size="caption" tone="label">{last ? `Last used ${last.when}, by ${last.who}.` : item.lastUsedDays === null ? "Not used yet." : "Not used lately."}</Text>
        </View>
        {clash.length ? <Banner tone="warn" icon="warning"><Text>{`${clash[0].stored.join(" and ")} are one name, ${clash[0].name}. Rename one.`}</Text></Banner> : null}

        <Sec title="Fields">
          <Card flush>{fields.length ? fields.map(fieldRow) : <View className="p-s3"><Text tone="muted">No fields are listed for this item.</Text></View>}</Card>
          <View className="flex-row flex-wrap gap-s2 pt-s2">
            {mayRead && fields.some((f) => f.plain) && !plainValues ? <Button kind="secondary" size="sm" icon="eye" label="Show values" disabled={busy} onPress={showPlain} /> : null}
            {mayRead && fields.length ? <Button kind="secondary" size="sm" icon="copy" label="Copy as .env" disabled={busy} onPress={copyEnv} /> : null}
            {mayEdit && !memberShared ? <Button kind="secondary" size="sm" icon="edit" label={clash.length ? "Rename one" : "Edit"} disabled={busy} onPress={startEdit} /> : null}
            {need?.test && data.test ? <Button kind="secondary" size="sm" icon="check" label="Test it" disabled={busy} onPress={runTest} /> : null}
          </View>
          {testTo !== null ? <View className="gap-s2 pt-s2"><Field label="Send a test to" kind="email" value={testTo} onChangeText={setTestTo} placeholder="alex@example.com" onSubmit={runTest} /><View className="self-start"><Button kind="primary" size="sm" label="Send the test" disabled={busy || !testTo.includes("@")} onPress={runTest} /></View></View> : null}
          {err ? <Footnote icon="info">{err}</Footnote> : null}
        </Sec>

        <Sec title="How agents and Flows use it">
          <Text tone="label">{`An agent or Flow that can use this writes a placeholder, like ${first ? placeholder(item.id, first.name) : "{{vault:Item.FIELD}}"}. Vyre fills in the value when it sends, so the model never sees a secret. It can read the plain fields.`}</Text>
          {fields.length ? <Card flush>{fields.map((f) => <Row key={f.name} dense title={<Text mono selectable>{placeholder(item.id, f.name)}</Text>} sub={f.plain ? "Plain" : "Secret"} />)}</Card> : null}
        </Sec>

        <Sec title="Who can use it">
          {owner && data.sharing ? <ItemSharing api={data.sharing} item={item} />
            : memberShared ? <Text tone="muted">{`You: ${levelWord(mayEdit ? "edit" : mayRead ? "reveal" : "use")}.`}</Text>
            : <Text tone="muted">Only you. Your own items are not shared.</Text>}
        </Sec>

        <Sec title="Used by">
          {item.usedBy.length ? <Card flush>{item.usedBy.map((u) => <Row key={u.kind + u.name} dense title={u.name} sub={u.kind === "flow" ? "Flow" : u.kind === "agent" ? "Agent" : u.kind === "project" ? "Project" : "App"} />)}</Card> : <Text tone="muted">Nothing uses it yet.</Text>}
        </Sec>

        {events.length ? <Sec title="Activity"><Card flush>{events.slice(0, 4).map((e) => <Row key={e.id} dense lead={<Avatar of={who(e.who)} size={24} />} title={e.what} sub={`${e.who}, ${e.when}`} />)}</Card></Sec> : null}

        {memberShared ? null : <View className="flex-row flex-wrap gap-s2">{owner && data.folders ? <MoveItem api={data.folders} item={item} onMoved={onChanged} /> : null}<Button kind="ghost" size="sm" icon="trash" label="Delete" onPress={onDelete} /></View>}
      </View>

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={`Edit ${item.name}`}>
        {editing ? (
          <View className="gap-s4">
            <FieldsEditor fields={editing} multiline={item.kind === "note"} onChange={(id, change) => setEditing((xs) => (xs ? xs.map((f) => (f.id === id ? { ...f, ...change } : f)) : xs))}
              canAdd={owner || scope === "mine"} canRemove={owner} onAdd={() => setEditing((xs) => [...(xs ?? []), { id: `e${(xs ?? []).length}n`, key: "", value: "", secret: true, on: true }])} />
            {owner ? null : <Text size="caption" tone="label">In your own vault you can change values and add fields. To rename or remove one, add the item again.</Text>}
            {err ? <Footnote icon="info">{err}</Footnote> : null}
            <View className="flex-row gap-s2"><Button kind="primary" label={busy ? "Saving" : "Save"} disabled={busy} onPress={saveEdit} /><Button kind="ghost" label="Cancel" onPress={() => setEditing(null)} /></View>
          </View>
        ) : null}
      </Sheet>
    </Card>
  );
}
