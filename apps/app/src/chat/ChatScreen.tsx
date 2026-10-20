// The chat screen: header (state and a Stop chip), the transcript (it follows the stream until the
// reader scrolls up, then a "jump to latest" pill), the queued messages, and the composer.
//
// Virtualised by the session transcript (src/session/Transcript.*): on the web a column-reverse
// scroller windowed by chat core window.js (above 100 rows only the rows near the viewport mount,
// spacers stand for the rest, heights are measured, the row at the top is the anchor), on native
// an inverted FlatList. FlashList is not installed, and RN-web's FlatList cannot anchor prepends,
// so the web path is the windowed scroller already measured at 10,000 rows (see perf/chat-perf.mjs).
//
// It reads the stream through useSessionStream, so the real core/stream client and the mock plug
// in the same way.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Banner, Button, Chip, Icon, Text, allowsMock, showToast, useUiTheme } from "@vyre/ui";
import { Transcript } from "../session/Transcript";
import type { TranscriptRow } from "../session/model";
import { ChatComposer, type ComposerProps } from "./ChatComposer";
import { peopleOnly } from "./composer-model.js";
import { useVyreFiles } from "./useVyreFiles";
import { GroupApprovals } from "../../screens/shell/GroupApprovals";
import { ChatRow, SkeletonThread, useMessageKeys } from "./ChatRows";
import { FlowDraftNote, useFlowDraft } from "./FlowDraftNote";
import { groupToolRuns } from "./tool-runs.js";
import type { BlockCtx } from "./Blocks";
import { createFollow, follow, pillLabel } from "./follow.js";
import type { StreamSource } from "./mock-stream";
import { useSessionStream, type PerfSink } from "./store";
import { ChatHeader } from "./ChatHeader";
import { chatKind, threadSub, threadsTab, titleFrom, untitledTitle } from "./threads-model.js";
import { agentThreads } from "./threads-source";
import { ForwardSheet } from "./ForwardSheet";
import { OriginBlock } from "./OriginBlock";
import { loadOrigin, sampleOrigin } from "./origin-history-source";
import { sampleAllowed, type OriginRow } from "./origin-history.js";
import { addToAgentThread, addToGroupChat, newThreadWith } from "./add-people";
import { callsFromItems, flowNameOf, afterMake } from "./make-flow-model.js";
import { callT } from "../real/call-tool";
import { chatTools } from "../../screens/chat-tools/instance";
import { openNewAgent } from "../../screens/chats/ChatsSidebar";
import { Face } from "./Face";
import { agentWords } from "../state/agent-name.js";
import { type AboutInfo } from "./AboutSheet";
import { ChatPanel, type PanelPage } from "./ChatPanel";
import { FileViewerSheet } from "../../screens/drive/FileViewerSheet";
import { useChatProject } from "./useChatProject";
import { chatPrefs, useChatPrefs } from "../state/chat-prefs";
import { SelectionAsk } from "./SelectionAsk";
import { StatusLine } from "./StatusLine";
import { addHighlight, chipLabel, makeHighlight, removeHighlight, withQuotes, type Highlight } from "./highlight.js";
import { markSealedNoteSeen, sealedNoteSeen, sealedNoteText } from "./group.js";
import { useRealComposer } from "./useRealComposer";
import { sampleGroups, sampleNow } from "../models/mock-models.js";
import { LinkSuggestion } from "../../screens/chat-tools/LinkSuggestion";
import { FilesPane } from "../../screens/chat-tools/FilesPane";
import { readDraft, writeDraft } from "./drafts";
import { addTeammateInput, addable } from "./group.js";
import { excerpt, jumpIndex } from "./reply.js";
import { ChatExtras } from "./ChatExtras";
import { LaterPlannerBar, useChatCapabilityChrome, useLaterPlanner } from "./ChatCapabilityChrome";
import { PreviewPane } from "./PreviewPane";
import { usePreviewPane } from "./previewPane";
import { MovedLines, PlacementSwitch, usePlacement } from "./placement";
import { chipOf } from "../../screens/runner/runner-model.js";
import { useChatMembers } from "./useChatMembers";
import { useChatKeyLease } from "./useChatKeyLease";
import { queueFrom } from "./extras.js";
import { tool } from "../real/box";
import { secureSecrets } from "./secure-paste.js";
import { whoOfChat } from "../../screens/chats/who-model.js";
import type { WhoKind } from "../../screens/chats/who-model.js";
import { openWho } from "../../screens/chats/who-open";
import { GIVE_UP_MS, idle as idleAwaiting, moved as movedAwaiting, refused as refusedAwaiting, sent as sentAwaiting, workingLine, type Awaiting } from "./working-model.js";
import { useAttachments } from "./useAttachments";
import { useAttachDrop } from "./useAttachDrop";
import { chipLine, defaultWords } from "./attach-model.js";
import { useNeeds } from "../state/needs";
import { heldFor } from "../state/held.js";
import { useRouter } from "expo-router";
import { useChats } from "../state/chats";
import { refresh } from "../state/live";
import { canFork } from "../../screens/chats/chats-model.js";
import { findLabel, findMatches, headerParts, keyAction, lastOwnMessage, stepMatch } from "./polish.js";
import { askedBefore, threadMay } from "./message-menu-model.js";

export type ChatScreenProps = {
  sessionId: string;
  title?: string;
  source?: StreamSource;
  perf?: PerfSink;
  onBack?: () => void;
  /** A branch was made: the new session's id (the screen opens it). */
  onBranched?: (thread: string) => void;
  /** Open the session's full terminal (the header button and a terminal block's own). */
  onOpenTerminal?: () => void;
  /** Under the header, above the transcript (the session's computer card). */
  belowHeader?: React.ReactNode;
  autoFocusComposer?: boolean;
  /** The name or avatar in the title was pressed: open that who's side pane (WhoPane). Without it the shell's registered opener is used, else the pane opens as a page. */
  onOpenWho?: (kind: WhoKind, id: string) => void;
  handlers?: Partial<BlockCtx>;
  composer?: Partial<ComposerProps>;
  onKey?: (t: number) => void;
  /** The person looking, as the stream names them ("person:alex"). */
  viewer?: string;
  /** What "About this chat" says besides the people: the record, the space, the sealed count, where it runs. */
  about?: Partial<AboutInfo>;
  /** Open "About this chat" at first (shots). */
  initialAbout?: boolean;
  /** The panel's tab when it opens first (the sample build's ?tab=computer, for a picture). */
  initialTab?: string;
  /** A Flow is one chat whose runs are its threads. */
  flow?: boolean;
  /** The sample world only: show a group (two people and two agents) for the design preview. */
  sampleGroup?: boolean;
  /** The sample world's fork: shows the forked-thread banner and reads its origin from sample frames (the demo route and the shots). */
  sampleFork?: boolean;
  /** Force the sealed note on or off (shots); by default it shows once per chat. */
  showSealedNote?: boolean;
  /** The project this chat is in, for the header (a name, never an id). */
  project?: string | null;
  /** Cmd-K: the place that switches chats. Cmd-1..9: open the nth chat of the list. */
  onSwitch?: () => void;
  onJumpSession?: (n: number) => void;
};

