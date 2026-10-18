// One chat panel (it replaces the two "In this chat" sheets). A calm right-side panel on a wide screen, a sheet on a phone; one entry, the header.
// Sections: People, About (project, record, what assistants can see), How it answers (effort, thinking, mode, who replies), Where it runs, Around it (files, context, background work, transcript, fork, go back).
// Mute and Pin are quiet header actions. "Answering" (which AI replies to the next message) stays in the composer: it is per message, these are the chat's standing settings.
// Keyboard: Up, Down, Home and End move between rows, a letter jumps to the next row that starts with it, Enter opens, Esc goes back and then closes.

import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { FileViewer, Avatar, AvatarStack, Banner, Button, Chip, Divider, Icon, PanelCapabilityRows, Row, Sheet, Switch, Tabs, Text, markRef, showToast, useUiTheme } from "@vyre/ui";
import { useRouter } from "expo-router";
import { RAIL, ResizeHandle, useStoredWidth } from "@vyre/ui";
import { ComputerTab } from "./ComputerTab";
import { ThreadsTab } from "./ThreadsTab";
import { chatKind, groupView, panelTabs, tabOf, threadsTab } from "./threads-model.js";
import { StandingRows } from "./StandingRows";
import { jumpIndex, stepFocus } from "@vyre/ui/lib/picker-model.js";
import { ProjectPicker } from "./ProjectPicker";
import { Face } from "./Face";
import type { Participant } from "./group.js";
import type { AboutInfo } from "./AboutSheet";
import type { ProjectRef } from "./useChatProject";
import { chatTools } from "../../screens/chat-tools/instance";
import { ChatTags } from "../../screens/tags/RecordTags";
import { ForkRows, TasksPage, ContextPage, TranscriptPage, BackPage } from "../../screens/chat-tools/ChatToolsSheet";
import { ChatFiles } from "../../screens/chat-tools/ChatFiles";
import { driveSource } from "../../screens/drive/file-source";
import { EFFORTS, effortLabel, modeLabel, modesOf, subagentsOf, taskLive, type Task } from "../../screens/chat-tools/model.ts";

export type PanelPage = "file" | "root" | "more" | "project" | "effort" | "mode" | "tasks" | "context" | "transcript" | "back" | "files";
const TITLES: Record<PanelPage, string> = { file: "File", root: "In this chat", more: "More", project: "Move to a project", effort: "Effort", mode: "Mode", tasks: "Running here", context: "Context used", transcript: "Transcript and recall", back: "Go back", files: "Files" };
const fam = (f: string) => (f === "assistant" ? "assistant" : f === "model" ? "model" : "person");

