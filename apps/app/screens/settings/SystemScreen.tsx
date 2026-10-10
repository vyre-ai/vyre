// This computer: what runs here, history search, and the advanced network cards (the Deck's settings.js machine, history, webhooks, guests, agent nodes, egress, hand-back, lock and drive sections, ported).
import { RC } from "../shell/rc";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, ErrorState, Field, LoadingState, Row, Segmented, Select, Sheet, Text, showToast } from "@vyre/ui";
import { Page, Sec } from "../places/Frame";
import { system } from "./system";
import { RunHere } from "../runner/RunHere";
import { winkCard, accessWord, auditLines, egressCard, flipAccess, handbackLabel, handbackOf, hooksCard, hostedLine, machineRows, nameOf, recallView, sharesOf, type Card as StatusCard } from "./system-model.ts";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);

export function SystemScreen() {
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => { setErr(""); system.info().then(setInfo).catch((e) => setErr(say(e, "Your computer did not say what it runs on."))); }, []);
  useEffect(load, [load]);
  return (
    <Page title="This computer" back="/u/settings">
      {err ? <Card flush><ErrorState title="This did not load" reason={err} retry={load} /></Card> : null}
      {!info && !err ? <LoadingState rows={4} /> : null}
      {info ? <Machine info={info} onRenamed={load} /> : null}
      <RunHere />
      <History />
      <Tests />
      <Banner>The cards below are for people who run their own home computer. A command is shown to copy and run yourself. Vyre never runs one for you.</Banner>
      <Advanced />
      <Drive />
    </Page>
  );
}

