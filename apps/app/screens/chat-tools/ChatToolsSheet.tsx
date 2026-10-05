// The chat tools sheet (map: "Chat tools sheet", a sheet over a chat). In this chat: fork, effort and thinking, mode, send now, carry on here,
// mention someone, context used, what it is doing, go back, transcript. The chat's header or composer opens it; this file owns nothing of the chat.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Divider, EmptyState, Field, LoadingState, Row, SectionLabel, Segmented, Sheet, Switch, Text, showToast } from "@vyre/ui";
import { chatTools } from "./instance";
import { EFFORTS, contextLines, effortLabel, mentionText, modeLabel, modesOf, takesOff, taskLive, type Commit, type Line, type Mention, type Task } from "./model.ts";

export type ChatToolsProps = {
  open: boolean; onClose: () => void;
  thread: string; project?: string | null; session?: string | null; cwd?: string | null;
  /** What the chat knows now: its mode (and the modes it offers), thinking and effort. */
  state?: { mode?: string | null; modes?: string[] | null; thinking?: boolean | null; effort?: string | null };
  /** Messages waiting for the turn to end; "Send now" steers with one. */
  queued?: { queued: number; text: string }[];
  /** Set when this chat is on another device that is away: the sheet offers to carry on here. */
  away?: { machine?: string; name?: string } | null;
  onForked?: (thread: string) => void;
  /** A person picked someone or something: the text to put in the draft. */
  onMention?: (text: string) => void;
};
type Page = "main" | "effort" | "mode" | "tasks" | "context" | "transcript" | "back" | "mention";
const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);
const TITLES: Record<Page, string> = { main: "In this chat", effort: "Effort", mode: "Mode", tasks: "Running here", context: "Context used", transcript: "Transcript", back: "Go back", mention: "Mention someone" };

