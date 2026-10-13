// One chat panel (it replaces the two "In this chat" sheets). A calm right-side panel on a wide screen, a sheet on a phone; one entry, the header.
// Sections: People, About (project, record, what assistants can see), How it answers (effort, thinking, mode, who replies), Where it runs, Around it (files, context, background work, transcript, fork, go back).
// Mute and Pin are quiet header actions. "Answering" (which AI replies to the next message) stays in the composer: it is per message, these are the chat's standing settings.
// Keyboard: Up, Down, Home and End move between rows, a letter jumps to the next row that starts with it, Enter opens, Esc goes back and then closes.

import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Avatar, Banner, Button, Chip, Divider, Icon, Row, SectionLabel, Sheet, Switch, Text, markRef, showToast, useUiTheme } from "@vyre/ui";
import { jumpIndex, stepFocus } from "@vyre/ui/lib/picker-model.js";
import { ProjectPicker } from "./ProjectPicker";
import { Face } from "./Face";
import type { Participant } from "./group.js";
import type { AboutInfo } from "./AboutSheet";
import type { ProjectRef } from "./useChatProject";
import { chatTools } from "../../screens/chat-tools/instance";
import { ForkRows, TasksPage, ContextPage, TranscriptPage, BackPage } from "../../screens/chat-tools/ChatToolsSheet";
import { ChatFiles } from "../../screens/chat-tools/ChatFiles";
import { EFFORTS, effortLabel, modeLabel, modesOf, taskLive } from "../../screens/chat-tools/model.ts";

export type PanelPage = "root" | "project" | "effort" | "mode" | "tasks" | "context" | "transcript" | "back" | "files";
const TITLES: Record<PanelPage, string> = { root: "In this chat", project: "Move to a project", effort: "Effort", mode: "Mode", tasks: "Running here", context: "Context used", transcript: "Transcript and recall", back: "Go back", files: "Files" };
const fam = (f: string) => (f === "assistant" ? "assistant" : f === "model" ? "model" : "person");

export type ChatPanelProps = {
  open: boolean; onClose: () => void; phone: boolean; page: PanelPage; onPage: (p: PanelPage) => void;
  participants: readonly Participant[]; viewer: string; info: AboutInfo;
  muted: boolean; pinned: boolean; onMute: (on: boolean) => void; onPin: (on: boolean) => void;
  onMove?: () => void; onOpenTerminal?: () => void; onOpenParticipant?: (id: string) => void;
  addable?: readonly { name: string; id?: string; family: string }[];
  onAdd?: (who: { name: string; id?: string; family: string }) => Promise<string | null>;
  /** The project the chat is in, the ones it could move to, and the move (null takes it out). */
  project: { current: ProjectRef | null; projects: readonly ProjectRef[]; move: (to: string | null) => Promise<string | null> };
  /** Puts "#" in the message box, to link a record. */
  onLinkRecord: () => void;
  thread: string; chat: string; projectSlug?: string | null; session?: string | null; cwd?: string | null;
  state?: { mode?: string | null; modes?: string[] | null; thinking?: boolean | null; effort?: string | null };
  queued?: { queued: number; text: string }[]; away?: { machine?: string; name?: string } | null; otherPlace?: "mac" | "server" | null;
  onForked?: (thread: string) => void; replyMode?: string | null; shared?: boolean; onOpenFiles?: () => void;
};

