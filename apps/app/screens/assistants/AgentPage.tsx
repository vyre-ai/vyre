// One assistant or agent: its job, a line to talk to it, what it has used, its model and its computer (the Deck's /agents/:name, ported).
import { RC } from "../shell/rc";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AgentLookPicker, Avatar, Banner, Sheet, lookOf, lookSeed, PARTS, partsOf, withParts, rememberLook, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Segmented, Select, Tabs, Text, markRef, showToast } from "@vyre/ui";
import AgentWork from "./AgentWork";
import { displayName } from "../agents/home-model.js";
import { Context, Instructions, Models, Sharing, Used } from "./AgentParts";
import { AgentMemory } from "./AgentMemory";
import { Page, Sec } from "../places/Frame";
import { agent } from "./agent";
import { useChats } from "../../src/state/chats";
import { assistantChatRoute, startChat } from "../../src/state/start-chat";
import { chatHas } from "../agents/home-model.js";
import { EFFORT, accountModelsFor, computerView, modelsFor, usageView, type AgentFull, type Computer, type UsageFull } from "./agent-model.ts";
import { AgentThreads } from "./AgentThreads";
import { RealSkills } from "../skills/RealSkills";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);

type Tab = "threads" | "overview" | "skills" | "ai" | "computer";
const TABS: [Tab, string][] = [["threads", "Threads"], ["overview", "Overview"], ["skills", "Skills & plugins"], ["ai", "AI"], ["computer", "Computer"]];

export default function AgentPage() {
  const { name, tab: want } = useLocalSearchParams<{ name: string; tab?: string }>();
  const who = String(name || "");
  const [a, setA] = useState<AgentFull | null | undefined>(undefined);
  const [err, setErr] = useState("");
  const [looking, setLooking] = useState(false);
  const [tab, setTab] = useState<Tab>(TABS.some(([k]) => k === want) ? (want as Tab) : "threads");
  const load = useCallback(() => { setErr(""); agent.get(who).then(setA).catch((e) => setErr(say(e, "Your agents did not answer."))); }, [who]);
  useEffect(load, [load]);
  return (
    <Page title={a ? displayName(a) : who} back="/u/assistants" marks={[markRef("agent", who)]}>
      {err ? <Card flush><ErrorState title="This page did not load" reason={err} retry={load} /></Card> : null}
      {a === undefined && !err ? <LoadingState rows={4} /> : null}
      {a === null ? <Card><EmptyState title={`There is no agent called ${who}`} body="It may have been removed." /></Card> : null}
      {a ? (
        <>
          <Header a={a} onLook={() => setLooking(true)} />
          <LookSheet a={a} open={looking} onClose={() => setLooking(false)} onSaved={(look) => { setA({ ...a, look }); setLooking(false); }} />
          <Chats a={a} />
          <Tabs items={TABS} value={tab} onChange={setTab} />
          {tab === "threads" ? <AgentThreads name={a.name} /> : null}
          {tab === "overview" ? <><Instructions name={a.name} /><Context name={a.name} /><AgentMemory name={a.name} /><Used name={a.name} /><Sharing name={a.name} /></> : null}
          {tab === "skills" ? <RealSkills initialLevel="agent" scope={a.name} /> : null}
          {tab === "ai" ? <><Models name={a.name} /><Model a={a} onSaved={(m, e) => setA({ ...a, model: m, effort: e })} /></> : null}
          {tab === "computer" ? <><ComputerCard a={a} onChange={load} /><Talk name={a.name} /><AgentWork name={a.name} /><Usage name={a.name} /></> : null}
        </>
      ) : null}
    </Page>
  );
}

function Header({ a, onLook }: { a: AgentFull; onLook: () => void }) {
  // The page title above is the name; this line is the face and the state, once. An agent's face is its look; the face opens the picker.
  const look = a.kind !== "assistant" && a.look ? a.look : undefined;
  return (
    <View className="flex-row items-center gap-s3">
      <Avatar of={markRef("agent", a.name, undefined, look)} size={40} onPress={a.kind === "assistant" ? undefined : onLook} label={a.kind === "assistant" ? undefined : "Change how it looks"} />
      <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-s2">
        <Text size="caption" tone="label">{a.status === "working" ? "Working now." : a.status === "stopped" ? "Paused." : "Idle. Nothing is running."}</Text>
        {a.kind === "assistant" ? <Chip>Your assistant</Chip> : null}
      </View>
    </View>
  );
}

