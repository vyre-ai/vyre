// Lessons, a tab in Memory on a real vyred: what Vyre learned from the person's corrections. Proposed (waiting for a yes), Active, Retired, and Proposed skills.
// Making a lesson stricter is free; loosening one (Accept, Relax) needs the person, which the app's box call answers with the phone's proof. Nothing here is composed.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Segmented, Text, showToast } from "@vyre/ui";
import { lessons } from "./lessons";
import { checkWords, countsLine, editRefusal, groupLessons, lowerLevels, refusalWords, scopeWords, skillLine, SOURCE, verdictOf, type Lesson, type Skill } from "./lessons-model";

type Loaded = { lessons: Lesson[]; stats: unknown; skills: Skill[] | null };
const say = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const err = (e: unknown) => e as { code?: string; message?: string };

function LessonRow({ l, stats, busy, run, reload }: { l: Lesson; stats: unknown; busy: boolean; run: (tool: string, f: () => Promise<unknown>, done: string) => void; reload: () => void }) {
  const [mode, setMode] = useState<"show" | "edit" | "relax" | "retire">("show");
  const [rule, setRule] = useState(l.rule);
  const [when, setWhen] = useState(l.when || "always");
  const lower = lowerLevels(l.level);
  const [level, setLevel] = useState(lower[lower.length - 1] ?? "");
  const [msg, setMsg] = useState("");
  const verdict = verdictOf(stats, l.id);
  const src = l.source ?? {};
  const check = checkWords(l.check);

  const save = () => {
    const change: { rule?: string; when?: string } = {};
    if (rule.trim() && rule.trim() !== l.rule) change.rule = rule.trim();
    if (when.trim() && when.trim() !== (l.when || "always")) change.when = when.trim();
    if (!Object.keys(change).length) { setMode("show"); return; }
    lessons.edit(l.id, change).then(() => { showToast("Saved."); setMode("show"); reload(); }).catch((e) => setMsg(editRefusal(err(e))));
  };

  if (mode === "edit") {
    return (
      <View className="gap-s2 p-s4">
        <Field label="Rule" value={rule} onChangeText={setRule} />
        <Field label="When it applies" value={when} onChangeText={setWhen} />
        {msg ? <Text tone="muted" size="secondary">{msg}</Text> : null}
        <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Save" onPress={save} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => { setMode("show"); setMsg(""); }} /></View>
      </View>
    );
  }
  if (mode === "retire") {
    return (
      <View className="gap-s2 p-s4">
        <Text>{l.rule}</Text>
        <Text tone="muted" size="secondary">Retire this lesson? Vyre stops applying it, and it keeps its counts.</Text>
        <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Retire" onPress={() => { setMode("show"); run("learn.retire", () => lessons.retire(l.id), "Retired."); }} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setMode("show")} /></View>
      </View>
    );
  }
  if (mode === "relax") {
    return (
      <View className="gap-s2 p-s4">
        <Text>{l.rule}</Text>
        <Text tone="muted" size="secondary">{`Now ${l.level}. Lower it to`}</Text>
        <Segmented label="Lower to" value={level} onChange={setLevel} options={lower.map((v) => [v, v] as [string, string])} />
        <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Relax" onPress={() => { setMode("show"); run("learn.relax", () => lessons.relax(l.id, level), `Relaxed to ${level}.`); }} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setMode("show")} /></View>
      </View>
    );
  }
  const from = SOURCE[src.kind ?? ""] || src.kind || "a thread";
  const actions = l.status === "proposed"
    ? <View className="flex-row flex-wrap gap-s2"><Button size="sm" label="Accept" disabled={busy} onPress={() => run("learn.accept", () => lessons.accept(l.id), "Accepted. It applies from the next turn.")} /><Button kind="ghost" size="sm" label="Edit" onPress={() => setMode("edit")} /><Button kind="ghost" size="sm" label="Decline" disabled={busy} onPress={() => run("learn.retire", () => lessons.retire(l.id), "Declined.")} /></View>
    : l.status === "retired" ? null
    : <View className="flex-row flex-wrap gap-s2"><Button kind="ghost" size="sm" label="Edit" onPress={() => setMode("edit")} /><Button kind="ghost" size="sm" label="Relax" disabled={!lower.length || busy} onPress={() => setMode("relax")} /><Button kind="ghost" size="sm" label="Retire" disabled={busy} onPress={() => setMode("retire")} /></View>;
  return (
    <Row title={<Text size="body">{l.rule}</Text>}
      sub={
        <View className="gap-s1 pt-s1">
          {l.when && l.when !== "always" ? <Text size="secondary" tone="label">{`When ${l.when}`}</Text> : null}
          <Text size="secondary" tone="label">{[l.level, check ?? "no check", scopeWords(l.scope)].join(", ")}</Text>
          <Text size="secondary" tone="label">{countsLine(l)}</Text>
          {verdict ? <Text size="secondary" tone={verdict.verdict === "not working" ? "err" : "label"}>{verdict.text}</Text> : null}
          <Text size="caption" tone="faint">{`From ${from}`}</Text>
          {msg ? <Text size="secondary" tone="muted">{msg}</Text> : null}
          {actions}
        </View>
      } />
  );
}

