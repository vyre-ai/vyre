// Outside agents: Dots, Muse, Hermes, ChatGPT or your own Claude Code on another machine. Connect one (its token is shown once), give it records to read, and end it with one tap. Nothing it asks to change
// happens until you say yes on the card that appears in Now.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Switch, Text, showToast } from "@vyre/ui";
import { Page, Sec } from "../places/Frame";
import { endsLine, givesLine, recordsGrant, usedLine, type Agent, type RecordType, type Registered } from "./outside-model";
import { outside } from "./outside";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);
const copy = (text: string) => { Clipboard.setStringAsync(text).catch(() => {}); showToast("Copied"); };

export default function OutsideScreen() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [err, setErr] = useState("");
  const [problem, setProblem] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [shown, setShown] = useState<Registered | null>(null);
  const [giving, setGiving] = useState("");
  const [types, setTypes] = useState<RecordType[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [write, setWrite] = useState(false);
  const [ending, setEnding] = useState("");
  const load = useCallback(() => { setErr(""); outside.list().then(setAgents).catch((e) => { setAgents([]); setErr(say(e, "Your outside agents could not be read.")); }); }, []);
  useEffect(load, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setProblem("");
    try { await fn(); load(); } catch (e) { setProblem(say(e)); } finally { setBusy(""); }
  };
  const connect = () => act("new", async () => { const r = await outside.register(name.trim(), note.trim()); setShown(r); setName(""); setNote(""); });
  const startGiving = (id: string) => {
    setGiving(id); setPicked([]); setWrite(false); setProblem("");
    outside.types().then(setTypes).catch((e) => setProblem(say(e, "The record types could not be read.")));
  };
  const give = (id: string) => {
    const what = recordsGrant(picked, write);
    if (!what) { setProblem("Pick at least one kind of record."); return; }
    void act(id, async () => { await outside.grant(id, what); setGiving(""); });
  };
  const now = Date.now();
  return (
    <Page title="Outside agents" back="/u/settings">
      <Banner>An outside agent is one that is not a Vyre chat: Dots, Muse, Hermes, ChatGPT, your own Claude Code elsewhere. It reaches only what you give it, asks before it changes anything, and stops the moment you end it.</Banner>
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
      {shown ? (
        <Card className="gap-s3">
          <Text strong>{`${shown.name} is connected`}</Text>
          <Text size="caption" tone="label">Paste one of these lines into the agent's own settings. The token is shown only now; if you lose it, make a new one.</Text>
          <Text mono selectable>{shown.lines.claude}</Text>
          <View className="flex-row flex-wrap gap-s2"><Button size="sm" label="Copy the Claude Code line" onPress={() => copy(shown.lines.claude)} /><Button size="sm" kind="ghost" label="Copy the Codex line" onPress={() => copy(shown.lines.codex)} /><Button size="sm" kind="ghost" label="Copy the token" onPress={() => copy(shown.token)} /></View>
          <Text size="caption" tone="muted">It can reach nothing yet. Give it something below.</Text>
          <View className="self-start"><Button kind="ghost" size="sm" label="Done" onPress={() => setShown(null)} /></View>
        </Card>
      ) : null}
      <Sec title="Your outside agents">
        <Card flush>
          {agents === null ? <LoadingState rows={2} /> : null}
          {err ? <ErrorState title="Outside agents did not load" reason={err} retry={load} /> : null}
          {agents && !err && !agents.length ? <EmptyState title="No outside agents yet" body="Connect one below. It reaches nothing until you give it something." /> : null}
          {(agents || []).map((a, i) => (
            <View key={a.id}>
              {i ? <Divider /> : null}
              <View className="gap-s2 p-s3">
                <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{a.name}</Text><Chip>{a.status === "active" ? "Active" : a.status === "expired" ? "Expired" : "Ended"}</Chip></View>
                {a.note ? <Text size="caption" tone="muted">{a.note}</Text> : null}
                <Text size="caption" tone="label">{a.reach ? `It ${a.reach}.` : "It can reach nothing yet."}</Text>
                <Text size="caption" tone="muted">{`${endsLine(a, now)}. ${usedLine(a, now)}.`}</Text>
                {a.gives.map((g) => (
                  <Row key={g.id} dense title={givesLine(g)} end={a.status === "revoked" ? undefined : <Button size="sm" kind="ghost" label="Take back" disabled={busy === a.id} onPress={() => void act(a.id, () => outside.ungrant(a.id, g.id))} />} />
                ))}
                {a.status === "revoked" ? null : giving === a.id ? (
                  <View className="gap-s2">
                    <Text size="caption" tone="label">Which records may it read?</Text>
                    {types.map((t) => <Row key={t.name} dense title={t.label} end={<Switch label={t.label} on={picked.includes(t.name)} onChange={(on) => setPicked(on ? [...picked, t.name] : picked.filter((x) => x !== t.name))} />} />)}
                    <Row dense title="It may ask to add or change them" sub="Each change still waits for your yes." end={<Switch label="It may ask to add or change them" on={write} onChange={setWrite} />} />
                    <View className="flex-row flex-wrap gap-s2"><Button size="sm" label="Give access" disabled={busy === a.id} onPress={() => give(a.id)} /><Button size="sm" kind="ghost" label="Cancel" onPress={() => setGiving("")} /></View>
                  </View>
                ) : ending === a.id ? (
                  <View className="gap-s2">
                    <Text size="caption">{`End ${a.name}? Its token stops working now and everything it was given is taken back.`}</Text>
                    <View className="flex-row flex-wrap gap-s2"><Button size="sm" label="End it" disabled={busy === a.id} onPress={() => void act(a.id, async () => { await outside.revoke(a.id); setEnding(""); })} /><Button size="sm" kind="ghost" label="Keep it" onPress={() => setEnding("")} /></View>
                  </View>
                ) : (
                  <View className="flex-row flex-wrap gap-s2">
                    <Button size="sm" label="Give it something to read" onPress={() => startGiving(a.id)} />
                    <Button size="sm" kind="ghost" label="New token" disabled={busy === a.id} onPress={() => void act(a.id, async () => setShown(await outside.token(a.id)))} />
                    <Button size="sm" kind="ghost" label="End it" onPress={() => setEnding(a.id)} />
                  </View>
                )}
              </View>
            </View>
          ))}
        </Card>
      </Sec>
      <Sec title="Connect an agent">
        <Card className="gap-s2">
          <Field name="Its name" value={name} onChangeText={setName} placeholder="Muse" />
          <Field name="What it is for (optional)" value={note} onChangeText={setNote} placeholder="Writes our newsletter" />
          <View className="self-start"><Button label="Connect it" disabled={!name.trim() || busy === "new"} onPress={connect} /></View>
        </Card>
      </Sec>
    </Page>
  );
}
