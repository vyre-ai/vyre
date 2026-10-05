// Settings, Spending limits and Standing permissions (the Deck's settings-spend.js and settings-permissions.js, ported).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Segmented, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { limits } from "./limits";
import { EMPTY_FORM, KINDS, permissionMeta, sentence, spendName, spendWords, type Intent, type PermissionForm, type SpendRow } from "./limits-model.ts";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);

export function SpendScreen() {
  const [data, setData] = useState<{ day: string; rows: SpendRow[] } | null>(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => { setErr(""); limits.spend().then(setData).catch((e) => setErr(say(e, "Spend could not be read."))); }, []);
  useEffect(load, [load]);
  const finish = (fn: () => Promise<unknown>) => { setBusy(true); setProblem(""); fn().then(() => { setEditing(""); load(); showToast("The cap is changed."); }).catch((e) => setProblem(say(e))).finally(() => setBusy(false)); };
  return (
    <Page title="Spending limits" back="/u/settings">
      <Banner>{`Today, ${data?.day || "UTC"} (UTC). At a provider's daily cap its work pauses with one line saying how to raise it; nothing asks first.`}</Banner>
      {err ? <Card flush><ErrorState title="Spend did not load" reason={err} retry={load} /></Card> : null}
      {!data && !err ? <LoadingState rows={3} /> : null}
      {data && !data.rows.length ? <Card><EmptyState title="Nothing spent today" body="Spend per provider shows here once an assistant has worked." /></Card> : null}
      {data && data.rows.length ? (
        <Card flush>
          {data.rows.map((p, i) => (
            <View key={p.provider}>
              {i ? <Divider /> : null}
              <View className="gap-s2 p-s3">
                <Text strong>{spendName(p.provider)}</Text>
                <Text tone="muted">{spendWords(p)}{p.estimated ? " (estimated from tokens)" : ""}</Text>
                {editing === p.provider ? (
                  <View className="gap-s2">
                    <Field name={`${spendName(p.provider)} daily cap in dollars`} kind="number" value={amount} onChangeText={setAmount} placeholder="Dollars a day" />
                    {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
                    <View className="flex-row flex-wrap gap-s2">
                      <Button size="sm" label="Set cap" disabled={busy} onPress={() => finish(() => limits.setCap(p.provider, amount))} />
                      <Button kind="ghost" size="sm" label="No cap" disabled={busy} onPress={() => finish(() => limits.noCap(p.provider))} />
                      <Button kind="ghost" size="sm" label="Cancel" onPress={() => { setEditing(""); setProblem(""); }} />
                    </View>
                  </View>
                ) : <View className="self-start"><Button kind="ghost" size="sm" label="Change cap" onPress={() => { setEditing(p.provider); setAmount(p.cap == null ? "" : String(p.cap)); setProblem(""); }} /></View>}
              </View>
            </View>
          ))}
        </Card>
      ) : null}
    </Page>
  );
}

export function PermissionsScreen() {
  const [items, setItems] = useState<Intent[] | null>(null);
  const [err, setErr] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<PermissionForm>(EMPTY_FORM);
  const [agents, setAgents] = useState<string[]>([]);
  const load = useCallback(() => { setErr(""); limits.permissions().then(setItems).catch((e) => { setItems([]); setErr(say(e, "Permissions could not be read.")); }); }, []);
  useEffect(load, [load]);
  const set = (k: keyof PermissionForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const open = () => { setAdding(true); if (!agents.length) limits.agentNames().then(setAgents).catch(() => {}); };
  const takeBack = (i: Intent) => { setBusy(i.id); setProblem(""); limits.takeBack(i.id).then(load).catch((e) => setProblem(say(e))).finally(() => setBusy("")); };
  const allow = () => { setBusy("add"); setProblem(""); limits.allow(form).then(() => { setAdding(false); setForm(EMPTY_FORM); load(); showToast("Allowed."); }).catch((e) => setProblem(say(e))).finally(() => setBusy("")); };
  const standing = (items || []).filter((i) => i.standing);
  const once = (items || []).filter((i) => !i.standing);
  const rows = (list: Intent[]) => (
    <Card flush>
      {list.map((i, n) => (
        <View key={i.id}>
          {n ? <Divider /> : null}
          <View className="gap-s2 p-s3">
            <Text>{sentence(i)}</Text>
            <Text size="caption" tone="label">{permissionMeta(i)}</Text>
            <View className="self-start"><Button kind="ghost" size="sm" label={busy === i.id ? "Taking back" : "Take back"} disabled={busy === i.id} onPress={() => takeBack(i)} /></View>
          </View>
        </View>
      ))}
    </Card>
  );
  return (
    <Page title="Standing permissions" back="/u/settings">
      <Banner>What Vyre may send, post or pay without asking each time. A send or payment you did not ask for always asks you first. Taking permission back works at once.</Banner>
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
      {err ? <Card flush><ErrorState title="Permissions did not load" reason={err} retry={load} /></Card> : null}
      {items === null && !err ? <LoadingState rows={3} /> : null}
      {items && !err ? (standing.length ? rows(standing) : <Card><EmptyState title="No standing permissions" body="Vyre asks each time." /></Card>) : null}
      {once.length ? <View className="gap-s2"><Text strong>{`${once.length} ${once.length === 1 ? "thing" : "things"} you asked for that ${once.length === 1 ? "has" : "have"} not gone yet`}</Text>{rows(once)}</View> : null}
      {adding ? (
        <Card className="gap-s3">
          <Segmented label="What it may do" value={form.kind} onChange={set("kind")} options={KINDS} />
          <Field label="Where" value={form.channel} onChangeText={set("channel")} placeholder="Where, like slack (optional)" />
          <Field label="To" value={form.to} onChangeText={set("to")} placeholder="Exact addresses or channels, separated by commas" />
          <Field label="What for" value={form.what} onChangeText={set("what")} placeholder="What for (optional)" />
          <Field label="Which agents" value={form.agents} onChangeText={set("agents")} placeholder={agents.length ? `Like ${agents.slice(0, 2).join(", ")} (blank means any)` : "Blank means any of yours"} />
          {form.kind === "pay" ? (<><Field label="Most per payment" kind="number" value={form.amount} onChangeText={set("amount")} /><Field label="Currency" value={form.currency} onChangeText={set("currency")} placeholder="USD" /></>) : null}
          <View className="flex-row flex-wrap gap-s2">
            <Button kind="primary" size="sm" label={busy === "add" ? "Allowing" : "Allow it"} disabled={busy === "add"} onPress={allow} />
            <Button kind="ghost" size="sm" label="Cancel" onPress={() => { setAdding(false); setProblem(""); }} />
          </View>
        </Card>
      ) : <View className="self-start"><Button size="sm" label="Add a permission" onPress={open} /></View>}
    </Page>
  );
}