const storage = (): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null => {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
};

const parseName = (id: string) => id.slice(id.indexOf(":") + 1);

function JumpPill({ go, count, base, bottom }: { go: () => void; count: number; base: number; bottom: number }) {
  const { color } = useUiTheme();
  const s = follow(follow(createFollow(), { type: "scroll", atBottom: false }), { type: "rows", added: count - base });
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom, alignItems: "center", zIndex: 10, elevation: 10 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={pillLabel(s.unread)} onPress={go} style={{ minHeight: 40, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, borderRadius: 20, backgroundColor: color["surface-3"], borderWidth: 1, borderColor: color["edge-strong"] }}>
        <Text strong size="caption">{pillLabel(s.unread)}</Text>
        <Icon name="download" />
      </Pressable>
    </View>
  );
}

/** What the Turn this into a Flow button says to the assistant: it has the values of what it did, so it makes the draft (flows.from-chat) and says what is left to fill in. */
const TURN_INTO_FLOW = "Turn what you just did into a Flow: use flows.from-chat with the calls you made and their inputs, then tell me the draft name and what is left for me to fill in.";

export function ChatScreen(p: ChatScreenProps) {
  const { color, phone } = useUiTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { store, rows: layoutRows, meta, loading } = useSessionStream(p.sessionId, { source: p.source, perf: p.perf, viewer: p.viewer });
  // steps in a row are one folded line (tool-runs.js); the items behind them stay as they are
  // A message just sent: "Working on it" shows at once and ends with the turn (working-model.js). A refused send takes it back.
  const [awaiting, setAwaiting] = useState<Awaiting>(idleAwaiting);
  useEffect(() => { setAwaiting((a) => movedAwaiting(a, { busy: meta.busy, state: meta.state })); }, [meta.busy, meta.state]);
  useEffect(() => {
    if (!awaiting.on) return;
    const t = setTimeout(() => setAwaiting(idleAwaiting()), GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [awaiting.on]);
  // The skeleton is for a short wait only: a chat with no kept copy that has not opened in a few seconds says so, with Try again, never an endless skeleton.
  const [waited, setWaited] = useState<"" | "long">("");
  useEffect(() => {
    if (!loading) { setWaited(""); return; }
    const t = setTimeout(() => setWaited("long"), 8000);
    return () => clearTimeout(t);
  }, [loading]);
  const rows = useMemo(() => groupToolRuns(layoutRows, (k) => store.item(k)) as unknown as typeof layoutRows, [layoutRows, store]);
  const viewer = store.group.viewer;
  // Who is in this chat before the stream says, and the run's thread for the per-run controls (both from work.chat.get).
  const here = useChatMembers(p.sessionId, meta.busy);
  const placed = usePlacement(here.thread ?? p.sessionId, !allowsMock());
  const flowDraft = useFlowDraft();
  // Files added to the next message: picked, pasted or dropped, uploaded at once, and sent with the words.
  const att = useAttachments(allowsMock() ? undefined : p.sessionId);
  const vyre = useVyreFiles(att.add, att.addReady);
  useAttachDrop(att.add);
  useChatKeyLease(p.sessionId);
  // The names the stream's frames do not carry: the people and agents of the chat and its model slots.
  useEffect(() => { if (allowsMock()) return; if (here.me) store.group.setViewer(`person:${here.me}`); store.learnNames([...here.members.map((m) => ({ id: m.id, name: m.name })), ...here.slots]); }, [store, here.me, here.members, here.slots]);
  const realComposerOn = !allowsMock();
  const caps = useChatCapabilityChrome({
    chat: p.sessionId,
    store,
    faces: store.group.participants().map((f) => ({ id: f.id, name: f.name, family: f.family })),
    real: realComposerOn,
    onOpenPanel: (page) => setPanel(page),
  });
  const [note, setNote] = useState<string | null>(null);
  // A key in the message is on its way into the Vault: the label of the one being secured now.
  const [securing, setSecuring] = useState<string | null>(null);
  // One panel for everything about the chat; `panelPage` is the page it is on ("project" is what /move opens).
  const [panel, setPanel] = useState<PanelPage | null>(p.initialAbout ? "root" : null);
  const [forward, setForward] = useState<{ text: string } | null>(null);
  // A thread forked from another says so, and where the earlier part lives.
  const [forkedFrom, setForkedFrom] = useState<{ thread: string; title: string; message: string } | null>(null);
  const [originRows, setOriginRows] = useState<OriginRow[] | null>(null);
  const [originShown, setOriginShown] = useState(true);
  const forkAsThread = useRef(false);
  const threadRef = useRef("");
  const openThreadRef = useRef<(t: string) => void>(() => {});
  const [panelTab, setPanelTab] = useState<string>(p.initialTab ?? "");
  const toolsOpen = panel !== null;
  const chatProject = useChatProject(p.sessionId, p.project);
  // On a wide window the chat's files sit in a pane beside it (you keep working while it is open); on a phone they are a page of the tools sheet
  const [filesOpen, setFilesOpen] = useState(false);
  // the person's latest message, for "Link this chat to Northwind?"
  const lastUserText = useMemo(() => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === "user") return String(store.item(rows[i].key)?.text ?? ""); return ""; }, [rows, store]);
  // A mention picked in the tools sheet goes on the end of the draft; the composer reads the draft when it mounts, so a new key shows it.
  const [draftN, setDraftN] = useState(0);
  // The queued words come from the box when the sheet opens: Send now takes a row's id, which the stream's frames do not carry.
  const [queued, setQueued] = useState<{ queued: number; text: string }[]>([]);
  const [threadState, setThreadState] = useState<{ mode?: string | null; modes?: string[] | null; thinking?: boolean | null; effort?: string | null } | undefined>();
  useEffect(() => {
    const thread = here.thread ?? p.sessionId;
    if (!toolsOpen || allowsMock() || !thread) return;
    let live = true;
    tool<{ thread?: { mode?: string; effort?: string; thinking?: boolean; modes?: string[] } }>("threads.get", { thread, limit: 1 })
      .then((d) => {
        if (!live || !d?.thread) return;
        const t = d.thread;
        setThreadState({ mode: t.mode ?? null, effort: t.effort ?? null, thinking: typeof t.thinking === "boolean" ? t.thinking : null, modes: Array.isArray(t.modes) ? t.modes : null });
      })
      .catch(() => { if (live) setThreadState(undefined); });
    return () => { live = false; };
  }, [toolsOpen, here.thread, p.sessionId]);
  // What this chat's driver can do (threads.get: provider and caps): Retry, Edit and Rewind go back, Fork needs a fork. Until it is known, everything is offered.
  const [may, setMay] = useState(() => threadMay(null));
  useEffect(() => {
    const thread = here.thread ?? p.sessionId;
    if (allowsMock() || !thread) return;
    let live = true;
    tool<{ thread?: { provider?: string; caps?: unknown } }>("threads.get", { thread, limit: 1 }).then((d) => { if (live) setMay(threadMay(d?.thread)); }).catch(() => {});
    return () => { live = false; };
  }, [here.thread, p.sessionId]);
  useEffect(() => {
    if (!toolsOpen || allowsMock()) return;
    let live = true;
    tool("threads.queue", { thread: here.thread ?? p.sessionId }).then((d) => { if (live) setQueued(queueFrom(d)); }).catch(() => { if (live) setQueued([]); });
    return () => { live = false; };
  }, [toolsOpen, p.sessionId, here.thread]);
  const prefs = useChatPrefs();
  const muted = prefs.muted.includes(p.sessionId);
  const pinned = prefs.pinned.includes(p.sessionId);
  const chatRow = useChats().rows.find((c) => c.id === p.sessionId);
  const engineerChat = chatRow?.engineer === true;
  const noFork = !canFork(useChats().rows.find((c) => c.id === p.sessionId));
  const setMuted = (on: boolean) => chatPrefs.setMuted(p.sessionId, on);
  const setPinned = (on: boolean) => chatPrefs.setPinned(p.sessionId, on);
  const runsOn = placed.placement?.where === "mac" ? "mac" : placed.placement?.where === "server" ? "server" : (p.about?.runsOn ?? "server");
  const [replyTo, setReplyTo] = useState<{ message: string; name: string; text: string } | null>(null);
  // Tapping a quote goes to the original and lights it up for a moment.
  const [jump, setJump] = useState<{ key: string; n: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowKeys = useRef<string[]>([]);
  rowKeys.current = rows.map((r) => r.key);
  // The sealed note shows once per chat, on its first open. Storage can be missing or throw: then it shows again, never hides.
  const [sealedNote, setSealedNote] = useState(() => p.showSealedNote ?? !sealedNoteSeen(storage(), p.sessionId));
  useEffect(() => { if (sealedNote) markSealedNoteSeen(storage(), p.sessionId); }, [sealedNote, p.sessionId]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [editing, setEditing] = useState<{ id: number; uuid: string; text: string } | null>(null);
  // Find in this conversation (Cmd-F): the rows that hold the words, one at a time, the current one scrolled to and lit.
  const [findOpen, setFindOpen] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  // The thread's own width (the chat panel beside it takes some): a diff is side by side only when there is room for two columns.
  const [threadW, setThreadW] = useState(1000);
  const [findQ, setFindQ] = useState("");
  const [findAt, setFindAt] = useState(-1);
  const matches = useMemo(() => (findOpen ? findMatches(rows.filter((r) => r.kind === "user" || r.kind === "text").map((r) => ({ key: r.key, text: String(store.item(r.key)?.text ?? "") })), findQ) : []), [findOpen, findQ, rows, store]);
  const goMatch = useCallback((at: number) => {
    setFindAt(at);
    const m = matches[at];
    if (!m) return;
    setJump({ key: m.key, n: Date.now() });
    setFlash(m.key.slice(2));
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1800);
  }, [matches]);
  useEffect(() => { if (findOpen && matches.length) goMatch(0); else setFindAt(-1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [findQ, findOpen]);
  const actions = store.actions;
  const { onBranched } = p;
  const needs = useNeeds();
  const chatId = here.thread ?? p.sessionId;
  const later = useLaterPlanner();
  const [modelNudge, setModelNudge] = useState<"model" | null>(null);
  // The keyboard (12.3), on the web and the desktop windows: Cmd/Ctrl-F find, Esc stops (or closes find), Up in an empty composer edits the last message, Cmd-K switches, Cmd-1..9 open the nth chat.
  // Cmd-Enter (steer) is the composer's own. The decision is polish.js keyAction; this only reads the event and does the thing.
  const keyRef = useRef({ findOpen, busy: meta.busy, rows, store, actions: may.rewind ? actions : null, p, panel: panel !== null });
  keyRef.current = { findOpen, busy: meta.busy, rows, store, actions: may.rewind ? actions : null, p, panel: panel !== null };
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const k = keyRef.current;
      // The chat panel owns the keyboard while it is open (Esc goes back or closes it; it must not stop the running turn).
      if (k.panel) return;
      const el = document.activeElement as (HTMLElement & { value?: string }) | null;
      const typing = !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
      const last = k.actions ? lastOwnMessage(k.rows, (key) => k.store.item(key), (key) => k.store.group.isMine(key)) : null;
      const act = keyAction({ key: e.key, meta: e.metaKey || e.ctrlKey, shift: e.shiftKey, alt: e.altKey }, { composerEmpty: typing && el?.tagName === "TEXTAREA" && !el.value, busy: k.busy, findOpen: k.findOpen, canEdit: !!last });
      if (!act) return;
      if (act.do === "find") { e.preventDefault(); setFindOpen(true); }
      else if (act.do === "close-find") { e.preventDefault(); setFindOpen(false); setFindQ(""); }
      else if (act.do === "stop") { e.preventDefault(); void k.store.interrupt().then((why) => { if (why) setNote(why); }); }
      else if (act.do === "edit-last" && last) { e.preventDefault(); setNote(null); setEditing((x) => ({ id: (x?.id ?? 0) + 1, uuid: last.uuid, text: last.text })); }
      else if (act.do === "switch" && k.p.onSwitch) { e.preventDefault(); k.p.onSwitch(); }
      else if (act.do === "jump" && k.p.onJumpSession) { e.preventDefault(); k.p.onJumpSession(act.n); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useMessageKeys(panel !== null || findOpen);
  const sendRef = useRef<((text: string) => Promise<void>) | null>(null);
  // A chat with one other has no face or name on its messages; a group shows them when the sender changes.
  const solo = new Set([...store.group.participants(), ...(here.members ?? [])].filter((f) => f.id !== viewer).map((f) => f.id)).size <= 1;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const before = useCallback((key: string): string | null => {
    const list = rowsRef.current;
    for (let j = list.findIndex((r) => r.key === key) - 1; j >= 0; j--) { const kind = store.item(list[j].key)?.kind; if (kind === "user" || kind === "text") return list[j].key; }
    return null;
  }, [store]);
  const ctx = useMemo<BlockCtx>(
    () => ({
      wide: !phone,
      solo,
      before,
      diffSplit: !phone && threadW >= 560,
      hideVaultNames: Math.max(store.group.participants().filter((f) => f.family !== "assistant").length, (here.members ?? []).filter((f) => f.family !== "assistant").length) > 1,
      ...(actions
        ? {
            // Only what the chat's driver can do is offered (threadMay): a driver that cannot go back has no Edit, Retry or Rewind, one that cannot fork no Fork.
            ...(may.rewind ? {
              onEditMessage: (uuid: string, text: string) => { setNote(null); setEditing((e) => ({ id: (e?.id ?? 0) + 1, uuid, text })); },
              onRetryMessage: async (uuid: string) => { setNote(null); const r = await actions.retry!(uuid); if (!r.ok) setNote(r.reason); },
              onRewindTo: (uuid: string) => caps.api.rewindTo(uuid),
            } : {}),
            askedBefore: (uuid: string) => askedBefore(rowsRef.current, `a:${uuid}`, (k) => store.item(k), (k) => store.group.isMine(k))?.uuid ?? null,
            // A failed reply: go back and send the message again where the driver can, else send its words again.
            onTryAgain: async (key: string) => {
              setNote(null);
              const m = askedBefore(rowsRef.current, key, (k) => store.item(k), (k) => store.group.isMine(k));
              if (!m) { setNote("There is no message of yours to send again."); return; }
              if (may.rewind) { const r = await actions.retry!(m.uuid); if (!r.ok) setNote(r.reason); }
              else void sendRef.current?.(m.text);
            },
            ...((forkAsThread.current ? may.fork : may.branch) ? { onBranchFrom: async (uuid: string) => {
              setNote(null);
              // an agent chat forks as a new thread of the same agent (work.thread.fork); the new chat opens
              if (forkAsThread.current) { const f = await agentThreads.fork(threadRef.current, uuid); if ("problem" in f) setNote(f.problem); else openThreadRef.current(f.thread); return; }
              const r = await actions.branch!(uuid);
              if (!r.ok) setNote(r.reason);
              else if (r.thread) onBranched?.(r.thread);
            } } : {}),
            onSecondOpinion: (uuid: string) => caps.api.openSecondOpinion(uuid),
            onForward: (_uuid: string, text: string) => setForward({ text }),
            onSay: (text: string) => { void sendRef.current?.(text); },
          }
        : { ...(allowsMock() ? { onBranchFrom: async (uuid: string) => { if (forkAsThread.current) { const f = await agentThreads.fork(threadRef.current, uuid); if ("problem" in f) setNote(f.problem); else openThreadRef.current(f.thread); } } } : {}), onRewindTo: (uuid: string) => caps.api.rewindTo(uuid), onSecondOpinion: (uuid: string) => caps.api.openSecondOpinion(uuid), onForward: (_uuid: string, text: string) => setForward({ text }), onSay: (text: string) => { void sendRef.current?.(text); } }),
      // A draft that is a held send links to its item, where it is read in full, edited and sent.
      heldFor: (d: { subject?: string | null; body?: string }) => (allowsMock() ? null : heldFor(d, needs, chatId)),
      // after a turn that used several of Vyre tools: ask for a Flow that repeats them (the assistant makes the draft with flows.from-chat and says what is left for the person to fill in)
      onTurnIntoFlow: () => { void flowDraft.start(); void sendRef.current?.(TURN_INTO_FLOW); },
      onOpenHeld: (id: string) => router.push({ pathname: "/need/[id]", params: { id } }),
      // a cited field opens the record it was read from
      onOpenRecord: (urn: string) => router.push(`/u/record/${urn.split("/").pop()}` as never),
      onReplyTo: (message: string, name: string, text?: string) => setReplyTo({ message, name, text: text ?? "" }),
      flash,
      onJumpTo: (message: string) => {
        const at = jumpIndex(rowKeys.current, message);
        if (at < 0) return;
        setJump({ key: rowKeys.current[at], n: Date.now() });
        setFlash(message);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(null), 1800);
      },
      onHighlight: (o: { from: string; text: string; selected?: string; kind?: "message" | "terminal" }) => setHighlights((l) => addHighlight(l, makeHighlight(o))),
      onOpenFile: (path: string) => { if (phone) setViewing(path); else { setViewing(path); setPanel("file"); } },
      ...(p.onOpenTerminal ? { onOpenTerminal: () => p.onOpenTerminal?.() } : {}),
      ...p.handlers,
    }),
    [phone, threadW, p.handlers, p.onOpenTerminal, actions, onBranched, needs, chatId, router, store, here.members, caps.api, solo, before, may],
  );
  const onSend = useCallback(
    async (typed: string, o?: { to: string[]; fanout: boolean; mode?: "steer" | "queue"; mentions?: { kind: string; id: string; name: string }[] }) => {
      setNote(null);
      // A key in the words goes to the Vault first; what is sent holds a reference, so the assistant and the transcript never hold the value.
      const safe = await secureSecrets(typed, { list: async () => ((await tool<{ items?: { name: string }[] }>("vault.list")).items ?? []).map((i) => i.name), put: (input) => tool("vault.put", input), onSecuring: setSecuring });
      setSecuring(null);
      if ("error" in safe) { setNote(safe.error); return; }
      const sending = att.take();
      if (sending.waiting) { setNote("A file is still being added: send in a moment."); return; }
      const text = safe.text.trim() || (sending.attachments.length ? defaultWords(sending.attachments.length) : safe.text);
      if (editing && actions) {
        const r = await actions.editRetry!(editing.uuid, text);
        if (!r.ok) setNote(r.reason);
        else setEditing(null);
        return;
      }
      store.social.markRead(store.group.last); // sending says you have read everything above
      const parent = replyTo?.message;
      const quoted = replyTo;
      setReplyTo(null);
      // What the person highlighted is quoted into the message they send now, and the chips clear: nothing was sent before this.
      const body = withQuotes(text, highlights);
      setHighlights([]);
      setAwaiting(sentAwaiting(meta.state));
      const sendP = (o && (o.to.length || o.fanout)) || parent ? store.sendTo(body, { to: o?.to ?? [], fanout: o?.fanout ?? false, replyTo: quoted?.message, ...(o?.mode ? { mode: o.mode } : {}), ...(o?.mentions?.length ? { mentions: o.mentions } : {}), ...(sending.attachments.length ? { attachments: sending.attachments } : {}) }) : store.send(body, { ...(o?.mentions?.length ? { mentions: o.mentions } : {}), ...(o?.mode ? { mode: o.mode } : {}), ...(sending.attachments.length ? { attachments: sending.attachments } : {}) });
      // Your own message always brings the transcript to the newest row, even when you had scrolled up (the optimistic row is there already).
      { const last = store.rows()[store.rows().length - 1]; if (last) setJump((j) => ({ key: last.key, n: (j?.n ?? 0) + 1 })); }
      const why = await sendP;
      // A send the box did not take stays in the thread as "Not sent", with its reason, Retry and Delete (store.ts), so the composer lets go of it either way.
      att.clear();
      if (why) setAwaiting(refusedAwaiting());
      if (!why && /^\/later\b/i.test(body.trim())) later.noteFromSend(body.trim());
    },
    [store, editing, actions, replyTo, highlights, att, later, meta.state],
  );
  sendRef.current = (text: string) => onSend(text);
  // A thread is named from its first message (a short title, as chat apps do), never left as "New chat": once, when the chat has a first message and no title of its own.
  const titled = useRef(false);
  useEffect(() => {
    if (allowsMock() || loading || titled.current || !chatRow || !untitledTitle(chatRow.title) || chatRow.engineer || chatRow.pinned) return;
    const first = rows.find((r) => r.kind === "user");
    const t = first ? titleFrom(store.item(first.key)?.text) : "";
    if (!t) return;
    titled.current = true;
    void chatTools.rename(p.sessionId, t).then((r) => { if (r.ok) void refresh(); });
  }, [loading, rows, store, chatRow, p.sessionId]);
  const renderRow = useCallback((row: TranscriptRow) => <ChatRow store={store} row={row as never} ctx={ctx} />, [store, ctx]);
  const base = useRef(rows.length);
  base.current = Math.min(base.current, rows.length);

  const group = store.group;
  const found = group.participants();
  // Before the stream says who is here: a real chat asks the box (work.chat.get); only the sample world shows its sample people.
  const sample = [{ id: viewer, name: parseName(viewer), family: "person" as const }, { id: "assistant:juno", name: "juno", family: "assistant" as const },
    ...(p.sampleGroup ? [{ id: "per_sam", name: "Sam Reyes", family: "person" as const }, { id: "assistant:scout", name: "scout", family: "assistant" as const }] : [])];
  const faces = found.length ? found : allowsMock() ? sample : here.members;
  const viewerId = found.length || allowsMock() || !here.me ? viewer : `person:${here.me}`;
  const who = whoOfChat(faces, viewerId, p.sessionId);
  const info: AboutInfo = { record: null, sealed: 0, ...p.about, runsOn };
  // What kind of chat this is decides the side panel's tabs and what /threads opens.
  const others = faces.filter((f) => f.id !== viewerId);
  const agentNames = others.filter((f) => f.family === "assistant").map((f) => f.name);
  const kind = chatKind({ others, flow: p.flow });
  forkAsThread.current = kind === "agent"; threadRef.current = here.thread ?? p.sessionId;
  const agentForNote = kind === "agent" ? agentNames[0] : "";
  const thisThread = here.thread ?? p.sessionId;
  useEffect(() => {
    setForkedFrom(sampleAllowed(p.sampleFork, allowsMock()) ? { thread: "demo", message: "a1", title: "Fix the intake date check" } : null); setOriginRows(null);
    if (!agentForNote || allowsMock()) return;
    let live = true;
    void agentThreads.list(agentForNote).then((r) => {
      if (!live || !("rows" in r)) return;
      const me = r.rows.find((t) => t.id === thisThread);
      const from = me?.forkedFrom;
      if (from) setForkedFrom({ thread: from.thread, message: from.message, title: r.rows.find((t) => t.id === from.thread)?.title ?? "the original thread" });
    });
    return () => { live = false; };
  }, [agentForNote, thisThread]);
  // the fork's origin, read once: what it said up to the fork, or nothing when this device cannot open it
  useEffect(() => {
    if (!forkedFrom || (allowsMock() && !sampleAllowed(p.sampleFork, allowsMock()))) return;
    let live = true;
    void (sampleAllowed(p.sampleFork, allowsMock()) ? sampleOrigin() : loadOrigin(forkedFrom.thread, forkedFrom.message)).then((r) => { if (live) setOriginRows(r); });
    return () => { live = false; };
  }, [forkedFrom]);
  const togglePanel = () => { if (panel !== null) setPanel(null); else setPanel("root"); };
  const panelNow = useRef({ panel, toggle: togglePanel });
  panelNow.current = { panel, toggle: togglePanel };
  // Cmd . (or Ctrl .) opens and closes the side panel, as the name pill does.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "." && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) { e.preventDefault(); panelNow.current.toggle(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // /new starts a thread with this agent; /threads opens the tab that lists them; switching keeps the old ones saved.
  // A thread is a chat of the person and the agent, so opening one is opening that chat.
  const openThread = (thread: string) => { if (phone) setPanel(null); if (allowsMock()) { showToast("A thread opens as its own chat in a real Space."); return; } router.push({ pathname: "/u/chats/[id]", params: { id: thread } } as never); };
  openThreadRef.current = openThread;
  const newThread = async (agent: string): Promise<string | null> => { const r = await agentThreads.start(agent); if ("problem" in r) return r.problem; openThread(r.thread); return null; };
  const answering = faces.filter((f) => f.family === "assistant" || f.family === "model").map((f) => f.name);
  const head = headerParts({ title: p.title, project: chatProject.current?.name ?? p.project ?? info.record?.title ?? null, space: info.space ?? null, answeredBy: answering, where: allowsMock() ? null : here.where });
  // an agent chat is said by the agent's name as a person reads it ("Engineer", never "engineer"); the thread's own title follows only when it has one
  const agentTitle = kind === "agent" && agentNames[0] ? agentWords(agentNames[0]) : "";
  const assistantsHere = faces.filter((f) => f.family === "assistant").length;
  // The sealed note speaks of the AI in the chat: with none here (a chat between people) it stays away until one joins or is asked.
  const aiHere = faces.filter((f) => f.family === "assistant" || f.family === "model").length;
  // Who is in the chat, for the composer's @ list and the model chips: the stream's participants once it has said, else the chat's members from the box (work.chat.get), never the viewer.
  const roster = faces.filter((f) => f.id !== viewerId && f.id !== viewer).map((f) => ({ name: f.name, family: f.family === "assistant" ? ("assistant" as const) : ("person" as const) }));
  const realComposer = useRealComposer(p.sessionId, roster.length ? roster : undefined, viewer, setNote);
  // A chat with several assistants or models: one chip each, to switch that slot's model.
  const slots = found.length
    ? found.filter((f) => f.id !== viewer && (f.family === "assistant" || f.family === "model")).map((f) => ({ id: f.id, label: f.name, provider: (f as { provider?: string | null }).provider ?? null }))
    : allowsMock() ? [] : here.slots.map((x) => ({ id: x.id, label: x.name, provider: null as string | null }));
  // The AIs that can answer: the stream's, else the chat's slots, else the chat's assistants (juno), and in the sample world the person's accounts as well (Claude, Codex, Grok).
  const answerSlots = slots.length ? slots : [
    ...faces.filter((f) => f.family === "assistant" || f.family === "model").map((f) => ({ id: f.id, label: f.name, provider: null as string | null })),
    ...(allowsMock() ? [{ id: "slot:claude", label: "Claude", provider: "claude" }, { id: "slot:codex", label: "Codex", provider: "codex" }, { id: "slot:grok", label: "Grok", provider: "grok" }] : []),
  ];
  const people = found.length ? found.filter((f) => f.id !== viewer).map((f) => ({ name: f.name, family: f.family === "assistant" ? ("assistant" as const) : ("person" as const) })) : undefined;
  const sharedChat = Math.max(found.filter((f) => f.family !== "assistant").length, (here.members ?? []).filter((f) => f.family !== "assistant").length) > 1;
  // A chat between people: a message goes to the people and no AI answers unless one is asked for it (reply mode "mention", or no AI in the chat).
  const peopleChat = peopleOnly({ shared: sharedChat, replyMode: store.group.replyMode(), ais: faces.filter((f) => f.family === "assistant" || f.family === "model").length });
  const startOthers = faces.filter((f) => f.id !== viewerId);
  const startLone = startOthers.length === 1 ? startOthers[0] : null;
  const paneOpen = usePreviewPane();
  const panelEl = (
    <ChatPanel
        open={panel !== null} onClose={() => setPanel(null)} phone={phone} page={panel ?? "root"} onPage={setPanel} tab={panelTab} onTab={setPanelTab} flow={p.flow} onNewThread={newThread} onSwitchThread={openThread} title={head.title}
        participants={found.length ? found : faces.map((f) => ({ ...f, family: f.family as "person" | "assistant" }))} viewer={viewerId} info={info}
        muted={muted} pinned={pinned} onMute={setMuted} onPin={setPinned} onFind={() => setFindOpen(true)} onMove={() => { const to = runsOn === "mac" ? "server" : "mac"; void placed.move(to); }} onOpenTerminal={p.onOpenTerminal}
        addable={realComposer ? addable(realComposer.people, found) : undefined}
        onAdd={realComposer ? async (who) => {
          // a thread with an agent moves into the chat of exactly those people; a one-to-one chat gets a new thread in the chat of exactly that set; a group just gains them
          if (kind === "agent" && who.family !== "assistant") return addToAgentThread(here.thread ?? p.sessionId, [String(who.id ?? who.name)]);
          if (kind === "person" && who.family !== "assistant") { const r = await newThreadWith([...others.filter((f) => f.family !== "assistant").map((f) => f.id), String(who.id ?? who.name)]); if ("say" in r) return r.say; openThreadRef.current(r.thread); return null; }
          if (kind === "group" && who.family !== "assistant") return addToGroupChat(here.thread ?? p.sessionId, [String(who.id ?? who.name)]);
          try { await tool("work.chat.change", addTeammateInput(p.sessionId, who)); return null; } catch (e) { return e instanceof Error && e.message ? e.message : "That did not go through."; }
        } : undefined}
        project={chatProject} file={viewing} onOpenInFiles={() => router.push("/u/files" as never)}
        onLinkRecord={() => { const d = readDraft(p.sessionId); writeDraft(p.sessionId, d && !/\s$/.test(d) ? `${d} #` : `${d}#`); setDraftN((n) => n + 1); }}
        shared={sharedChat} replyMode={store.group.replyMode()}
        thread={here.thread ?? p.sessionId} chat={p.sessionId} session={here.thread ?? p.sessionId} queued={queued} noFork={noFork} onForked={p.onBranched} otherPlace={chipOf(placed.placement)?.moveTo ?? null}
        away={here.away} state={threadState} projectSlug={chatProject.current?.slug ?? null}
        onOpenFiles={phone ? undefined : () => setFilesOpen(true)}
        onMemory={() => { setPanel(null); router.push("/u/memory" as never); }}
        onExport={() => { void onSend("/export"); showToast("Export started in the chat."); }}
        onRoll={() => { void onSend("/roll"); }}
      />
  );
  const body = (
    <View onLayout={(e) => { const w = Math.round(e.nativeEvent.layout.width); setThreadW((o) => (Math.abs(o - w) > 8 ? w : o)); }} style={{ flex: 1, backgroundColor: color["surface-1"], paddingTop: insets.top }}>
      <ChatHeader title={agentTitle || head.title} sub={agentTitle ? threadSub(head.title, agentNames[0]) : undefined} onOpenWho={who ? () => (p.onOpenWho ?? ((k: WhoKind, i: string) => openWho(k, i, (path) => router.push(path as never))))(who.kind, who.id) : undefined} participants={faces} viewer={viewerId} phone={phone} onBack={p.onBack} onOpen={togglePanel} project={chatProject.current && chatProject.current.slug !== "general" ? chatProject.current : null}
        place={<PlacementSwitch placement={placed.placement} onMove={(to) => void placed.move(to)} />}
        menu={[
          { label: "Details", onPress: () => { setPanelTab("details"); setPanel("root"); } },
          { label: "Library", onPress: () => { setPanelTab("library"); setPanel("root"); } },
          ...(faces.some((f) => f.family === "assistant" && f.id !== viewerId) ? [{ label: "Computer", onPress: () => { setPanelTab("computer"); setPanel("root"); } }] : []),
          ...(kind === "agent" ? [{ label: "Make a Flow from this chat", onPress: () => void makeFlow() }] : []),
          { label: "Move to a project", onPress: () => setPanel("project") },
          { label: "Find in this conversation", onPress: () => setFindOpen(true) },
          { label: pinned ? "Unpin" : "Pin", onPress: () => setPinned(!pinned) },
          { label: muted ? "Unmute" : "Mute", onPress: () => setMuted(!muted) },
        ]} />
      <FileViewerSheet path={phone ? viewing : null} onClose={() => setViewing(null)} onOpenInFiles={() => { setViewing(null); router.push("/u/files" as never); }} />
      <SelectionAsk onAsk={(t, from) => setHighlights((l) => addHighlight(l, makeHighlight({ from: from || "this chat", text: t, selected: t, kind: "message" })))} />
      {p.belowHeader}
      {forkedFrom ? <View style={{ paddingHorizontal: phone ? 12 : 24, paddingBottom: 6 }}><Banner><View style={{ gap: 4, alignItems: "flex-start" }}><Text>{`Forked from ${forkedFrom.title}. Everything up to that point is in the original.`}</Text><Button kind="ghost" size="sm" label="Open the original" onPress={() => openThread(forkedFrom.thread)} /></View></Banner></View> : null}
      {forkedFrom && originRows && originShown ? <OriginBlock rows={originRows} title={forkedFrom.title} phone={phone} onHide={() => setOriginShown(false)} /> : null}

      <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
      <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      {findOpen ? (
        <View accessibilityLabel="Find in this conversation" style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: phone ? 12 : 20, borderBottomWidth: 1, borderBottomColor: color.edge, backgroundColor: color["surface-2"] }}>
          <Icon name="search" tone="label" />
          <TextInput
            autoFocus
            value={findQ}
            onChangeText={setFindQ}
            placeholder="Find in this conversation"
            placeholderTextColor={color.label}
            accessibilityLabel="Find"
            onKeyPress={(e: any) => { if (e.nativeEvent.key === "Enter") { e.preventDefault?.(); goMatch(stepMatch(findAt, e.nativeEvent.shiftKey ? -1 : 1, matches.length)); } }}
            style={{ flex: 1, color: color.text, fontSize: 15, minHeight: 32, outlineStyle: "none" } as never}
          />
          <Text size="caption" tone="label">{findLabel(findAt, matches.length, findQ)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous match" onPress={() => goMatch(stepMatch(findAt, -1, matches.length))} style={{ minHeight: 32, minWidth: 32, alignItems: "center", justifyContent: "center" }}><Icon name="chev-l" tone="label" /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Next match" onPress={() => goMatch(stepMatch(findAt, 1, matches.length))} style={{ minHeight: 32, minWidth: 32, alignItems: "center", justifyContent: "center" }}><Icon name="chev-r" tone="label" /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Close find" onPress={() => { setFindOpen(false); setFindQ(""); }} style={{ minHeight: 32, minWidth: 32, alignItems: "center", justifyContent: "center" }}><Icon name="x" tone="label" /></Pressable>
        </View>
      ) : null}

      <View style={{ flex: 1, minHeight: 0 }}>
        {loading && waited === "long" ? (
          <View accessibilityRole="alert" style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 24 }}>
            <Text tone="muted" style={{ textAlign: "center" }}>This chat is taking too long to open.</Text>
            <Button kind="primary" size="sm" label="Try again" onPress={() => { setWaited(""); store.stop(); store.start(); }} />
          </View>
        ) : loading ? (
          <SkeletonThread wide={!phone} />
        ) : (
          <Transcript
            rows={rows as unknown as TranscriptRow[]}
            renderRow={renderRow}
            hasMore={false}
            onNearTop={() => {}}
            head={<View style={{ width: "100%", maxWidth: 760, alignSelf: "center", marginLeft: "auto", marginRight: "auto", paddingHorizontal: phone ? 16 : 24 }}>
              {/* The start of the chat: who it is with, once, at the top of the history. */}
              <View style={{ alignItems: "center", gap: 8, paddingTop: 32, paddingBottom: 16 }}>
                {startLone ? <Face name={startLone.name} family={startLone.family === "assistant" ? "assistant" : startLone.family === "model" ? "model" : "person"} size={40} id={startLone.id} /> : null}
                <Text medium>{agentTitle || head.title}</Text>
                <Text size="caption" tone="label">{chatProject.current && chatProject.current.slug !== "general" ? chatProject.current.name : "The start of this chat"}</Text>
                {/* Who reads a shared agent chat: a calm notice in the opening, in the message column, not a loose line under the header. */}
                {engineerChat ? <Text size="caption" tone="label" style={{ textAlign: "center", paddingTop: 4 }}>Everyone who can use the Engineer reads this chat.</Text> : null}
              </View>
              {sealedNote && aiHere > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="Dismiss the sealed note" onPress={() => setSealedNote(false)} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 8, borderRadius: 12, backgroundColor: color["surface-3"] }}>
                <Icon name="shield" />
                <Text size="caption" tone="muted" style={{ flex: 1 }}>{sealedNoteText({ sealed: info.sealed, assistants: assistantsHere })}</Text>
                <Text size="caption" tone="label" medium>Got it</Text>
              </Pressable> : null}
              <View style={{ height: 8 }} />
            </View>}
            jumpTo={jump}
            jump={(go) => <JumpPill go={go} count={rows.length} base={base.current} bottom={16} />}
          />
        )}
      </View>

      {meta.queue.length ? (
        <View accessibilityLabel="Queued messages" style={{ width: "100%", maxWidth: 760, alignSelf: "center", marginLeft: "auto", marginRight: "auto", paddingHorizontal: phone ? 16 : 24, gap: 4, paddingTop: 6, alignItems: "flex-start" }}>
          {meta.queue.map((q) => <Chip key={q.key} icon="clock">{`Queued: ${q.text.length > 60 ? `${q.text.slice(0, 59)}…` : q.text}`}</Chip>)}
        </View>
      ) : null}

      {securing ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: phone ? 16 : 24, paddingTop: 6 }}>
          <Chip tone="ok" icon="shield">{`Securing your ${securing} in the Vault`}</Chip>
        </View>
      ) : null}
      {note ? (
        <View accessibilityRole="alert" style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: phone ? 16 : 24, paddingTop: 6 }}>
          <Text size="caption" tone="muted">{note}</Text>
        </View>
      ) : null}

      <StatusLine
        starting={placed.starting}
        presence={group.presenceLine()}
        state={meta.state}
        busy={meta.busy}
        canStop={meta.canStop}
        stopping={meta.stopping}
        working={workingLine({ busy: meta.busy, connection: meta.connection, awaiting: awaiting.on })}
        offline={meta.connection === "offline" && meta.saved}
        phone={phone}
        onStop={async () => { const why = await store.interrupt(); if (why) setNote(why); }}
      />

      {replyTo ? (
        <View accessibilityLabel="Replying to a message" style={{ width: "100%", maxWidth: 760, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: phone ? 16 : 24 }}>
          <Icon name="chat" />
          <View style={{ flex: 1, minWidth: 0, borderLeftWidth: 3, borderLeftColor: color.accent, paddingLeft: 8 }}><Text size="caption" strong tone="accent" numberOfLines={1}>{`Replying to ${replyTo.name}`}</Text>{replyTo.text ? <Text size="caption" tone="muted" numberOfLines={1}>{excerpt(replyTo.text)}</Text> : null}</View>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" onPress={() => setReplyTo(null)} style={{ minHeight: phone ? 44 : 32, minWidth: 44, alignItems: "center", justifyContent: "center" }}><Icon name="x" /></Pressable>
        </View>
      ) : null}

      {highlights.length ? (
        <View accessibilityLabel="Highlighted for the agent" style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: phone ? 12 : 20, paddingTop: 6, gap: 6 }}>
          {highlights.map((h) => (
            <View key={h.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: phone ? 44 : 36, paddingLeft: 12, borderRadius: 12, borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"] }}>
              <Icon name="chat" tone="label" />
              <Text size="caption" numberOfLines={1} style={{ flex: 1 }}>{chipLabel(h)}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove highlight: ${chipLabel(h)}`} onPress={() => setHighlights((l) => removeHighlight(l, h.id))} style={{ minHeight: phone ? 44 : 36, minWidth: phone ? 44 : 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 }}><Text size="caption" strong>Remove</Text></Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {realComposer ? <GroupApprovals /> : null}
      {realComposer ? <LinkSuggestion chat={p.sessionId} text={lastUserText} /> : null}
      <MovedLines lines={placed.lines} />
      <FlowDraftNote s={flowDraft.s} onClear={flowDraft.clear} />
      <LaterPlannerBar s={later.s} onClear={later.clear} />
      {caps.ui}
      <ChatExtras thread={p.sessionId} empty={!loading && rows.length === 0} busy={meta.busy} />
      <View style={{ paddingBottom: insets.bottom }}>
        <ChatComposer
          agentName={kind === "agent" && agentNames[0] ? agentWords(agentNames[0]) : undefined}
          onRename={async (name) => { const r = await chatTools.rename(here.thread ?? p.sessionId, name); if (r.ok) { showToast("Renamed."); return null; } showToast(r.reason); return r.reason; }}
          key={draftN}
          draftKey={p.sessionId}
          state={meta.state}
          phone={phone}
          autoFocus={p.autoFocusComposer}
          onKey={p.onKey}
          onSend={onSend}
          groupChat={sharedChat}
          canStop={meta.canStop}
          stopping={meta.stopping}
          onStop={async () => { const why = await store.interrupt(); if (why) setNote(why); }}
          onTyping={() => store.typing()}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          people={realComposer ? realComposer.people : people ?? (allowsMock() ? [{ name: "juno", family: "assistant", doing: "Waiting on your answer" }, { name: "kit", family: "assistant", doing: "Working on Northwind Bakery" }, { name: "alex", family: "person" }, { name: "Dana Okafor", family: "person" }] : [])}
          records={realComposer ? realComposer.records : allowsMock() ? [{ name: "Northwind Bakery", type: "Matter", sealed: 1 }, { name: "Juniper Studio intake", type: "Project", sealed: 0 }, { name: "Okafor estate", type: "Matter", sealed: 2 }] : []}
          models={realComposer ? realComposer.models : allowsMock() ? sampleGroups() : null}
          model={realComposer ? realComposer.model : sampleNow()}
          onModel={realComposer?.onModel}
          effort={realComposer?.effort}
          onEffort={realComposer?.onEffort}
          slots={answerSlots}
          peopleOnly={peopleChat}
          onLocalCommand={(name) => {
            if (name === "rename") { const d = readDraft(p.sessionId); writeDraft(p.sessionId, d?.trim() ? d : "/rename "); setDraftN((n) => n + 1); return true; }
            if (name === "threads") { const t = threadsTab(kind, agentNames, panelTab); if (!t) return false; setPanelTab(t); setPanel("root"); return true; }
            if (name === "new") { if (kind !== "agent" || !agentNames[0]) return false; void newThread(agentNames[0]).then((why) => { if (why) showToast(why); else { setPanelTab("threads"); setPanel("root"); } }); return true; }
            if (name === "fork") { showToast("Use Fork from here on a message of the agent."); return true; }
            if (name === "fresh") { void onSend("/roll"); return true; }
            if (name === "where") { setPanel("more"); return true; }
            if (name === "flow") { router.push("/u/flows" as never); return true; }
            if (name === "agent") { openNewAgent(router); return true; }
            if (name === "move") { setPanel("project"); return true; }
            if (name === "rewind") { caps.api.openRewind(); return true; }
            if (name === "find") { setFindOpen(true); return true; }
            if (name === "model") { setModelNudge("model"); setTimeout(() => setModelNudge(null), 0); return true; }
            if (name === "undo") { if (chatProject.current?.slug) setPanel("back"); return !!chatProject.current?.slug; }
            if (name === "goal") { const d = readDraft(p.sessionId); writeDraft(p.sessionId, d?.trim() ? `${d} /goal ` : "/goal "); setDraftN((n) => n + 1); return true; }
            if (name === "memory") { router.push("/u/memory" as never); return true; }
            if (name === "skills") { router.push("/u/skills" as never); return true; }
            return false;
          }}
          onMenuCapability={(id) => {
            if (id === "export") void onSend("/export");
            else if (id === "memory") router.push("/u/memory" as never);
            else if (id === "roll") void onSend("/roll");
            else if (id === "later") { const d = readDraft(p.sessionId); writeDraft(p.sessionId, d?.trim() ? `${d} /later ` : "/later "); setDraftN((n) => n + 1); }
            else if (id === "find") setFindOpen(true);
          }}
          localNudge={modelNudge}
          runsOn={placed.placement ? runsOn : undefined}
          onRunsOn={placed.placement ? () => { const to = runsOn === "mac" ? "server" : "mac"; void placed.move(to); } : undefined}
          attachments={att.chips.map((c) => ({ key: c.key, name: c.name, line: chipLine(c), state: c.state, thumb: c.thumb }))}
          onRemoveAttachment={att.remove}
          attachProblem={att.problem}
          onAttachFile={() => void att.choose(false)}
          vyreFiles={vyre.files}
          onAttachVyreFile={(id) => void vyre.pick(id)}
          {...p.composer}
        />
      </View>
      </View>
      {filesOpen && !phone ? <FilesPane chat={p.sessionId} onClose={() => setFilesOpen(false)} /> : null}
      </View>
    </View>
  );
  // A preview open in Vyre: a column beside the chat on a computer, a full-screen sheet on a phone.
  const main = paneOpen && !phone ? <View style={{ flex: 1, flexDirection: "row" }}><View style={{ flex: 1, minWidth: 0 }}>{body}</View><PreviewPane phone={false} /></View> : <>{body}<PreviewPane phone={phone} /></>;
  // On a wide screen the chat panel sits beside the thread (it pushes it over); on a phone it is a sheet.
  // "Make a Flow from this chat": the Vyre tools the assistant called here become the calls of a draft Flow, and its page opens.
  const makeFlow = async () => {
    const calls = callsFromItems(layoutRows.filter((r) => r.kind === "tool").map((r) => store.item(r.key)));
    if (!calls.length) { showToast("There is nothing here yet that a Flow could repeat."); return; }
    const r = await callT<any>("flows.from-chat", { name: flowNameOf(head.title), calls, chat: here.thread ?? p.sessionId });
    const out = afterMake(r.error ? { ok: false, errors: [{ message: r.error.message }] } : r.data);
    if ("open" in out) router.push(out.open as never); else showToast(out.say);
  };
  const forwardEl = <ForwardSheet open={forward !== null} text={forward?.text ?? ""} from={head.title} onClose={() => setForward(null)} />;
  return phone ? <>{main}{panelEl}{forwardEl}</> : <View style={{ flex: 1, flexDirection: "row" }}><View style={{ flex: 1, minWidth: 0 }}>{main}</View>{panelEl}{forwardEl}</View>;
}