function Machine({ info, onRenamed }: { info: any; onRenamed: () => void }) {
  const name = nameOf(info);
  const hosted = hostedLine(info);
  const [typed, setTyped] = useState(name || "");
  const [busy, setBusy] = useState(false);
  const save = () => { setBusy(true); system.rename(typed).then(() => { showToast("Renamed."); onRenamed(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  return (
    <Sec title="This computer">
      <Card flush>
        {machineRows(info).map(([k, v], i) => <View key={k}>{i ? <Divider /> : null}<Row title={k} end={<Text tone="muted">{v}</Text>} /></View>)}
        {hosted ? <View><Divider /><Row title="Hosted app" sub={hosted} /></View> : null}
      </Card>
      {name !== null ? (
        <Card className="gap-s2">
          <Field label="Name" value={typed} onChangeText={setTyped} help="Leave it empty for the default name." />
          <View className="flex-row"><Button size="sm" label="Save name" disabled={busy || typed.trim() === name} onPress={save} /></View>
        </Card>
      ) : null}
    </Sec>
  );
}

function History() {
  const [s, setS] = useState<any>(undefined);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { system.recall().then(setS); }, []);
  useEffect(load, [load]);
  if (!s) return s === null ? <Sec title="History"><Card><Text tone="muted">History search is not available.</Text></Card></Sec> : null;
  const v = recallView(s);
  const run = () => { setBusy(true); system.reindex().then(() => { showToast("Indexed."); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  return (
    <Sec title="History">
      <Card flush>
        {v.lines.map(([k, val], i) => <View key={k}>{i ? <Divider /> : null}<Row title={k} sub={val} /></View>)}
        {v.problem ? <View className="p-s3"><Text size="caption" tone="warn">{v.problem}</Text></View> : null}
      </Card>
      <View className="flex-row"><Button size="sm" label={v.indexing || busy ? "Indexing" : "Re-index now"} disabled={v.indexing || busy} onPress={run} /></View>
      <Text size="caption" tone="label">Reads new and changed chats now.</Text>
    </Sec>
  );
}

function Tests() {
  const [busy, setBusy] = useState(false);
  return (
    <Sec title="Notifications">
      <Card className="gap-s2">
        <Text tone="muted">Send a test notification to every device you have paired. It ignores quiet hours.</Text>
        <View className="flex-row"><Button size="sm" kind="secondary" label="Send a test" disabled={busy} onPress={() => { setBusy(true); system.testPush().then(() => showToast("Sent.")).catch((e) => showToast(say(e))).finally(() => setBusy(false)); }} /></View>
      </Card>
    </Sec>
  );
}

const SCHEMES: [string, string][] = [["hmac-sha256", "Signed body"], ["github", "GitHub"], ["stripe", "Stripe"]];

/** One open route: a name, how the sender signs, and the Vault item that holds the shared secret (a name, never a value). */
function RouteSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [scheme, setScheme] = useState("hmac-sha256");
  const [header, setHeader] = useState("");
  const [secret, setSecret] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(""); setScheme("hmac-sha256"); setHeader(""); setSecret(""); setProblem(""); } }, [open]);
  const go = () => {
    if (!name.trim() || !secret.trim()) { setProblem("Give the route a name and the Vault item that holds its secret."); return; }
    if (scheme === "hmac-sha256" && !header.trim()) { setProblem("Name the header the sender puts its signature in."); return; }
    setBusy(true); setProblem("");
    system.hooksOpen(name.trim(), scheme, header, secret.trim()).then(() => { showToast(`/hooks/${name.trim()} is open.`); onDone(); onClose(); }).catch((e) => setProblem(say(e))).finally(() => setBusy(false));
  };
  return (
    <Sheet open={open} onClose={onClose} title="Open a route">
      <View className="gap-s3">
        <Field label="Name" value={name} onChangeText={setName} placeholder="northwind-orders" help="Lowercase words joined by dashes. The sender posts to /hooks/ and this name." />
        <Segmented label="Signed by" value={scheme} onChange={setScheme} options={SCHEMES} />
        {scheme === "hmac-sha256" ? <Field label="Signature header" value={header} onChangeText={setHeader} placeholder="x-signature" /> : null}
        <Field label="Secret, in the Vault" value={secret} onChangeText={setSecret} placeholder="northwind-orders-hook" help="The name of the Vault item that holds the shared secret." />
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <Button kind="primary" label={busy ? "Opening" : "Open the route"} disabled={busy} onPress={go} />
      </View>
    </Sheet>
  );
}

function StatusCardView({ c, reload }: { c: StatusCard; reload: () => void }) {
  const [routing, setRouting] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = (a: StatusCard["actions"][number]) => {
    if (a.id === "hooks-open") { setRouting(true); return; }
    setBusy(true);
    (a.id === "hooks-on" ? system.hooksEnable(true) : a.id === "hooks-off" ? system.hooksEnable(false) : system.hooksClose(a.arg ?? "")).then(() => reload()).catch((e) => showToast(say(e))).finally(() => setBusy(false));
  };
  return (
    <Card className="gap-s1">
      <View className="flex-row items-center gap-s2"><Text strong>{c.title}</Text>{c.state ? <Text tone="muted">{c.state}</Text> : null}</View>
      {c.lines.map((l, i) => <Text key={i} size="secondary" tone="muted">{l}</Text>)}
      {c.warn.map((l, i) => <Text key={i} size="secondary" tone="warn">{l}</Text>)}
      {c.actions.length ? <View className="flex-row flex-wrap gap-s2 pt-s1">{c.actions.map((a, i) => <Button key={`${a.id}${a.arg ?? ""}${i}`} size="sm" kind={a.id === "hooks-on" ? "primary" : "ghost"} label={a.label} disabled={busy} onPress={() => act(a)} />)}</View> : null}
      <RouteSheet open={routing} onClose={() => setRouting(false)} onDone={reload} />
    </Card>
  );
}

function Advanced() {
  const [cards, setCards] = useState<StatusCard[] | null>(null);
  const [hb, setHb] = useState<ReturnType<typeof handbackOf> | null>(null);
  const load = useCallback(() => {
    Promise.all([system.hooks(), system.hooksStatus(), system.wink(), system.egress(), system.handback()]).then(([h, hs, w, e, b]) => {
      // A tool this box does not have leaves its card out.
      setCards([h && hooksCard(h, hs), w && winkCard(w), RC.glass && e && egressCard(e)].filter(Boolean) as StatusCard[]);
      setHb(b ? handbackOf(b) : null);
    });
  }, []);
  useEffect(load, [load]);
  const [said, setSaid] = useState("");
  if (!cards) return null;
  const setMinutes = (m: number) => system.setHandback(m).then((r) => { setHb(handbackOf(r)); setSaid("Saved. It applies to a take-over already running too."); }).catch((e) => setSaid(say(e)));
  return (
    <Sec title="Advanced">
      {cards.map((c) => <StatusCardView key={c.title} c={c} reload={load} />)}
      {hb && RC.glass ? (
        <Card className="gap-s2">
          <Text strong>Glass hand-back</Text>
          <Text size="secondary" tone="muted">{`When you take over an agent's computer and stop typing and moving, the keyboard goes back to the agent. You get a ${hb.warn} s warning first.`}</Text>
          <Select label="Hand back after this long without input" value={String(hb.minutes)} options={hb.choices.map((m) => [String(m), handbackLabel(m)])} onChange={(v) => void setMinutes(Number(v))} />
          {said ? <Text size="caption" tone="label">{said}</Text> : null}
        </Card>
      ) : null}
    </Sec>
  );
}

function Drive() {
  const [d, setD] = useState<ReturnType<typeof sharesOf> | null>(null);
  const [audit, setAudit] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [canSwitch, setCanSwitch] = useState(true);
  useEffect(() => { system.drive().then((x) => setD(x ? sharesOf(x) : null)); }, []);
  if (!d) return null;
  const flip = (name: string, access?: string) => {
    setBusy(true); setProblem("");
    system.setAccess(name, flipAccess(access)).then((r) => setD({ ...d, shares: d.shares.map((s) => (s.name === name ? { ...s, access: r?.access === "rw" || r?.access === "ro" ? r.access : flipAccess(access) } : s)) }))
      .catch((e) => { if ((e as { code?: string }).code === "no_such_tool") setCanSwitch(false); else setProblem(say(e)); }).finally(() => setBusy(false));
  };
  const check = () => { setBusy(true); setProblem(""); system.audit().then((a) => setAudit(auditLines(a))).catch((e) => setProblem(say(e))).finally(() => setBusy(false)); };
  return (
    <Sec title="VyreDrive">
      <Card flush>
        <View className="gap-s1 p-s3"><Text strong>{d.enabled ? "On" : "Off"}</Text><Text size="caption" tone="label">VyreDrive opens your home's folders in Finder on your Mac.</Text>{d.why ? <Text size="caption" tone="warn">{`Not available: ${d.why}`}</Text> : null}</View>
        {d.enabled && !d.shares.length ? <View className="p-s3"><Text tone="muted">Your home offers no folders yet.</Text></View> : null}
        {d.shares.map((s) => (
          <View key={s.name}><Divider />
            <Row title={s.name} sub={`${s.shared ? "Shared" : "Not shared"}, ${accessWord(s.access).toLowerCase()}${s.mounted ? ", mounted on this Mac" : ""}`}
              end={canSwitch && s.shared ? <Button size="sm" kind="secondary" disabled={busy} label={s.access === "rw" ? "Make read only" : "Make read and write"} onPress={() => flip(s.name, s.access)} /> : undefined} />
          </View>
        ))}
      </Card>
      {d.enabled ? <View className="flex-row"><Button size="sm" kind="secondary" label="Check who can reach them" disabled={busy} onPress={check} /></View> : null}
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
      {audit ? <Card className="gap-s1">{audit.lines.map((l, i) => <Text key={i} size="secondary" tone={audit.ok ? "muted" : "warn"}>{l}</Text>)}</Card> : null}
    </Sec>
  );
}