/** New chat with this agent, and the chats it is already in (each opens in Chat). The assistant has the one pinned chat and no new ones. */
function Chats({ a }: { a: AgentFull }) {
  const router = useRouter();
  const chats = useChats();
  const [busy, setBusy] = useState(false);
  const go = (r: string) => router.push(r as never);
  const isAsst = a.kind === "assistant";
  const mine = chats.rows.filter((c) => chatHas(c, a.name));
  const talk = () => { setBusy(true); (isAsst ? assistantChatRoute() : startChat({ people: [], agents: [a.name] }).then((x) => { if ("chat" in x) return `/u/chats/${encodeURIComponent(x.chat)}`; showToast(x.say); return ""; })).then((r) => { if (r) go(r); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  return (
    <Sec title="Chats">
      <Card flush>
        <Row title={isAsst ? "Open your assistant chat" : `New chat with ${a.name}`} sub={isAsst ? "One chat, always at the top of Chat." : undefined} onPress={busy ? undefined : talk} />
        {mine.map((c) => <View key={c.id}><Divider /><Row title={c.title || "Chat"} sub={c.line || undefined} onPress={() => go(`/u/chats/${encodeURIComponent(c.id)}`)} /></View>)}
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
  // the models the person's own AI accounts offer (the listing the new agent card reads); the box's alias list only when the accounts cannot be read
  const [rows, setRows] = useState<{ id: string; name: string }[]>(() => modelsFor(a.model, undefined));
  useEffect(() => {
    let live = true;
    agent.accountModels().then((g) => { if (live) setRows(accountModelsFor(a.model, g)); })
      .catch(() => agent.models().then((al) => { if (live) setRows(modelsFor(a.model, al)); }).catch(() => {}));
    return () => { live = false; };
  }, [a.model]);
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
  // An agent's own desktop to watch or take over is Screen Share (0.3.1): hidden for 0.2.9.
  if (!RC.glass) return null;
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

/** Change how an agent is drawn: the grid of shapes and the colours (and, behind the Customize button, eyes, mouth, top, blush and charm), then Save (agents.update look). Also used by Settings for the Assistant. */
export function LookSheet({ a, open, onClose, onSaved, person, onSave }: { a: AgentFull; open: boolean; onClose: () => void; onSaved: (look: string) => void; /** The sheet is for a person's own look, not an agent's: titled "Your look" and drawn as a person. */ person?: boolean; /** How a look is kept when it is not agents.update (a person's own look). */ onSave?: (look: string) => Promise<unknown> }) {
  const start = lookOf(a.look ?? "") ?? { shape: 0, color: 0 };
  // the character: the parts its look names, and for the rest what it is drawn with now (a hash of its name), so a tap changes one thing and keeps the others
  const [v, setV] = useState({ ...start, parts: partsOf(withParts(a.look || a.name, a.name.toLowerCase())) as Record<string, number> });
  const look = lookSeed(v.shape, v.color) + PARTS.map((p) => `~${p.key}${v.parts[p.key] ?? 0}`).join("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const save = () => { setBusy(true); setProblem(""); (onSave ? onSave(look) : agent.setLook(a.name, look)).then(() => onSaved(look)).catch((e) => setProblem(say(e))).finally(() => setBusy(false)); };
  return (
    <Sheet open={open} onClose={onClose} title={person ? "Your look" : `How ${a.name} looks`}>
      <View className="gap-s4">
        <View className="items-center"><Avatar of={markRef(person ? "person" : "agent", a.name, undefined, look)} size={56} face /></View>
        <AgentLookPicker shape={v.shape} color={v.color} parts={v.parts} onChange={(p) => setV((x) => ({ ...x, ...p }))} onPart={(key, value) => setV((x) => ({ ...x, parts: { ...x.parts, [key]: value } }))} />
        {problem ? <Banner tone="warn">{problem}</Banner> : null}
        <View className="flex-row justify-end gap-s2"><Button kind="ghost" label="Cancel" onPress={onClose} /><Button kind="primary" label={busy ? "Saving" : "Save"} disabled={busy} onPress={save} /></View>
      </View>
    </Sheet>
  );
}