export default function RealLessons({ onCount }: { onCount?: (n: number) => void }) {
  const [d, setD] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const load = useCallback(() => {
    lessons.load().then((x) => { setD(x); setProblem(""); onCount?.(groupLessons(x.lessons).proposed.length); }).catch((e) => setProblem(say(e, "Lessons did not load.")));
  }, [onCount]);
  useEffect(load, [load]);

  /** A presence tool: the box call asks for the person's proof; a cancel or refusal leaves the row as it was and says why. */
  const run = (tool: string, f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    f().then(() => { showToast(done); load(); }).catch((e) => showToast(refusalWords(err(e), tool))).finally(() => setBusy(false));
  };

  if (problem && !d) return <ErrorState title="Lessons did not load" reason={problem} />;
  if (!d) return <LoadingState rows={3} />;
  const g = groupLessons(d.lessons);
  const skills = (d.skills ?? []).filter((k) => !k.status || k.status === "proposed");
  if (!d.lessons.length && !skills.length) return <Card><EmptyState title="No lessons yet" body="When you correct Vyre, it proposes a lesson here. Say yes and it is enforced from the next turn." /></Card>;
  const list = (title: string, rows: Lesson[]) => rows.length ? (
    <View className="gap-s2 pt-s4">
      <View className="flex-row items-baseline gap-s2"><Text strong size="secondary">{title}</Text><Text size="caption" tone="faint">{String(rows.length)}</Text></View>
      <Card flush>{rows.map((l, i) => <View key={String(l.id)}>{i ? <Divider /> : null}<LessonRow l={l} stats={d.stats} busy={busy} run={run} reload={load} /></View>)}</Card>
    </View>
  ) : null;
  return (
    <View className="gap-s2 pt-s2">
      <Text tone="muted" size="secondary">What Vyre learned from your corrections. A lesson with a check is enforced by the hooks; one broken again moves up a level. Making a lesson stricter is yours to do here; loosening one needs you in person.</Text>
      {list("Proposed", g.proposed)}
      {list("Active", g.active)}
      {skills.length ? (
        <View className="gap-s2 pt-s4">
          <Text strong size="secondary">Proposed skills</Text>
          <Card flush>
            {skills.map((k, i) => (
              <View key={String(k.id)}>{i ? <Divider /> : null}
                <Row title={<Text size="body" mono>{k.name || `skill ${k.id}`}</Text>}
                  sub={<View className="gap-s1 pt-s1">{k.description ? <Text size="secondary" tone="label">{k.description}</Text> : null}{skillLine(k) ? <Text size="secondary" tone="label">{skillLine(k)}</Text> : null}
                    <View className="flex-row gap-s2"><Button size="sm" label="Install" disabled={busy} onPress={() => run("learn.skill-install", () => lessons.skillInstall(k.id), "Installed.")} /><Button kind="ghost" size="sm" label="Dismiss" disabled={busy} onPress={() => run("learn.skill_retire", () => lessons.skillDismiss(k.id), "Dismissed.")} /></View></View>} />
              </View>
            ))}
          </Card>
        </View>
      ) : null}
      {g.retired.length ? (
        <View className="gap-s2 pt-s4">
          <Chip onPress={() => setShowRetired((v) => !v)}>{`${showRetired ? "Hide" : "Show"} retired (${g.retired.length})`}</Chip>
          {showRetired ? <Card flush>{g.retired.map((l, i) => <View key={String(l.id)}>{i ? <Divider /> : null}<LessonRow l={l} stats={d.stats} busy={busy} run={run} reload={load} /></View>)}</Card> : null}
        </View>
      ) : null}
      {problem ? <Banner><Text>{problem}</Text></Banner> : null}
    </View>
  );
}