export type ChatPanelProps = {
  open: boolean; onClose: () => void; phone: boolean; page: PanelPage; onPage: (p: PanelPage) => void;
  /** The tab showing on the first page, and its change (the chat screen keeps it, so the header menu can open the panel on one). */
  tab: string; onTab: (t: string) => void;
  /** A Flow is one chat whose runs are its threads: the tabs are Runs and Details. */ flow?: boolean;
  /** Switch to one of an agent's threads; start a new one (null when it started, else why not). */
  /** Search this chat (the Find action under the name). */ onFind?: () => void;
  onSwitchThread?: (thread: string) => void; onNewThread?: (agent: string) => Promise<string | null>;
  /** The chat's name, for the top of the panel. */ title: string;
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
  /** The file open on the "file" page (a Drive path), and how to open it in Files. */
  file?: string | null; onOpenInFiles?: (path: string) => void;
  /** A pinned assistant or Engineer chat is one chat: no fork. */
  noFork?: boolean;
  onForked?: (thread: string) => void; replyMode?: string | null; shared?: boolean; onOpenFiles?: () => void;
  onMemory?: () => void; onExport?: () => void; onRoll?: () => void;
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
  // Pages reached from More go back to More; the rest go back to the tabs.
  const cameFromMore = useRef(false);
  const open = (page: PanelPage) => { cameFromMore.current = page !== "more"; p.onPage(page); };
  const back = () => { if (p.page === "root") p.onClose(); else if (p.page !== "more" && cameFromMore.current) p.onPage("more"); else { cameFromMore.current = false; p.onPage("root"); } };
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

  const here = p.info.runsOn === "mac" ? "My Computer" : "Space's Cloud";
  const there = p.info.runsOn === "mac" ? "Space's Cloud" : "My Computer";
  const proj = p.project.current && p.project.current.slug !== "general" ? p.project.current : null;
  // Details, Library and Computer: one tap on the header opens this panel, these are its three parts.
  const router = useRouter();
  // The panel is resizable on a wide screen: its width is kept per device, and a double-click on its edge sets the default.
  const panelW = useStoredWidth("chat-panel", RAIL.panelWidth, RAIL.panelMin, RAIL.panelMax);
  const { tab, onTab: setTab } = p;
  const agents = p.participants.filter((x) => x.family === "assistant" && x.id !== p.viewer);
  const [helpers, setHelpers] = useState<Task[] | null>(null);
  useEffect(() => {
    if (!p.open || (tab !== "library" && tab !== "details" && tab !== "threads")) return;
    let on = true;
    chatTools.tasks(p.thread).then((t) => { if (on) setHelpers(subagentsOf(t)); }).catch(() => { if (on) setHelpers([]); });
    return () => { on = false; };
  }, [p.open, tab, p.thread]);

  const addBlock = (
    <>
      {p.onAdd && p.addable ? (adding ? (
        <View style={{ gap: 4 }}>
          {p.addable.length ? p.addable.map((a) => (
            <Row key={a.id ?? a.name} dense lead={<Face name={a.name} family={fam(a.family)} size={32} id={a.id ?? a.name} />} title={a.name} sub={a.family === "assistant" ? "Agent" : "Person"}
              end={<Button size="sm" kind="secondary" label="Add" onPress={async () => { const r = await p.onAdd?.(a); if (r) setProblem(r); else setAdding(false); }} />} />
          )) : <Text tone="muted">Everyone you can add is already in this chat.</Text>}
        </View>
      ) : <Row dense title="Add people" lead={<Icon name="plus" size={20} />} onPress={() => setAdding(true)} />) : null}
    </>
  );

  const details = (
    <View style={{ gap: 4 }}>
      {p.participants.map((x) => (
        <Row key={x.id} dense lead={<Face name={x.name} family={fam(x.family)} size={32} id={x.id} />} title={x.name}
          sub={x.id === p.viewer ? "You" : x.family === "assistant" ? `Agent${x.role ? `, ${x.role}` : ""}` : x.role ?? "Person"}
          onPress={x.family === "assistant" ? () => { p.onClose(); router.push(`/u/assistants/${encodeURIComponent(x.name)}?tab=activity` as never); } : p.onOpenParticipant ? () => p.onOpenParticipant?.(x.id) : undefined} accessibilityLabel={`${x.name}, open card`} />
      ))}
      {addBlock}

      <Row dense lead={proj ? <Avatar of={markRef("project", proj.name, proj.slug)} size={32} /> : <Icon name="projects" size={20} />} title={proj ? proj.name : "Not in a project"} sub={proj ? "Project" : "Keep this chat with its project"} state={proj ? "Change" : "Move"} chevron onPress={() => { cameFromMore.current = false; p.onPage("project"); }} accessibilityLabel={proj ? `Project ${proj.name}. Move to another project` : "Not in a project. Move to a project"} />
      <Row dense lead={<Icon name="more" size={20} />} title="More" sub="Effort, permissions, where it runs and the rest" chevron onPress={() => open("more")} />
    </View>
  );
  const more = (
    <View style={{ gap: 8 }}>
      {agents.length ? <View style={{ gap: 4 }}><Text size="caption" tone="label" style={{ paddingHorizontal: 12 }}>Standing permissions</Text>{agents.map((a) => <View key={a.id}><Text style={{ paddingHorizontal: 12 }}>{a.name}</Text><StandingRows agent={a.name} /></View>)}</View> : null}
      <Row dense lead={<Icon name="hash" size={20} />} title={p.info.record ? p.info.record.title : "Link to a record"} sub={p.info.record ? `${p.info.record.type}${p.info.space ? " in " + p.info.space : ""}` : "Types # in the message box and picks one"} chevron={!p.info.record} onPress={p.info.record ? undefined : () => { p.onClose(); p.onLinkRecord(); }} />
      <View style={{ paddingHorizontal: 12, paddingVertical: 6, gap: 6 }}>
        <Text size="caption" tone="muted">Agents see this chat and the records you tag, with the grants of whoever asked.</Text>
        <View style={{ flexDirection: "row" }}><Chip tone="sealed" icon="shield">{p.info.sealed > 0 ? `${p.info.sealed} sealed field${p.info.sealed === 1 ? "" : "s"}, never shown` : "No sealed fields here"}</Chip></View>
      </View>

      <Divider />
      <Row dense title="Effort" state={effortLabel(effort)} chevron onPress={() => open("effort")} />
      <Row dense title="Thinking" sub={thinking === null ? "From the next turn" : undefined}
        end={<Switch label="Thinking" on={thinking === true} disabled={busy} onChange={(on) => { const was = thinking; setThinking(on); void run(async () => { const r = await chatTools.thinking(p.thread, on); if (!r.ok) setThinking(was); return r; }); }} />} />
      <Row dense title="Mode" state={modeLabel(mode)} chevron onPress={() => open("mode")} />
      {p.shared ? <Row dense title="AI replies" sub={p.replyMode === "mention" ? "Only when someone mentions it or replies to it" : p.replyMode === "every" ? "To every message, each on its sender's own AI" : "As this chat is set"} chevron
        onPress={() => void run(() => chatTools.replyMode(p.chat, p.replyMode === "mention" ? "every" : "mention"), undefined, "Changed. Everyone in the chat sees it.")} /> : null}

      <Divider />
      <Row dense lead={<Icon name={p.info.runsOn === "mac" ? "laptop" : "box"} size={20} />} title={here} sub={`Or on ${there}`} end={p.onMove ? <Button size="sm" kind="secondary" label={`Move to ${there}`} onPress={p.onMove} /> : undefined} />
      {p.away ? <Row dense title="Carry on here" sub={p.away.name ? `Take it over from ${p.away.name}` : "Take it over from the other device"} chevron onPress={() => void run(() => chatTools.continueHere(p.thread, p.away?.machine), p.onClose, "This chat is here now.")} /> : null}
      {p.onOpenTerminal ? <Row dense title="Open full terminal" sub="The shell in this chat's folder" chevron onPress={() => { p.onClose(); p.onOpenTerminal?.(); }} /> : null}

      {p.queued && p.queued.length ? <>
        <Divider />
        {p.queued.map((q) => <Row key={q.queued} dense title={q.text || "A message"} end={<Button size="sm" label="Send now" disabled={busy} onPress={() => void run(() => chatTools.sendNow(p.thread, q.queued), undefined, "Sent now.")} />} />)}
      </> : null}

      <PanelCapabilityRows
        onMemory={p.onMemory}
        onExport={p.onExport}
        onRoll={p.onRoll}
        onContext={() => { cameFromMore.current = true; p.onPage("context"); }}
        onTasks={() => open("tasks")}
        onTranscript={() => open("transcript")}
        runningCount={running}
      />
      <Divider />
      <Row dense lead={<Icon name="file" size={20} />} title="Files" sub="Made, received and shared with the project" chevron onPress={() => (p.onOpenFiles ? (p.onClose(), p.onOpenFiles()) : open("files"))} />
      {p.noFork ? null : <ForkRows otherPlace={p.otherPlace} onFork={() => void run(async () => { const r = await chatTools.fork(p.thread); if (r.ok) { p.onForked?.(r.thread); p.onClose(); } return r; })}
        onForkTo={(to) => void run(async () => { const r = await chatTools.forkTo(p.thread, to); if (r.ok) { p.onForked?.(r.thread); p.onClose(); } return r; })} />}
      {p.projectSlug && p.session ? <Row dense lead={<Icon name="undo" size={20} />} title="Go back" sub="Take off the changes it made, or put them back" chevron onPress={() => open("back")} /> : null}
    </View>
  );

  const library = (
    <View style={{ gap: 4 }}>
      <Text size="secondary" tone="label" style={{ paddingHorizontal: 12 }}>Files</Text>
      <ChatFiles chat={p.chat} />
      <Text size="secondary" tone="label" style={{ paddingHorizontal: 12, paddingTop: 12 }}>Subagents</Text>
      {helpers === null ? <Text tone="muted">Looking.</Text> : helpers.length ? helpers.map((t) => <Row key={t.id} dense lead={<Icon name="users" size={20} />} title={t.title} sub={t.status} chevron onPress={() => p.onPage("tasks")} />) : <Text tone="muted">Helpers this chat starts to work for it show here.</Text>}
    </View>
  );
  // The tabs depend on the chat: an agent has Threads, Computer, Details; a group has Group and a tab per agent; a Flow has Runs and Details; a person has Details.
  const kind = chatKind({ others: p.participants.filter((x) => x.id !== p.viewer), flow: p.flow });
  const tabs = panelTabs(kind, agents.map((x) => x.name));
  const cur = tabOf(tabs, tab === "library" ? "details" : tab);
  const threadsOf = (agent: string, noun: "thread" | "run" = "thread") => <ThreadsTab key={agent} agent={agent} noun={noun} current={p.thread} onSwitch={(t) => p.onSwitchThread?.(t)} onNew={p.onNewThread ? () => p.onNewThread!(agent) : undefined} />;
  // A group's panel: everyone as faces plus the group's threads; a tap on someone goes in, with Back.
  const view = kind === "group" ? groupView(tab, p.participants) : null;
  const [drillTab, setDrillTab] = useState("threads");
  useEffect(() => { setDrillTab("threads"); }, [tab]);
  const faceOf = (x: (typeof p.participants)[number]) => (
    <Pressable key={x.id} accessibilityRole="button" accessibilityLabel={x.id === p.viewer ? "You" : `Open ${x.name}`} disabled={x.id === p.viewer}
      onPress={() => setTab(x.family === "assistant" ? `agent:${x.name}` : `person:${x.id}`)} style={{ alignItems: "center", gap: 4, width: 72 }}>
      <Face name={x.name} family={fam(x.family)} size={44} id={x.id} />
      <Text size="caption" numberOfLines={1}>{x.id === p.viewer ? "You" : x.name}</Text>
    </Pressable>
  );
  const groupFirst = (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{p.participants.map(faceOf)}</View>
      {addBlock}
      <View style={{ gap: 8 }}>
        <Text size="caption" tone="label" style={{ paddingHorizontal: 12 }}>Threads</Text>
        <ThreadsTab key={p.chat} agent={p.title} chat={p.chat} current={p.thread} onSwitch={(t) => p.onSwitchThread?.(t)} onNew={p.onNewThread ? () => p.onNewThread!(p.title) : undefined} />
      </View>
      <Row dense lead={proj ? <Avatar of={markRef("project", proj.name, proj.slug)} size={32} /> : <Icon name="projects" size={20} />} title={proj ? proj.name : "Not in a project"} sub={proj ? "Project" : "Keep this chat with its project"} />
    </View>
  );
  const backRow = <Row dense lead={<Icon name="chev-l" size={20} />} title="Back" onPress={() => setTab("group")} />;
  const agentView = (name: string) => {
    const who = p.participants.find((x) => x.name === name);
    return (
      <View style={{ gap: 16 }}>
        {backRow}
        <View style={{ alignItems: "center", gap: 6 }}><Face name={name} family="assistant" size={56} id={who?.id ?? name} /><Text size="title" medium>{name}</Text></View>
        <Tabs items={[["threads", "Threads"], ["computer", "Computer"], ["details", "Details"]]} value={drillTab} onChange={setDrillTab} />
        {drillTab === "threads" ? threadsOf(name) : drillTab === "computer" ? <ComputerTab agents={[name]} onLeave={p.onClose} /> : <Row dense title={`Open ${name}`} sub="Model, effort, what it can see and use" chevron onPress={() => { p.onClose(); router.push(`/u/assistants/${encodeURIComponent(name)}` as never); }} />}
      </View>
    );
  };
  const personView = (id: string) => {
    const who = p.participants.find((x) => x.id === id);
    if (!who) return null;
    return (
      <View style={{ gap: 16 }}>
        {backRow}
        <View style={{ alignItems: "center", gap: 6 }}><Face name={who.name} family="person" size={56} id={who.id} /><Text size="title" medium>{who.name}</Text>{who.role ? <Text tone="label">{who.role}</Text> : null}</View>
        <View style={{ gap: 4 }}>
          <Text size="caption" tone="label" style={{ paddingHorizontal: 12 }}>{`You and ${who.name}`}</Text>
          {p.onOpenParticipant ? <Row dense lead={<Icon name="chat" size={20} />} title="Your chat" sub="Just the two of you" chevron onPress={() => p.onOpenParticipant?.(who.id)} /> : null}
        </View>
      </View>
    );
  };
  const body0 = view ? (view.level === "agent" ? agentView(view.name) : view.level === "person" ? personView(view.id) : groupFirst)
    : cur === "threads" && agents[0] ? threadsOf(agents[0].name) : cur === "runs" ? threadsOf(p.title, "run") : cur === "computer" && agents.length ? <ComputerTab agents={agents.map((a) => a.name)} onLeave={p.onClose} />
    : kind === "agent" && cur === "details" ? <View style={{ gap: 16 }}>{details}{library}</View> : details;
  // The top of the panel: one face, the name, the labels. A chat with one other shows their face; more than one shows a small stack.
  const others = p.participants.filter((x) => x.id !== p.viewer);
  const hero = (
    <View style={{ alignItems: "center", gap: 8, paddingTop: 4 }}>
      {others.length === 1
        ? <Avatar of={markRef(others[0].family === "assistant" ? "agent" : "person", others[0].name, others[0].id)} size={56} />
        : others.length ? <AvatarStack of={others.map((x) => markRef(x.family === "assistant" ? "agent" : "person", x.name, x.id))} size={40} max={4} /> : null}
      <Text size="title" medium numberOfLines={2} style={{ textAlign: "center" }}>{kind === "agent" && agents[0] ? agents[0].name : p.title}</Text>
      <ChatTags chat={p.chat} thread={p.thread} />
      {/* the four quick actions under the name: Pinned, Find, Threads (when this chat has them), Mute */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 4 }}>
        <Button kind={p.pinned ? "secondary" : "ghost"} size="sm" label={p.pinned ? "Pinned" : "Pin"} onPress={() => p.onPin(!p.pinned)} />
        {p.onFind ? <Button kind="ghost" size="sm" label="Find" onPress={() => { p.onClose(); p.onFind?.(); }} /> : null}
        {threadsTab(kind, agents.map((x) => x.name), cur) ? <Button kind="ghost" size="sm" label={kind === "flow" ? "Runs" : "Threads"} onPress={() => setTab(threadsTab(kind, agents.map((x) => x.name), cur) as string)} /> : null}
        <Button kind={p.muted ? "secondary" : "ghost"} size="sm" label={p.muted ? "Muted" : "Mute"} onPress={() => p.onMute(!p.muted)} />
      </View>
    </View>
  );
  const drilled = Boolean(view && view.level !== "first");
  const root = (
    <View style={{ gap: 16 }}>
      {drilled ? null : hero}
      {tabs.length > 1 ? <Tabs items={tabs} value={cur} onChange={setTab} /> : null}
      {body0}
    </View>
  );

  const sub: Record<string, React.ReactNode> = {
    more,
    project: <ProjectPicker projects={p.project.projects} current={p.project.current} onPick={async (slug) => { if (moving.current) return; moving.current = true; const r = await p.project.move(slug); moving.current = false; if (r) setProblem(r); else { showToast(slug ? "Moved to the project." : "Taken out of the project."); back(); } }} onBack={() => p.onPage("root")} />,
    effort: <View>{EFFORTS.map((e, i) => <View key={e.label}>{i ? <Divider /> : null}<Row dense title={e.label} selected={(e.id ?? null) === (effort ?? null)} state={(e.id ?? null) === (effort ?? null) ? "Now" : undefined}
      onPress={() => { const was = effort; setEffort(e.id); void run(async () => { const r = await chatTools.effort(p.thread, e.id); if (!r.ok) setEffort(was); return r; }, () => back()); }} /></View>)}</View>,
    mode: <View>{modesOf(p.state?.modes).map((m, i) => <View key={m}>{i ? <Divider /> : null}<Row dense title={modeLabel(m)} selected={(mode || "default") === m} state={(mode || "default") === m ? "Now" : undefined}
      onPress={() => { const was = mode; setMode(m); void run(async () => { const r = await chatTools.mode(p.thread, m); if (!r.ok) setMode(was); return r; }, () => back()); }} /></View>)}</View>,
    tasks: <TasksPage thread={p.thread} />,
    context: <ContextPage thread={p.thread} project={p.projectSlug} cwd={p.cwd} />,
    transcript: <TranscriptPage thread={p.thread} />,
    back: p.projectSlug && p.session ? <BackPage project={p.projectSlug} session={p.session} /> : null,
    files: <ChatFiles chat={p.chat} />,
    file: p.file ? <View style={{ height: 640 }}><FileViewer name={p.file} source={driveSource(p.file)} onOpenInFiles={p.onOpenInFiles ? () => p.onOpenInFiles?.(p.file as string) : undefined} /></View> : null,
  };

  const head = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 56 }}>
      {p.page !== "root" ? <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={back} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20 }}><Icon name="chev-l" size={20} tone="text" /></Pressable> : null}
      <Text size="title" medium style={{ flex: 1 }} numberOfLines={1}>{p.page === "root" ? "" : p.page === "file" && p.file ? p.file.split("/").pop() : TITLES[p.page]}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={p.onClose} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20 }}><Icon name="x" size={18} tone="label" /></Pressable>
    </View>
  );
  const body = <View ref={box} style={{ gap: 8 }}>{head}{problem ? <Banner tone="warn">{problem}</Banner> : null}{p.page === "root" ? root : sub[p.page]}</View>;

  if (!p.open) return null;
  if (p.phone) return <Sheet open onClose={p.onClose} title={undefined}>{body}</Sheet>;
  // Beside the thread, not over it: the thread keeps its width minus the panel's, so nothing is cut off.
  return (
    <View accessibilityLabel="In this chat" style={{ width: p.page === "file" ? 520 : panelW.width, flexShrink: 0, backgroundColor: color["surface-2"], borderLeftWidth: 1, borderLeftColor: color.edge, paddingHorizontal: 16, paddingVertical: 0, ...(Platform.OS === "web" ? ({ overflowY: "auto" } as object) : {}) }}>{body}{p.page === "file" ? null : <ResizeHandle edge="left" label="Resize the panel" width={panelW.width} onChange={panelW.set} onReset={panelW.reset} min={RAIL.panelMin} max={RAIL.panelMax} def={RAIL.panelWidth} />}</View>
  );
}
