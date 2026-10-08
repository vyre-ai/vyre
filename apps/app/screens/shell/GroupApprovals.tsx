// A held group as one card: what an assistant's calls (three emails, say) will do, each item's exact words, a Drop or an Edit on any, and one yes that Face ID signs once per approved item.
// Drawn on Now and in the conversation. The pure half is src/real/group-approve.js; the server is approvals.pending / approvals.answer-group / approvals.edit-item (core/approvals).
import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { Button, Card, Divider, Field, Text, showToast } from "@vyre/ui";
import { call } from "../../src/api/box";
import { phoneSigner } from "../../src/real/phone-signer";
import { shellSigner } from "../../src/real/shell-signer";
import { shellIdentity } from "../../src/shell/shell";
import { howWord } from "../../src/real/on-phone.js";
import { answerRefusal } from "../../src/real/phone-approve.js";
import { approveCard } from "../../src/real/phone-approve.js";
import { proofHeader } from "../../src/real/approvals.js";
import { approveGroup, closingLine, editItem, groupsFrom, readAll, wordLines, yesLabel, type Group, type Item } from "../../src/real/group-approve.js";

const ask = async (tool: string, input: Record<string, unknown>, o?: { kernelProof?: string }) => {
  const r = await call<any>(tool, input, o);
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return r.data;
};
const signer = async () => (await phoneSigner()) ?? (await shellSigner());
/** Words past this many characters open on a tap; the rest of the card stays short. */
const SHORT = 160;

function ItemRow({ item, dropped, onDrop, onEdit, onRead, onApproveOne }: { item: Item; dropped: boolean; onDrop: () => void; onEdit: (field: string, text: string) => void; onRead: () => void; onApproveOne: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const lines = wordLines(item);
  return (
    <View className="gap-s1 px-s4 py-s2" style={dropped ? { opacity: 0.5 } : undefined}>
      <Text size="body" strong>{item.line || item.title}</Text>
      {item.partial ? <Text size="caption" tone="err">{item.readAll ? "You have read all of it. Approve it on its own; it is not part of the group yes." : "Part of this is not shown here, so it cannot be approved with the others. Read all of it first."}</Text> : null}
      {lines.map((w) => {
        const long = w.text.length > SHORT && !open;
        return editing === w.field ? (
          <View key={w.field} className="gap-s1">
            <Field label={w.field} value={draft} onChangeText={setDraft} multiline lines={4} />
            <View className="flex-row gap-s2">
              <Button kind="primary" size="sm" label="Save" onPress={() => { onEdit(w.field, draft); setEditing(null); }} />
              <Button kind="ghost" size="sm" label="Cancel" onPress={() => setEditing(null)} />
            </View>
          </View>
        ) : (
          <View key={w.field}>
            <Text size="caption" strong tone="label">{w.field}</Text>
            <Text size="caption" tone="label" mono>{long ? `${w.text.slice(0, SHORT)}…` : w.text}{w.cut ? " (cut for length)" : ""}</Text>
          </View>
        );
      })}
      <View className="flex-row gap-s2 pt-s1">
        {lines.some((w) => w.text.length > SHORT) ? <Button kind="ghost" size="sm" label={open ? "Show less" : "Show more"} onPress={() => setOpen(!open)} /> : null}
        {item.partial && !item.readAll ? <Button kind="secondary" size="sm" label="Read all" onPress={onRead} /> : null}
        {item.partial && item.readAll && !dropped ? <Button kind="primary" size="sm" icon="faceid" label="Approve this one" onPress={onApproveOne} /> : null}
        {!item.partial && !dropped && lines.length ? <Button kind="ghost" size="sm" label="Edit" onPress={() => { const w = lines[lines.length - 1]; setDraft(w.text); setEditing(w.field); }} /> : null}
        <Button kind="ghost" size="sm" label={dropped ? "Keep" : "Drop"} onPress={onDrop} />
      </View>
    </View>
  );
}

export function GroupApprovals() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [canSign, setCanSign] = useState<boolean | null>(null);
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const load = useCallback(() => { ask("approvals.pending", {}).then((a) => setGroups(groupsFrom(a))).catch(() => setGroups([])); }, []);
  useEffect(() => {
    if (Platform.OS === "web" && !shellIdentity()) return;
    load();
    void signer().then((s) => setCanSign(!!s));
    const t = setInterval(load, 60_000);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") load(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [load]);
  if (Platform.OS === "web" && !shellIdentity()) return null;
  if (done) return <View className="px-s4 pb-s3"><Text size="body">{done}</Text></View>;
  if (!groups.length) return null;
  const say = async (g: Group) => {
    setBusy(true);
    try {
      const me = await ask("records.me", {}).catch(() => null);
      const person = typeof me?.person === "string" ? me.person : me?.person?.id ?? "";
      const out = await approveGroup({ group: g, dropped, signer: await signer(), call: ask, person });
      const line = closingLine(out.results ?? [], g, { logged: g.items.every((i) => /mail\.send|email/i.test(i.op)) });
      setDone(line);
      showToast(line);
    } catch (e) { showToast(answerRefusal((e as { code?: string }).code, howWord(Platform.OS))); }
    finally { setBusy(false); setDropped(new Set()); load(); }
  };
  const edit = async (g: Group, item: Item, field: string, text: string) => {
    try {
      const next = await editItem(item, { [field]: text }, ask);
      setGroups((all) => all.map((x) => (x.id === g.id ? { ...x, items: x.items.map((i) => (i.id === item.id ? next : i)) } : x)));
    } catch { showToast("That change did not go through."); }
  };
  const read = async (g: Group, item: Item) => {
    try {
      const next = await readAll(item, ask);
      setGroups((all) => all.map((x) => (x.id === g.id ? { ...x, items: x.items.map((i) => (i.id === item.id ? next : i)) } : x)));
    } catch { showToast("That could not be read. Try again."); }
  };
  const approveOne = async (item: Item) => {
    setBusy(true);
    try {
      const me = await ask("records.me", {}).catch(() => null);
      const person = typeof me?.person === "string" ? me.person : me?.person?.id ?? "";
      await approveCard(item as never, await signer(), ask, proofHeader, person);
      showToast("Approved.");
    } catch (e) { showToast(answerRefusal((e as { code?: string }).code, howWord(Platform.OS))); }
    finally { setBusy(false); load(); }
  };
  return (
    <View className="gap-s2 px-s4 pb-s3">
      {groups.map((g) => (
        <View key={g.id} className="gap-s1">
          <Text size="caption" strong tone="label">{g.line || "Waiting for your approval"}</Text>
          <Card flush>
            {g.items.map((item, i) => (
              <View key={item.id}>{i ? <Divider /> : null}
                <ItemRow item={item} dropped={dropped.has(item.id)} onDrop={() => setDropped((d) => { const n = new Set(d); if (!n.delete(item.id)) n.add(item.id); return n; })} onEdit={(f, t) => void edit(g, item, f, t)} onRead={() => void read(g, item)} onApproveOne={() => void approveOne(item)} />
              </View>
            ))}
            <View className="flex-row gap-s2 px-s4 py-s3">
              {canSign ? <Button kind="primary" size="sm" icon="faceid" label={busy ? "Waiting" : yesLabel(g, dropped)} disabled={busy || yesLabel(g, dropped) === "Nothing to approve"} onPress={() => void say(g)} /> : <Text size="caption" tone="label">This phone cannot approve yet. Update Vyre.</Text>}
            </View>
          </Card>
        </View>
      ))}
    </View>
  );
}
