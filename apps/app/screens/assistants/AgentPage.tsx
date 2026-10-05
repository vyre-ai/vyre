// One assistant or agent: its job, a line to talk to it, what wakes it, what it has used, its model and its computer (the Deck's /agents/:name, ported).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Segmented, Select, Switch, Text, markRef, showToast } from "@vyre/ui";
import { Page, Sec } from "../places/Frame";
import { agent } from "./agent";
import { EFFORT, NO_WATCHER, computerView, modelsFor, usageView, watcherLine, type AgentFull, type Computer, type UsageFull, type Watcher } from "./agent-model.ts";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);

export default function AgentPage() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const who = String(name || "");
  const [a, setA] = useState<AgentFull | null | undefined>(undefined);
  const [err, setErr] = useState("");
  const load = useCallback(() => { setErr(""); agent.get(who).then(setA).catch((e) => setErr(say(e, "Your assistants did not answer."))); }, [who]);
  useEffect(load, [load]);
  return (
    <Page title={who} back="/u/settings/assistants" marks={[markRef(a?.kind === "assistant" ? "assistant" : "teammate", who)]}>
      {err ? <Card flush><ErrorState title="This page did not load" reason={err} retry={load} /></Card> : null}
      {a === undefined && !err ? <LoadingState rows={4} /> : null}
      {a === null ? <Card><EmptyState title={`There is no assistant called ${who}`} body="It may have been removed." /></Card> : null}
      {a ? (
        <>
          <Header a={a} />
          <Job a={a} onSaved={(instructions) => setA({ ...a, instructions })} />
          <Talk name={a.name} />
          <Wakes name={a.name} />
          <Usage name={a.name} />
          <Model a={a} onSaved={(m, e) => setA({ ...a, model: m, effort: e })} />
          <ComputerCard a={a} onChange={load} />
        </>
      ) : null}
    </Page>
  );
}

function Header({ a }: { a: AgentFull }) {
  return (
    <View className="flex-row items-center gap-s3">
      <Avatar of={markRef(a.kind === "assistant" ? "assistant" : "teammate", a.name)} size={56} />
      <View className="min-w-0 flex-1 gap-s1">
        <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{a.name}</Text>{a.kind === "assistant" ? <Chip>Assistant</Chip> : null}</View>
        <Text size="caption" tone="label">{a.status === "working" ? "Working now." : a.status === "stopped" ? "Paused." : "Idle. Nothing is running."}</Text>
      </View>
    </View>
  );
}