export function ChatToolsSheet(p: ChatToolsProps) {
  const [page, setPage] = useState<Page>("main");
  const [mode, setMode] = useState<string | null>(p.state?.mode ?? null);
  const [thinking, setThinking] = useState<boolean | null>(p.state?.thinking ?? null);
  const [effort, setEffort] = useState<string | null>(p.state?.effort ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => { setMode(p.state?.mode ?? null); setThinking(p.state?.thinking ?? null); setEffort(p.state?.effort ?? null); }, [p.state?.mode, p.state?.thinking, p.state?.effort]);
  useEffect(() => { if (p.open) { setPage("main"); setProblem(""); } }, [p.open]);
  const run = async (fn: () => Promise<{ ok: boolean; reason?: string; note?: string }>, done?: () => void, ok?: string) => {
    setBusy(true); setProblem("");
    const r = await fn();
    setBusy(false);
    if (r.ok) { done?.(); const m = r.note || ok; if (m) showToast(m); } else setProblem(r.reason || "That did not go through.");
  };
  const go = (to: Page) => { setProblem(""); setPage(to); };
  const title = TITLES[page];

  return (
    <Sheet open={p.open} onClose={p.onClose} title={title}>
      <View className="gap-s2">
        {page !== "main" ? <View className="self-start"><Button kind="ghost" size="sm" label="In this chat" onPress={() => go("main")} /></View> : null}
        {problem ? <Banner tone="warn">{problem}</Banner> : null}
        {page === "main" ? (
          <View>
            <SectionLabel first>This chat</SectionLabel>
            <Row dense title="Fork this chat" sub="A copy to take somewhere else; this one stays" chevron
              onPress={() => run(async () => { const r = await chatTools.fork(p.thread); if (r.ok) { p.onForked?.(r.thread); p.onClose(); } return r; })} />
            <Divider />
            <Row dense title="Effort" state={effortLabel(effort)} chevron onPress={() => go("effort")} />
            <Divider />
            <Row dense title="Thinking" sub={thinking === null ? "From the next turn" : undefined}
              end={<Switch label="Thinking" on={thinking === true} disabled={busy} onChange={(on) => { const was = thinking; setThinking(on); run(async () => { const r = await chatTools.thinking(p.thread, on); if (!r.ok) setThinking(was); return r; }); }} />} />
            <Divider />
            <Row dense title="Mode" state={modeLabel(mode)} chevron onPress={() => go("mode")} />
            {p.away ? <><Divider /><Row dense title="Carry on here" sub={p.away.name ? `Take it over from ${p.away.name}` : "Take it over from the other device"} chevron
              onPress={() => run(() => chatTools.continueHere(p.thread, p.away?.machine), p.onClose, "This chat is here now.")} /></> : null}
            {p.queued && p.queued.length ? (
              <>
                <SectionLabel>Waiting to send</SectionLabel>
                {p.queued.map((q, i) => (
                  <View key={q.queued}>
                    {i ? <Divider /> : null}
                    <Row dense title={q.text || "A message"} end={<Button size="sm" label="Send now" disabled={busy} onPress={() => run(() => chatTools.sendNow(p.thread, q.queued), undefined, "Sent now.")} />} />
                  </View>
                ))}
              </>
            ) : null}
            <SectionLabel>Around it</SectionLabel>
            <Row dense title="Mention someone" sub="A teammate, a project, a file or a record" chevron onPress={() => go("mention")} />
            <Divider />
            <Row dense title="Running here" sub="What it is doing in the background" chevron onPress={() => go("tasks")} />
            <Divider />
            <Row dense title="Context used" sub="What Vyre can see from this chat" chevron onPress={() => go("context")} />
            <Divider />
            <Row dense title="Transcript and recall" chevron onPress={() => go("transcript")} />
            {p.project && p.session ? <><Divider /><Row dense title="Go back" sub="Take off the changes it made, or put them back" chevron onPress={() => go("back")} /></> : null}
          </View>
        ) : null}
        {page === "effort" ? (
          <View>
            <Text tone="muted" size="caption">How hard it thinks, from the next turn.</Text>
            {EFFORTS.map((e, i) => (
              <View key={e.label}>
                {i ? <Divider /> : null}
                <Row dense title={e.label} selected={(e.id ?? null) === (effort ?? null)} state={(e.id ?? null) === (effort ?? null) ? "Now" : undefined}
                  onPress={() => { const was = effort; setEffort(e.id); run(async () => { const r = await chatTools.effort(p.thread, e.id); if (!r.ok) setEffort(was); return r; }, () => go("main")); }} />
              </View>
            ))}
          </View>
        ) : null}
        {page === "mode" ? (
          <View>
            <Text tone="muted" size="caption">Applies to a running chat.</Text>
            {modesOf(p.state?.modes).map((m, i) => (
              <View key={m}>
                {i ? <Divider /> : null}
                <Row dense title={modeLabel(m)} selected={(mode || "default") === m} state={(mode || "default") === m ? "Now" : undefined}
                  onPress={() => { const was = mode; setMode(m); run(async () => { const r = await chatTools.mode(p.thread, m); if (!r.ok) setMode(was); return r; }, () => go("main")); }} />
              </View>
            ))}
          </View>
        ) : null}
        {page === "mention" ? <MentionPage onPick={(m) => { p.onMention?.(mentionText(m)); p.onClose(); }} /> : null}
        {page === "tasks" ? <TasksPage thread={p.thread} /> : null}
        {page === "context" ? <ContextPage thread={p.thread} project={p.project} cwd={p.cwd} /> : null}
        {page === "transcript" ? <TranscriptPage thread={p.thread} /> : null}
        {page === "back" && p.project && p.session ? <BackPage project={p.project} session={p.session} /> : null}
      </View>
    </Sheet>
  );
}

