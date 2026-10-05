// Planner (the Deck's views/planner.js, ported): type to add ("alarm 7am", "todo send the invoice"), see what the box read before it goes in, today's agenda, the next alarms, open todos and notes, and a banner with Done and Snooze for anything ringing.
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, ErrorState, Field, LoadingState, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { listen } from "../../src/api/box";
import { planner } from "./planner";
import { CHANGES, addInput, agendaOf, clock, kindWord, nextAlarms, nextAt, previewLine, repeatWord, ringingOf, sortNotes, splitKind, type Item, type Ringing } from "./model.ts";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);

export function PlannerScreen() {
  const [agenda, setAgenda] = useState<ReturnType<typeof agendaOf> | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState("");
  const [words, setWords] = useState("");
  const [preview, setPreview] = useState("");
  const [adding, setAdding] = useState(false);
  const [rings, setRings] = useState<Ringing[]>([]);
  const [ringErr, setRingErr] = useState("");
  const seq = useRef(0);
  const load = useCallback(() => {
    setErr("");
    planner.agenda().then(setAgenda).catch((e) => { setAgenda({ entries: [], todos: [], tz: "" }); setErr(say(e, "The planner is not available.")); });
    planner.open().then(setItems).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { planner.ringing().then(setRings).catch(() => {}); }, []);
  useEffect(() => listen((e) => {
    if (CHANGES.includes(e.type)) load();
    if (e.type === "planner.fired") { const r = ringingOf(e.payload); if (r) setRings((l) => (l.some((x) => x.firing === r.firing) ? l : [...l, r])); }
    if (e.type === "planner.acked") { const f = (e.payload as { firing?: string })?.firing; if (f) setRings((l) => l.filter((x) => x.firing !== f)); }
  }), [load]);

  // What the words mean, shown before Add: "todo" and "note" are taken as said; the rest the box reads.
  useEffect(() => {
    const { kind, text } = splitKind(words);
    const mine = ++seq.current;
    if (!text) { setPreview(""); return; }
    if (kind === "todo" || kind === "note") { setPreview(`${kindWord(kind)}: ${text}`); return; }
    const t = setTimeout(() => { planner.parse(text, kind || undefined).then((p) => { if (seq.current === mine) setPreview(previewLine(p, text)); }).catch(() => { if (seq.current === mine) setPreview(""); }); }, 250);
    return () => clearTimeout(t);
  }, [words]);

  const add = () => {
    const input = addInput(words);
    if (!input) return;
    setAdding(true);
    planner.add(input).then(() => { setWords(""); showToast("Added."); load(); }).catch((e) => showToast(say(e))).finally(() => setAdding(false));
  };
  const ack = (r: Ringing, tool: "planner.done" | "planner.snooze") => { setRingErr(""); planner.answer(tool, r.firing).then(() => setRings((l) => l.filter((x) => x.firing !== r.firing))).catch((e) => setRingErr(say(e))); };
  const finish = (t: Item) => planner.done(t.id).then(() => { load(); showToast(`Done: ${t.title}`); }).catch((e) => showToast(say(e)));
  const remove = (t: Item) => planner.remove(t.id).then(() => { load(); showToast("Deleted. It can be restored for 30 days."); }).catch((e) => showToast(say(e)));

  const open = items || [];
  const alarms = nextAlarms(open);
  const todos = open.filter((i) => i.kind === "todo" && i.state === "open");
  const notes = sortNotes(open.filter((i) => i.kind === "note"));
  const row = (key: string, left: string, what: string, tag: string, acts?: React.ReactNode) => (
    <View key={key} className="gap-s1 py-s2">
      <View className="flex-row flex-wrap items-center gap-s2">{left ? <Text mono tone="muted">{left}</Text> : null}<Text className="min-w-0 flex-1">{what}</Text>{tag ? <Chip>{tag}</Chip> : null}</View>
      {acts}
    </View>
  );
  const section = (title: string, children: React.ReactNode[], empty: string) => (
    <Card className="gap-s2">
      <Text strong>{title}</Text>
      {children.length ? children.map((c, i) => <View key={i}>{i ? <Divider /> : null}{c}</View>) : <Text tone="muted">{empty}</Text>}
    </Card>
  );
  return (
    <Page title="Planner" back="/u/now">
      <Banner>Today, what is coming, and what is open. Type to add: call Dana tomorrow 3pm.</Banner>
      {rings.map((r) => (
        <Card key={r.firing} className="gap-s2">
          <Text strong>{`${kindWord(r.kind)}: ${r.title || kindWord(r.kind)}${r.missed ? " (missed)" : ""}`}</Text>
          {ringErr ? <Text size="caption" tone="warn">{ringErr}</Text> : null}
          <View className="flex-row flex-wrap gap-s2"><Button kind="primary" size="sm" label="Done" onPress={() => ack(r, "planner.done")} /><Button size="sm" label="Snooze" onPress={() => ack(r, "planner.snooze")} /></View>
        </Card>
      ))}
      <Card className="gap-s2">
        <Field name="Add to the planner" value={words} onChangeText={setWords} placeholder="alarm 7am · remind me to call the bank at 6 · todo send the invoice · note printer code 4471" />
        {preview ? <Text size="caption" tone="muted">{preview}</Text> : null}
        <View className="self-start"><Button kind="primary" size="sm" label={adding ? "Adding" : "Add"} disabled={adding || !words.trim()} onPress={add} /></View>
      </Card>
      {err ? <Card flush><ErrorState title="The planner did not load" reason={err} retry={load} /></Card> : null}
      {agenda === null && !err ? <LoadingState rows={3} /> : null}
      {agenda && !err ? section(`Agenda${agenda.tz ? `  ${agenda.tz}` : ""}`, [
        ...agenda.entries.map((e, i) => row(`e${i}`, e.all_day ? "All day" : clock(e.at), e.title || kindWord(e.kind), e.source !== "planner" ? "Calendar" : kindWord(e.kind) + (e.snoozed ? " · snoozed" : ""))),
        ...agenda.todos.map((t, i) => row(`t${i}`, t.due ? "Due" : "", t.title, "Todo", t.id ? <View className="self-start"><Button kind="ghost" size="sm" label="Done" onPress={() => void finish(t)} /></View> : undefined)),
      ], "Nothing on today. Add something above.") : null}
      {items ? section("Alarms", alarms.map((a) => row(a.id, clock(nextAt(a) as number), a.title || kindWord(a.kind), a.snooze_until ? "Snoozed" : repeatWord(a.repeat), <View className="self-start"><Button kind="ghost" size="sm" label="Delete" onPress={() => void remove(a)} /></View>)), "No alarms set.") : null}
      {items ? section(`Todos${todos.length ? `  ${todos.length}` : ""}`, todos.map((t) => row(t.id, "", t.title, t.due || "", <View className="flex-row gap-s2"><Button kind="ghost" size="sm" label="Done" onPress={() => void finish(t)} /><Button kind="ghost" size="sm" label="Delete" onPress={() => void remove(t)} /></View>)), "No open todos. Type todo above.") : null}
      {items ? section("Notes", notes.map((n) => (
        <View key={n.id} className="gap-s1 py-s2">
          <View className="flex-row flex-wrap items-center gap-s2">{n.pinned ? <Chip>Pinned</Chip> : null}<Text strong className="min-w-0 flex-1">{n.title || "Note"}</Text></View>
          {n.body ? <Text size="caption" tone="muted">{n.body}</Text> : null}
          <View className="self-start"><Button kind="ghost" size="sm" label="Delete" onPress={() => void remove(n)} /></View>
        </View>
      )), "No notes. Type note above.") : null}
    </Page>
  );
}