export function ChatPanel(p: ChatPanelProps) {
  const { color } = useUiTheme();
  const box = useRef<View>(null);
  const [mode, setMode] = useState<string | null>(p.state?.mode ?? null);
  const [thinking, setThinking] = useState<boolean | null>(p.state?.thinking ?? null);
  const [effort, setEffort] = useState<string | null>(p.state?.effort ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [adding, setAdding] = useState(false);
  const moving = useRef(false);
  const [running, setRunning] = useState<number | null>(null);
  useEffect(() => { setMode(p.state?.mode ?? null); setThinking(p.state?.thinking ?? null); setEffort(p.state?.effort ?? null); }, [p.state?.mode, p.state?.thinking, p.state?.effort]);
  useEffect(() => { if (p.open) setProblem(""); }, [p.open, p.page]);
  // Live state at a glance: how many things are running in the background.
  useEffect(() => {
    if (!p.open) return;
    let live = true;
    chatTools.tasks(p.thread).then((t) => { if (live) setRunning(t.filter(taskLive).length); }).catch(() => { if (live) setRunning(null); });
    return () => { live = false; };
  }, [p.open, p.thread]);

  const run = async (fn: () => Promise<{ ok: boolean; reason?: string; note?: string }>, done?: () => void, ok?: string) => {
    setBusy(true); setProblem("");
    const r = await fn();
    setBusy(false);
    if (r.ok) { done?.(); const m = r.note || ok; if (m) showToast(m); } else setProblem(r.reason || "That did not go through.");
  };
  const back = () => (p.page === "root" ? p.onClose() : p.onPage("root"));
  const backRef = useRef(back);
  backRef.current = back;

  // The keyboard (web): Esc goes back then closes; arrows, Home and End move between rows; a letter jumps to a row that starts with it. The project page's own box keeps its keys.
  useEffect(() => {
    if (!p.open || Platform.OS !== "web") return;
    let typed = ""; let t: ReturnType<typeof setTimeout> | undefined;
    const rows = () => Array.from((box.current as unknown as HTMLElement | null)?.querySelectorAll<HTMLElement>('[role="button"]:not([aria-disabled="true"]),[role="switch"]') ?? []);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); backRef.current(); return; }
      const el = e.target as HTMLElement;
      if (!(box.current as unknown as HTMLElement | null)?.contains(el) || el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
      const list = rows();
      const idx = list.indexOf(el);
      const at = Math.max(0, idx);
      const target = idx < 0 ? (e.key === "ArrowDown" || e.key === "Home" ? 0 : e.key === "ArrowUp" || e.key === "End" ? list.length - 1 : -1) : stepFocus(idx, list.length, e.key);
      if (target >= 0 && list.length) { e.preventDefault(); list[target].focus(); return; }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
        typed += e.key; clearTimeout(t); t = setTimeout(() => { typed = ""; }, 700);
        const j = jumpIndex(list.map((x) => (x.getAttribute("aria-label") || x.textContent || "").trim()), at, typed);
        if (j >= 0) { e.preventDefault(); list[j].focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    // Focus the first row when it opens so the keyboard works at once.
    const f = setTimeout(() => { if (p.page !== "project") (box.current as unknown as HTMLElement | null)?.querySelector<HTMLElement>('[role="button"]:not([aria-label^="Close"])')?.focus(); }, 60);
    return () => { document.removeEventListener("keydown", onKey); clearTimeout(f); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, p.page]);

  const here = p.info.runsOn === "mac" ? "This Mac" : "The server";
  const there = p.info.runsOn === "mac" ? "the server" : "this Mac";
  const proj = p.project.current && p.project.current.slug !== "general" ? p.project.current : null;

  const root = (
    <View style={{ gap: 4 }}>
      <SectionLabel first meta={String(p.participants.length)}>People</SectionLabel>
      {p.participants.map((x) => (
        <Row key={x.id} dense lead={<Face name={x.name} family={fam(x.family)} size={32} id={x.id} />} title={x.name}
          sub={x.id === p.viewer ? "You" : x.family === "assistant" ? `Assistant${x.role ? `, ${x.role}` : ""}` : x.role ?? "Person"}
          onPress={p.onOpenParticipant ? () => p.onOpenParticipant?.(x.id) : undefined} accessibilityLabel={`${x.name}, open card`} />
      ))}
      {p.onAdd && p.addable ? (adding ? (
        <View style={{ gap: 4 }}>
          {p.addable.length ? p.addable.map((a) => (
            <Row key={a.id ?? a.name} dense lead={<Face name={a.name} family={fam(a.family)} size={32} id={a.id ?? a.name} />} title={a.name} sub={a.family === "assistant" ? "Agent" : "Person"}
              end={<Button size="sm" kind="secondary" label="Add" onPress={async () => { const r = await p.onAdd?.(a); if (r) setProblem(r); else setAdding(false); }} />} />
          )) : <Text tone="muted">Everyone you can add is already in this chat.</Text>}
        </View>
      ) : <Row dense title="Add a teammate" lead={<Icon name="plus" size={20} />} onPress={() => setAdding(true)} />) : null}

      <SectionLabel>About</SectionLabel>
      <Row dense lead={proj ? <Avatar of={markRef("project", proj.name, proj.slug)} size={32} /> : <Icon name="projects" size={20} />} title={proj ? proj.name : "Not in a project"} sub={proj ? "Project" : "Keep this chat with its project"} state={proj ? "Change" : "Move"} chevron onPress={() => p.onPage("project")} accessibilityLabel={proj ? `Project ${proj.name}. Move to another project` : "Not in a project. Move to a project"} />
      <Row dense lead={<Icon name="hash" size={20} />} title={p.info.record ? p.info.record.title : "Link to a record"} sub={p.info.record ? `${p.info.record.type}${p.info.space ? " in " + p.info.space : ""}` : "Types # in the message box and picks one"} chevron={!p.info.record} onPress={p.info.record ? undefined : () => { p.onClose(); p.onLinkRecord(); }} />
      <View style={{ paddingHorizontal: 12, paddingVertical: 6, gap: 6 }}>
        <Text size="caption" tone="muted">Assistants see this chat and the records you tag, with the grants of whoever asked.</Text>
        <View style={{ flexDirection: "row" }}><Chip tone="sealed" icon="shield">{p.info.sealed > 0 ? `${p.info.sealed} sealed field${p.info.sealed === 1 ? "" : "s"}, never shown` : "No sealed fields here"}</Chip></View>
      </View>

      <SectionLabel>How it answers</SectionLabel>
      <Row dense title="Effort" state={effortLabel(effort)} chevron onPress={() => p.onPage("effort")} />
      <Row dense title="Thinking" sub={thinking === null ? "From the next turn" : undefined}
        end={<Switch label="Thinking" on={thinking === true} disabled={busy} onChange={(on) => { const was = thinking; setThinking(on); void run(async () => { const r = await chatTools.thinking(p.thread, on); if (!r.ok) setThinking(was); return r; }); }} />} />
      <Row dense title="Mode" state={modeLabel(mode)} chevron onPress={() => p.onPage("mode")} />
      {p.shared ? <Row dense title="AI replies" sub={p.replyMode === "mention" ? "Only when someone mentions it or replies to it" : p.replyMode === "every" ? "To every message, each on its sender's own AI" : "As this chat is set"} chevron
        onPress={() => void run(() => chatTools.replyMode(p.chat, p.replyMode === "mention" ? "every" : "mention"), undefined, "Changed. Everyone in the chat sees it.")} /> : null}

      <SectionLabel>Where it runs</SectionLabel>
      <Row dense lead={<Icon name={p.info.runsOn === "mac" ? "laptop" : "box"} size={20} />} title={here} sub={`Or on ${there}`} end={p.onMove ? <Button size="sm" kind="secondary" label={`Move to ${there}`} onPress={p.onMove} /> : undefined} />
      {p.away ? <Row dense title="Carry on here" sub={p.away.name ? `Take it over from ${p.away.name}` : "Take it over from the other device"} chevron onPress={() => void run(() => chatTools.continueHere(p.thread, p.away?.machine), p.onClose, "This chat is here now.")} /> : null}
      {p.onOpenTerminal ? <Row dense title="Open full terminal" sub="The shell in this chat's folder" chevron onPress={() => { p.onClose(); p.onOpenTerminal?.(); }} /> : null}

      {p.queued && p.queued.length ? <>
        <SectionLabel>Waiting to send</SectionLabel>
        {p.queued.map((q) => <Row key={q.queued} dense title={q.text || "A message"} end={<Button size="sm" label="Send now" disabled={busy} onPress={() => void run(() => chatTools.sendNow(p.thread, q.queued), undefined, "Sent now.")} />} />)}
      </> : null}

      <SectionLabel>Around it</SectionLabel>
      <Row dense lead={<Icon name="file" size={20} />} title="Files" sub="Made, received and shared with the project" chevron onPress={() => (p.onOpenFiles ? (p.onClose(), p.onOpenFiles()) : p.onPage("files"))} />
      <Row dense lead={<Icon name="bolt" size={20} />} title="Running here" state={running == null ? undefined : running ? `${running} running` : "Nothing"} chevron onPress={() => p.onPage("tasks")} />
      <Row dense lead={<Icon name="info" size={20} />} title="Context used" sub="What Vyre can see from this chat" chevron onPress={() => p.onPage("context")} />
      <Row dense lead={<Icon name="history" size={20} />} title="Transcript and recall" chevron onPress={() => p.onPage("transcript")} />
      <ForkRows otherPlace={p.otherPlace} onFork={() => void run(async () => { const r = await chatTools.fork(p.thread); if (r.ok) { p.onForked?.(r.thread); p.onClose(); } return r; })}
        onForkTo={(to) => void run(async () => { const r = await chatTools.forkTo(p.thread, to); if (r.ok) { p.onForked?.(r.thread); p.onClose(); } return r; })} />
      {p.projectSlug && p.session ? <Row dense lead={<Icon name="undo" size={20} />} title="Go back" sub="Take off the changes it made, or put them back" chevron onPress={() => p.onPage("back")} /> : null}
    </View>
  );

  const sub: Record<string, React.ReactNode> = {
    project: <ProjectPicker projects={p.project.projects} current={p.project.current} onPick={async (slug) => { if (moving.current) return; moving.current = true; const r = await p.project.move(slug); moving.current = false; if (r) setProblem(r); else { showToast(slug ? "Moved to the project." : "Taken out of the project."); p.onPage("root"); } }} onBack={() => p.onPage("root")} />,
    effort: <View>{EFFORTS.map((e, i) => <View key={e.label}>{i ? <Divider /> : null}<Row dense title={e.label} selected={(e.id ?? null) === (effort ?? null)} state={(e.id ?? null) === (effort ?? null) ? "Now" : undefined}
      onPress={() => { const was = effort; setEffort(e.id); void run(async () => { const r = await chatTools.effort(p.thread, e.id); if (!r.ok) setEffort(was); return r; }, () => p.onPage("root")); }} /></View>)}</View>,
    mode: <View>{modesOf(p.state?.modes).map((m, i) => <View key={m}>{i ? <Divider /> : null}<Row dense title={modeLabel(m)} selected={(mode || "default") === m} state={(mode || "default") === m ? "Now" : undefined}
      onPress={() => { const was = mode; setMode(m); void run(async () => { const r = await chatTools.mode(p.thread, m); if (!r.ok) setMode(was); return r; }, () => p.onPage("root")); }} /></View>)}</View>,
    tasks: <TasksPage thread={p.thread} />,
    context: <ContextPage thread={p.thread} project={p.projectSlug} cwd={p.cwd} />,
    transcript: <TranscriptPage thread={p.thread} />,
    back: p.projectSlug && p.session ? <BackPage project={p.projectSlug} session={p.session} /> : null,
    files: <ChatFiles chat={p.chat} />,
  };

  const head = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 48 }}>
      {p.page !== "root" ? <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={back} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20 }}><Icon name="chev-l" size={20} tone="text" /></Pressable> : null}
      <Text size="title" strong style={{ flex: 1 }} numberOfLines={1}>{TITLES[p.page]}</Text>
      {p.page === "root" ? (
        <>
          <Pressable accessibilityRole="button" accessibilityLabel={p.muted ? "Unmute this chat" : "Mute this chat. No alerts; mentions still reach you"} accessibilityState={{ selected: p.muted }} onPress={() => p.onMute(!p.muted)} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: p.muted ? color["accent-wash"] : "transparent" }}><Icon name="bell" size={18} tone={p.muted ? "accent" : "label"} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={p.pinned ? "Unpin this chat" : "Pin this chat to the top of Chat"} accessibilityState={{ selected: p.pinned }} onPress={() => p.onPin(!p.pinned)} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: p.pinned ? color["accent-wash"] : "transparent" }}><Icon name="pin" size={18} tone={p.pinned ? "accent" : "label"} /></Pressable>
        </>
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={p.onClose} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20 }}><Icon name="x" size={18} tone="label" /></Pressable>
    </View>
  );
  const body = <View ref={box} style={{ gap: 8 }}>{head}{problem ? <Banner tone="warn">{problem}</Banner> : null}{p.page === "root" ? root : sub[p.page]}</View>;

  if (!p.open) return null;
  if (p.phone) return <Sheet open onClose={p.onClose} title={undefined}>{body}</Sheet>;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 30 }}>
      <Pressable accessibilityLabel="Close the chat panel" onPress={p.onClose} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
      <View accessibilityLabel="In this chat" style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 400, backgroundColor: color["surface-2"], borderLeftWidth: 1, borderLeftColor: color.edge, paddingHorizontal: 12, paddingVertical: 8, ...(Platform.OS === "web" ? ({ overflowY: "auto", boxShadow: "-8px 0 24px rgba(0,0,0,0.08)" } as object) : {}) }}>{body}</View>
    </View>
  );
}
