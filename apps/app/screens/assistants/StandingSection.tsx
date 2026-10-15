// What this agent may send, post or pay by itself, with Revoke and the add sheet. Shown to an owner, an admin or the agent's own owner; the box decides and answers the list.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, ErrorState, Field, LoadingState, Segmented, Select, Sheet, StandingPermissions, Switch, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { agent } from "./agent";
import { connections } from "../connections/source-real";
import { FOLLOW_WARNING, addCall, refusal, rowView, viaOf, type Permission } from "./standing-model.js";

const say = (e: unknown) => refusal((e as { code?: string })?.code, e instanceof Error ? e.message : "");

export function Standing({ name }: { name: string }) {
  const [rows, setRows] = useState<Permission[] | null>(null);
  const [conns, setConns] = useState<{ via: string; label: string }[]>([]);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { setErr(""); agent.standing(name).then(setRows).catch((e) => setErr(say(e))); }, [name]);
  useEffect(load, [load]);
  useEffect(() => {
    // every way out the Gate holds, named as the person knows it where a connection has a label
    Promise.all([agent.senders().catch(() => []), connections.connections().catch(() => [])]).then(([senders, list]) => {
      const label = (via: string) => list.find((c) => viaOf(c) === via)?.label;
      setConns(senders.filter((s) => s.kinds.some((k) => k === "send" || k === "post" || k === "spend")).map((s) => ({ via: s.name, label: label(s.name) || s.name })));
    });
  }, []);
  const nameOf = (via: string) => conns.find((c) => c.via === via)?.label || via;
  if (name === "assistant") return null;
  if (err) return <Sec title="Acts by itself"><Card flush><ErrorState title="Permissions did not load" reason={err} retry={load} /></Card></Sec>;
  if (!rows) return <Sec title="Acts by itself"><LoadingState rows={2} /></Sec>;
  const revoke = (id: string) => agent.revokeStanding(id).then(() => { showToast("Revoked. It asks you again."); load(); }).catch((e) => showToast(say(e)));
  return (
    <Sec title="Acts by itself">
      <Card>
        <StandingPermissions rows={rows.map((p) => rowView(p, nameOf))} onRevoke={revoke} onAdd={() => setOpen(true)} />
      </Card>
      <AddSheet open={open} name={name} conns={conns} onClose={() => setOpen(false)} onDone={() => { setOpen(false); load(); }} />
    </Sec>
  );
}

function AddSheet({ open, name, conns, onClose, onDone }: { open: boolean; name: string; conns: { via: string; label: string }[]; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"send" | "post" | "spend">("send");
  const [via, setVia] = useState("");
  const [to, setTo] = useState("");
  const [cap, setCap] = useState("20");
  const [max, setMax] = useState("");
  const [day, setDay] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [days, setDays] = useState("");
  const [follow, setFollow] = useState(false);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const hasList = /(^|[\s,;])(contact:|project:)/.test(to);
  const save = async () => {
    const c = addCall({ agent: name, kind, via, to, cap, max, day, currency, follow, days });
    if ("problem" in c) { setProblem(c.problem); return; }
    setBusy(true); setProblem("");
    try { await agent.addStanding(c.input); showToast(`${name} may act by itself now.`); onDone(); } catch (e) { setProblem(say(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title={`Let ${name} act by itself`}>
      <View className="gap-s3 p-s4">
        <Segmented options={[["send", "Send"], ["post", "Post"], ["spend", "Pay"]]} value={kind} onChange={setKind} label="What it may do" />
        <Select label="Through" value={via} options={[["", "Any connection"], ...conns.map((c): [string, string] => [c.via, c.label])]} onChange={setVia} />
        <Field label="To" value={to} onChangeText={setTo} placeholder="dana@harlowlegal.com, *@harlowlegal.com" help="Addresses, *@domain, or a list: contact:<id>, project:<id>:clients." />
        {kind === "spend" ? (
          <>
            <Field label="Most for one payment" kind="number" value={max} onChangeText={setMax} />
            <Field label="Most for a day" kind="number" value={day} onChangeText={setDay} />
            <Field label="Currency" value={currency} onChangeText={setCurrency} />
          </>
        ) : <Field label="Most a day" kind="number" value={cap} onChangeText={setCap} />}
        <Field label="Lasts for (days)" kind="number" value={days} onChangeText={setDays} help="Leave empty for no end." />
        {hasList ? <><Switch on={follow} onChange={setFollow} label="Follow the lists as they change" />{follow ? <Banner tone="warn">{FOLLOW_WARNING}</Banner> : <Text size="caption" tone="label">It covers the addresses the lists hold today.</Text>}</> : null}
        {problem ? <Banner tone="err">{problem}</Banner> : null}
        <Button label="Allow" onPress={save} disabled={busy} />
      </View>
    </Sheet>
  );
}