function Job({ a, onSaved }: { a: AgentFull; onSaved: (v: string) => void }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(a.instructions || "");
  const [busy, setBusy] = useState(false);
  const save = () => { setBusy(true); agent.setJob(a.name, text).then(() => { onSaved(text.trim()); setEdit(false); showToast("Saved. It applies from the next turn."); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  const where = a.projects === "*" ? "Every project" : Array.isArray(a.projects) && a.projects.length ? a.projects.join(", ") : "No projects yet";
  return (
    <Sec title="Job">
      <Card className="gap-s2">
        {edit ? (
          <>
            <Field name={`${a.name}'s job`} value={text} onChangeText={setText} multiline lines={4} />
            <View className="flex-row gap-s2"><Button size="sm" label="Save" disabled={busy} onPress={save} /><Button size="sm" kind="ghost" label="Cancel" onPress={() => { setText(a.instructions || ""); setEdit(false); }} /></View>
          </>
        ) : (
          <>
            <Text tone={a.instructions ? "default" : "muted"}>{a.instructions || "No instructions yet."}</Text>
            <Text size="caption" tone="label">{`Works in: ${where}`}</Text>
            <View className="flex-row"><Button size="sm" kind="ghost" label={a.instructions ? "Edit" : "Write its job"} onPress={() => setEdit(true)} /></View>
          </>
        )}
      </Card>
    </Sec>
  );
}

function Talk({ name }: { name: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState<{ thread?: string; project?: string } | null>(null);
  const send = () => {
    if (!text.trim()) return;
    setBusy(true);
    agent.talk(name, text).then((r) => { setText(""); setThread(r || {}); showToast(`Sent to ${name}.`); }).catch((e) => showToast(`Not sent. ${say(e)}`)).finally(() => setBusy(false));
  };
  return (
    <Sec title={`Talk to ${name}`}>
      <Card className="gap-s2">
        <Field name={`Talk to ${name}`} value={text} onChangeText={setText} placeholder={`Ask ${name} something, or give it a task`} />
        <View className="flex-row gap-s2">
          <Button size="sm" label="Send" disabled={busy || !text.trim()} onPress={send} />
          {thread?.thread ? <Button size="sm" kind="ghost" label="Open the chat" onPress={() => router.push(`/u/chats/${encodeURIComponent(thread.thread!)}` as never)} /> : null}
        </View>
      </Card>
    </Sec>
  );
}

function Wakes({ name }: { name: string }) {
  const [list, setList] = useState<Watcher[] | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => { setErr(""); agent.wakes(name).then(setList).catch((e) => setErr(say(e))); }, [name]);
  useEffect(load, [load]);
  const flip = (w: Watcher, on: boolean) => agent.wake(w.name, on).then(() => setList((l) => (l || []).map((x) => (x.name === w.name ? { ...x, paused: !on } : x)))).catch((e) => showToast(say(e)));
  return (
    <Sec title={`What wakes ${name}`}>
      {err ? <Card><Text tone="muted">{`${name} wakes only when you talk to it. ${err}`}</Text></Card> : null}
      {list && !list.length ? <Card><Text tone="muted">{NO_WATCHER(name)}</Text></Card> : null}
      {list && list.length ? (
        <Card flush>
          {list.map((w, i) => {
            const l = watcherLine(w);
            return <View key={w.name}>{i ? <Divider /> : null}<Row title={l.title} sub={l.sub} end={<Switch label={l.title} on={!w.paused} onChange={(on) => flip(w, on)} />} /></View>;
          })}
        </Card>
      ) : null}
    </Sec>
  );
}

function Usage({ name }: { name: string }) {
  const [u, setU] = useState<UsageFull | undefined | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { agent.usage(name).then(setU).catch((e) => setErr(say(e))); }, [name]);
  const v = u === null ? null : usageView(u, name);
  return (
    <Sec title="Usage">
      <Card className="gap-s1">
        {err ? <Text tone="muted">{`${name}'s usage could not be read. ${err}`}</Text> : null}
        {v && "empty" in v ? <Text tone="muted">{v.empty}</Text> : null}
        {v && "top" in v ? <><Text strong>{v.top}</Text>{v.sub ? <Text size="caption" tone="label">{v.sub}</Text> : null}{v.warn ? <Text size="caption" tone="warn">{v.warn}</Text> : null}</> : null}
      </Card>
    </Sec>
  );
}

function Model({ a, onSaved }: { a: AgentFull; onSaved: (m: string, e: string) => void }) {
  const [aliases, setAliases] = useState<unknown>(undefined);
  useEffect(() => { void agent.models().then(setAliases).catch(() => {}); }, []);
  const rows = modelsFor(a.model, aliases);
  const [model, setModel] = useState(a.model || "");
  const [effort, setEffort] = useState(a.effort || "medium");
  const save = (m: string, e: string) => agent.setModel(a.name, m, e).then(() => { onSaved(m, e); showToast("Saved."); }).catch((x) => showToast(say(x)));
  return (
    <Sec title="Model">
      <Card className="gap-s3">
        <Select label={`${a.name}'s model`} value={model || rows[0]?.id || ""} options={rows.map((m) => [m.id, m.name])} onChange={(m) => { setModel(m); void save(m, effort); }} />
        <Segmented label="Effort" value={effort} options={EFFORT as [string, string][]} onChange={(e) => { setEffort(e); void save(model, e); }} />
        <Text size="caption" tone="label">{`${a.name} answers every question. Memory gives ${a.name} the relevant facts, with where they came from, as context. It never answers instead.`}</Text>
      </Card>
    </Sec>
  );
}

function ComputerCard({ a, onChange }: { a: AgentFull; onChange: () => void }) {
  const [c, setC] = useState<Computer | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [cores, setCores] = useState("");
  const [mem, setMem] = useState("");
  const [name, setName] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => { setErr(""); if (a.computer) agent.computer(a.name).then((x) => { setC(x); setCores(String(x.cpus ?? 2)); setMem(String(Math.round(x.memory_gb ?? 3))); setName(x.label || ""); }).catch((e) => setErr(say(e))); }, [a.name, a.computer]);
  useEffect(load, [load]);
  const run = (fn: () => Promise<unknown>, done: string) => { setBusy(true); setProblem(""); fn().then(() => { showToast(done); load(); onChange(); }).catch((e) => setProblem(say(e))).finally(() => { setBusy(false); setArmed(false); }); };
  if (!a.computer) {
    return (
      <Sec title="Computer">
        <Card className="gap-s2">
          <Text>{`${a.name} has no computer of its own. It works through its threads, in the projects' folders.`}</Text>
          <Text size="caption" tone="label">With one, it gets a desktop from the pool that you can watch, or take over.</Text>
          {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
          <View className="flex-row"><Button size="sm" label={`Give ${a.name} a computer`} disabled={busy} onPress={() => run(() => agent.giveComputer(a.name), "It has a computer now.")} /></View>
        </Card>
      </Sec>
    );
  }
  if (err || !c) return <Sec title="Computer">{err ? <Card><Text tone="muted">{`${a.name} has a computer, but it cannot be shown. ${err}`}</Text></Card> : <LoadingState rows={2} />}</Sec>;
  const v = computerView(c, a.name);
  return (
    <Sec title="Computer">
      <Card flush>
        <View className="gap-s1 p-s3"><Text strong>{v.live}</Text></View>
        {v.specs.map(([k, val]) => <View key={k}><Divider /><Row title={k} end={<Text tone="muted">{val}</Text>} /></View>)}
      </Card>
      <Card className="gap-s2">
        {open ? (
          <>
            <View className="flex-row gap-s2"><View className="flex-1"><Field label="Cores" kind="number" value={cores} onChangeText={setCores} /></View><View className="flex-1"><Field label="Memory GB" kind="number" value={mem} onChangeText={setMem} /></View></View>
            <Field label="Name" value={name} onChangeText={setName} placeholder={`${a.name}'s computer`} help="Leave it empty for the default name." />
            {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
            <View className="flex-row flex-wrap gap-s2">
              <Button size="sm" label="Save limits" disabled={busy} onPress={() => run(() => agent.setLimits(a.name, cores, mem), "Saved. Restart the computer to apply them.")} />
              <Button size="sm" kind="secondary" label="Save name" disabled={busy} onPress={() => run(() => agent.rename(a.name, name), "Renamed.")} />
              <Button size="sm" kind="ghost" label="Close" onPress={() => setOpen(false)} />
            </View>
          </>
        ) : <View className="flex-row"><Button size="sm" kind="secondary" label="Change limits and name" onPress={() => setOpen(true)} /></View>}
        {armed ? <Banner>{`This closes what is open on ${a.name}'s screen. Its files and signed-in sites stay.`}</Banner> : null}
        {!open && problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
        <View className="flex-row"><Button size="sm" kind="ghost" label={armed ? "Restart now" : "Restart computer"} disabled={busy} onPress={() => (armed ? run(() => agent.restart(a.name), "Restarting.") : setArmed(true))} /></View>
      </Card>
    </Sec>
  );
}