function useRead<T>(read: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => { setErr(""); read().then(setData).catch((e) => setErr(say(e, "That could not be read."))); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  return { data, err, load };
}

function MentionPage({ onPick }: { onPick: (m: Mention) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Mention[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { const t = setTimeout(() => { setErr(""); chatTools.mentions(q).then(setRows).catch((e) => setErr(say(e, "The search did not run."))); }, 200); return () => clearTimeout(t); }, [q]);
  return (
    <View className="gap-s2">
      <Field name="Search people, projects and files" kind="text" value={q} onChangeText={setQ} placeholder="Search" />
      {err ? <Banner tone="warn">{err}</Banner> : null}
      {!rows && !err ? <LoadingState rows={3} /> : null}
      {rows && !rows.length ? <EmptyState title="Nothing matches" body="Try a name, a project or a file." /> : null}
      {rows?.map((m, i) => <View key={m.kind + m.id}>{i ? <Divider /> : null}<Row dense title={m.name} sub={m.hint || undefined} state={m.kind === "teammate" ? "Teammate" : m.kind} onPress={() => onPick(m)} /></View>)}
    </View>
  );
}

function TasksPage({ thread }: { thread: string }) {
  const { data, err, load } = useRead<Task[]>(() => chatTools.tasks(thread), [thread]);
  const [problem, setProblem] = useState("");
  if (err) return <Banner tone="warn">{err}</Banner>;
  if (!data) return <LoadingState rows={2} />;
  if (!data.length) return <EmptyState title="Nothing running" body="Background work this chat starts shows here." />;
  return (
    <View>
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {data.map((t, i) => (
        <View key={t.id}>
          {i ? <Divider /> : null}
          <Row dense title={t.title} sub={t.status} end={taskLive(t) ? <Button kind="ghost" size="sm" label="Stop" onPress={() => chatTools.stopTask(thread, t.id).then((r) => { if (r.ok) load(); else setProblem(r.reason); })} /> : undefined} />
        </View>
      ))}
    </View>
  );
}

function ContextPage({ thread, project, cwd }: { thread: string; project?: string | null; cwd?: string | null }) {
  const { data, err } = useRead(() => chatTools.context(thread, project, cwd), [thread, project, cwd]);
  if (err) return <Banner tone="warn">{err}</Banner>;
  if (!data) return <LoadingState rows={3} />;
  const lines = contextLines(data);
  if (!lines.length) return <EmptyState title="Nothing shared yet" body="Vyre has not been told where you are." />;
  return <View>{lines.map((l, i) => <View key={l.label}>{i ? <Divider /> : null}<Row dense title={l.label} sub={l.value} /></View>)}</View>;
}

function TranscriptPage({ thread }: { thread: string }) {
  const { data, err } = useRead<Line[]>(() => chatTools.transcript(thread), [thread]);
  if (err) return <Banner tone="warn">{err}</Banner>;
  if (!data) return <LoadingState rows={4} />;
  if (!data.length) return <EmptyState title="Nothing said yet" body="The words of this chat show here." />;
  const who = (w: Line["who"]) => (w === "you" ? "You" : w === "assistant" ? "Assistant" : w === "tool" ? "Tool" : "Thinking");
  return <View>{data.map((l, i) => <View key={i}>{i ? <Divider /> : null}<Row dense title={l.text} sub={who(l.who)} /></View>)}</View>;
}

function BackPage({ project, session }: { project: string; session: string }) {
  const { data, err, load } = useRead(() => chatTools.history(project, session), [project, session]);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<{ ok: boolean; reason?: string; note?: string }>) => { setBusy(true); setProblem(""); fn().then((r) => { if (r.ok) { showToast(r.note || "Done."); load(); } else setProblem(r.reason || "That did not go through."); }).finally(() => setBusy(false)); };
  if (err) return <Banner tone="warn">{err}</Banner>;
  if (!data) return <LoadingState rows={3} />;
  const commits: Commit[] = data.commits;
  return (
    <View className="gap-s2">
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {data.dirty ? <Text tone="muted" size="caption">{`${data.dirty} unsaved ${data.dirty === 1 ? "change" : "changes"} are kept if you go back.`}</Text> : null}
      {!commits.length ? <EmptyState title="Nothing to go back to" body="Changes this chat makes show here." /> : commits.map((c, i) => (
        <View key={c.sha}>
          {i ? <Divider /> : null}
          <Row dense title={c.subject} sub={`Goes back past ${takesOff(commits, c.sha)} ${takesOff(commits, c.sha) === 1 ? "change" : "changes"}`}
            end={<Button kind="ghost" size="sm" label="Go back" disabled={busy} onPress={() => act(() => chatTools.undo(project, session, c.sha))} />} />
        </View>
      ))}
      <View className="self-start"><Button kind="ghost" size="sm" label="Put back" disabled={busy} onPress={() => act(() => chatTools.redo(project, session))} /></View>
    </View>
  );
}
