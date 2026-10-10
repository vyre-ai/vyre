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
import { Chip, Icon, Text, allowsMock, useUiTheme } from "@vyre/ui";
import { Transcript } from "../session/Transcript";
import type { TranscriptRow } from "../session/model";
import { ChatComposer, type ComposerProps } from "./ChatComposer";
import { GroupApprovals } from "../../screens/shell/GroupApprovals";
import { ChatRow, SkeletonThread } from "./ChatRows";
import { FlowDraftNote, useFlowDraft } from "./FlowDraftNote";
import { groupToolRuns } from "./tool-runs.js";
import type { BlockCtx } from "./Blocks";
import { createFollow, follow, pillLabel } from "./follow.js";
import type { StreamSource } from "./mock-stream";
import { useSessionStream, type PerfSink } from "./store";
import { ChatHeader } from "./ChatHeader";
import { AboutSheet, type AboutInfo } from "./AboutSheet";
import { SelectionAsk } from "./SelectionAsk";
import { StatusLine } from "./StatusLine";
import { addHighlight, chipLabel, makeHighlight, removeHighlight, withQuotes, type Highlight } from "./highlight.js";
import { markSealedNoteSeen, sealedNoteSeen, sealedNoteText } from "./group.js";
import { useRealComposer } from "./useRealComposer";
import { ChatToolsSheet } from "../../screens/chat-tools";
import { LinkSuggestion } from "../../screens/chat-tools/LinkSuggestion";
import { FilesPane } from "../../screens/chat-tools/FilesPane";
import { readDraft, writeDraft } from "./drafts";
import { addTeammateInput, addable } from "./group.js";
import { excerpt, jumpIndex } from "./reply.js";
import { ChatExtras } from "./ChatExtras";
import { PreviewPane } from "./PreviewPane";
import { usePreviewPane } from "./previewPane";
import { MovedLines, PlacementChip, usePlacement } from "./placement";
import { useChatMembers } from "./useChatMembers";
import { useChatKeyLease } from "./useChatKeyLease";
import { queueFrom } from "./extras.js";
import { tool } from "../real/box";
import { secureSecrets } from "./secure-paste.js";
import { useAttachments } from "./useAttachments";
import { useAttachDrop } from "./useAttachDrop";
import { chipLine, defaultWords } from "./attach-model.js";
import { useNeeds } from "../state/needs";
import { heldFor } from "../state/held.js";
import { useRouter } from "expo-router";
import { findLabel, findMatches, headerParts, keyAction, lastOwnMessage, stepMatch } from "./polish.js";

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
  handlers?: Partial<BlockCtx>;
  composer?: Partial<ComposerProps>;
  onKey?: (t: number) => void;
  /** The person looking, as the stream names them ("person:alex"). */
  viewer?: string;
  /** What "About this chat" says besides the people: the record, the space, the sealed count, where it runs. */
  about?: Partial<AboutInfo>;
  /** Open "About this chat" at first (shots). */
  initialAbout?: boolean;
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
  const insets = useSafeAreaInsets();
  const { store, rows: layoutRows, meta, loading } = useSessionStream(p.sessionId, { source: p.source, perf: p.perf, viewer: p.viewer });
  // steps in a row are one folded line (tool-runs.js); the items behind them stay as they are
  const rows = useMemo(() => groupToolRuns(layoutRows, (k) => store.item(k)) as unknown as typeof layoutRows, [layoutRows, store]);
  const viewer = store.group.viewer;
  // Who is in this chat before the stream says, and the run's thread for the per-run controls (both from work.chat.get).
  const here = useChatMembers(p.sessionId, meta.busy);
  const placed = usePlacement(p.sessionId, !allowsMock());
  const flowDraft = useFlowDraft();
  // Files added to the next message: picked, pasted or dropped, uploaded at once, and sent with the words.
  const att = useAttachments(allowsMock() ? undefined : p.sessionId);
  useAttachDrop(att.add);
  useChatKeyLease(p.sessionId);
  // The names the stream's frames do not carry: the people and agents of the chat and its model slots.
  useEffect(() => { if (allowsMock()) return; if (here.me) store.group.setViewer(`person:${here.me}`); store.learnNames([...here.members.map((m) => ({ id: m.id, name: m.name })), ...here.slots]); }, [store, here.me, here.members, here.slots]);
  const [note, setNote] = useState<string | null>(null);
  // A key in the message is on its way into the Vault: the label of the one being secured now.
  const [securing, setSecuring] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(!!p.initialAbout);
  const [toolsOpen, setToolsOpen] = useState(false);
  // On a wide window the chat's files sit in a pane beside it (you keep working while it is open); on a phone they are a page of the tools sheet
  const [filesOpen, setFilesOpen] = useState(false);
  // the person's latest message, for "Link this chat to Northwind?"
  const lastUserText = useMemo(() => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === "user") return String(store.item(rows[i].key)?.text ?? ""); return ""; }, [rows, store]);
  // A mention picked in the tools sheet goes on the end of the draft; the composer reads the draft when it mounts, so a new key shows it.
  const [draftN, setDraftN] = useState(0);
  // The queued words come from the box when the sheet opens: Send now takes a row's id, which the stream's frames do not carry.
  const [queued, setQueued] = useState<{ queued: number; text: string }[]>([]);
  useEffect(() => {
    if (!toolsOpen || allowsMock()) return;
    let live = true;
    tool("threads.queue", { thread: here.thread ?? p.sessionId }).then((d) => { if (live) setQueued(queueFrom(d)); }).catch(() => { if (live) setQueued([]); });
    return () => { live = false; };
  }, [toolsOpen, p.sessionId, here.thread]);
  const [muted, setMuted] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [runsOn, setRunsOn] = useState<"mac" | "server">(p.about?.runsOn ?? "server");
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
  const router = useRouter();
  const chatId = here.thread ?? p.sessionId;
  // The keyboard (12.3), on the web and the desktop windows: Cmd/Ctrl-F find, Esc stops (or closes find), Up in an empty composer edits the last message, Cmd-K switches, Cmd-1..9 open the nth chat.
  // Cmd-Enter (steer) is the composer's own. The decision is polish.js keyAction; this only reads the event and does the thing.
  const keyRef = useRef({ findOpen, busy: meta.busy, rows, store, actions, p });
  keyRef.current = { findOpen, busy: meta.busy, rows, store, actions, p };
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const k = keyRef.current;
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
  const sendRef = useRef<((text: string) => Promise<void>) | null>(null);
  const ctx = useMemo<BlockCtx>(
    () => ({
      wide: !phone,
      ...(actions
        ? {
            onEditMessage: (uuid: string, text: string) => { setNote(null); setEditing((e) => ({ id: (e?.id ?? 0) + 1, uuid, text })); },
            onRetryMessage: async (uuid: string) => { setNote(null); const r = await actions.retry!(uuid); if (!r.ok) setNote(r.reason); },
            onBranchFrom: async (uuid: string) => {
              setNote(null);
              const r = await actions.branch!(uuid);
              if (!r.ok) setNote(r.reason);
              else if (r.thread) onBranched?.(r.thread);
            },
          }
        : {}),
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
      ...(p.onOpenTerminal ? { onOpenTerminal: () => p.onOpenTerminal?.() } : {}),
      ...p.handlers,
    }),
    [phone, p.handlers, p.onOpenTerminal, actions, onBranched, needs, chatId, router],
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
      const why = (o && (o.to.length || o.fanout)) || parent ? await store.sendTo(body, { to: o?.to ?? [], fanout: o?.fanout ?? false, replyTo: quoted?.message, ...(o?.mode ? { mode: o.mode } : {}), ...(o?.mentions?.length ? { mentions: o.mentions } : {}), ...(sending.attachments.length ? { attachments: sending.attachments } : {}) }) : await store.send(body, { ...(o?.mentions?.length ? { mentions: o.mentions } : {}), ...(o?.mode ? { mode: o.mode } : {}), ...(sending.attachments.length ? { attachments: sending.attachments } : {}) });
      if (why) setNote(why); else att.clear();
    },
    [store, editing, actions, replyTo, highlights, att],
  );
  sendRef.current = (text: string) => onSend(text);
  const renderRow = useCallback((row: TranscriptRow) => <ChatRow store={store} row={row as never} ctx={ctx} />, [store, ctx]);
  const base = useRef(rows.length);
  base.current = Math.min(base.current, rows.length);

  const group = store.group;
  const found = group.participants();
  // Before the stream says who is here: a real chat asks the box (work.chat.get); only the sample world shows its sample people.
  const sample = [{ id: viewer, name: parseName(viewer), family: "person" as const }, { id: "assistant:juno", name: "juno", family: "assistant" as const }];
  const faces = found.length ? found : allowsMock() ? sample : here.members;
  const viewerId = found.length || allowsMock() || !here.me ? viewer : `person:${here.me}`;
  const info: AboutInfo = { record: null, sealed: 0, ...p.about, runsOn };
  const answering = faces.filter((f) => f.family === "assistant" || f.family === "model").map((f) => f.name);
  const head = headerParts({ title: p.title, project: p.project ?? info.record?.title ?? null, space: info.space ?? null, answeredBy: answering, where: allowsMock() ? null : here.where });
  const line = head.line + (muted ? (head.line ? " · muted" : "muted") : "");
  const assistantsHere = faces.filter((f) => f.family === "assistant").length;
  // Who is in the chat, for the composer's @ list and the model chips: the stream's participants once it has said, else the chat's members from the box (work.chat.get), never the viewer.
  const roster = faces.filter((f) => f.id !== viewerId && f.id !== viewer).map((f) => ({ name: f.name, family: f.family === "assistant" ? ("assistant" as const) : ("person" as const) }));
  const realComposer = useRealComposer(p.sessionId, roster.length ? roster : undefined, viewer, setNote);
  // A chat with several assistants or models: one chip each, to switch that slot's model.
  const slots = found.length
    ? found.filter((f) => f.id !== viewer && (f.family === "assistant" || f.family === "model")).map((f) => ({ id: f.id, label: f.name, provider: (f as { provider?: string | null }).provider ?? null }))
    : allowsMock() ? [] : here.slots.map((x) => ({ id: x.id, label: x.name, provider: null as string | null }));
  const people = found.length ? found.filter((f) => f.id !== viewer).map((f) => ({ name: f.name, family: f.family === "assistant" ? ("assistant" as const) : ("person" as const) })) : undefined;
  const paneOpen = usePreviewPane();
  const body = (
    <View style={{ flex: 1, backgroundColor: color["surface-1"], paddingTop: insets.top }}>
      <ChatHeader title={head.title} participants={faces} viewer={viewerId} line={line} phone={phone} onBack={p.onBack} onOpen={() => setAboutOpen(true)} onTools={() => setToolsOpen(true)} />
      <ChatToolsSheet open={toolsOpen} onClose={() => setToolsOpen(false)} thread={here.thread ?? p.sessionId} chat={p.sessionId} onOpenFiles={phone ? undefined : () => setFilesOpen(true)} session={here.thread ?? p.sessionId} queued={queued} onForked={p.onBranched}
        onMention={(t) => { const d = readDraft(p.sessionId); writeDraft(p.sessionId, d && !/\s$/.test(d) ? `${d} ${t} ` : `${d}${t} `); setDraftN((n) => n + 1); setToolsOpen(false); }} />
      <SelectionAsk onAsk={(t, from) => setHighlights((l) => addHighlight(l, makeHighlight({ from: from || "this chat", text: t, selected: t, kind: "message" })))} />
      <AboutSheet
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        title={p.title ?? "Chat"}
        participants={found.length ? found : faces.map((f) => ({ ...f, family: f.family as "person" | "assistant" }))}
        viewer={viewerId}
        info={info}
        addable={realComposer ? addable(realComposer.people, found) : undefined}
        onAdd={realComposer ? async (who) => { try { await tool("work.chat.change", addTeammateInput(p.sessionId, who)); return null; } catch (e) { return e instanceof Error && e.message ? e.message : "That did not go through."; } } : undefined}
        muted={muted}
        pinned={pinned}
        onMute={setMuted}
        onPin={setPinned}
        onMove={() => setRunsOn((w) => (w === "mac" ? "server" : "mac"))}
        onOpenTerminal={p.onOpenTerminal}
      />

      {p.belowHeader}

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
        {loading ? (
          <SkeletonThread wide={!phone} />
        ) : (
          <Transcript
            rows={rows as unknown as TranscriptRow[]}
            renderRow={renderRow}
            hasMore={false}
            onNearTop={() => {}}
            head={<View>{sealedNote ? <Pressable accessibilityRole="button" accessibilityLabel="Dismiss the sealed note" onPress={() => setSealedNote(false)} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingVertical: 6, paddingHorizontal: phone ? 16 : 24, marginBottom: 8, backgroundColor: color["surface-2"], borderBottomWidth: 1, borderBottomColor: color.edge }}>
          <Icon name="shield" />
          <Text size="caption" tone="muted" style={{ flex: 1 }}>{sealedNoteText({ sealed: info.sealed, assistants: assistantsHere })}</Text>
          <Text size="caption" tone="label" strong>Got it</Text>
        </Pressable> : null}<View style={{ height: 12 }} /></View>}
            jumpTo={jump}
            jump={(go) => <JumpPill go={go} count={rows.length} base={base.current} bottom={16} />}
          />
        )}
      </View>

      {meta.queue.length ? (
        <View accessibilityLabel="Queued messages" style={{ width: "100%", maxWidth: 860, alignSelf: "center", marginLeft: "auto", marginRight: "auto", paddingHorizontal: phone ? 12 : 20, gap: 4, paddingTop: 6 }}>
          {meta.queue.map((q) => (
            <View key={q.key} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"] }}>
              <View style={{ alignSelf: "center" }}><Chip icon="clock">Queued</Chip></View>
              <Text numberOfLines={1} style={{ flex: 1 }}>{q.text}</Text>
              <Text size="caption" tone="label">waiting for the current reply</Text>
            </View>
          ))}
        </View>
      ) : null}

      {securing ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ width: "100%", maxWidth: 860, alignSelf: "center", paddingHorizontal: phone ? 16 : 24, paddingTop: 6 }}>
          <Chip tone="ok" icon="shield">{`Securing your ${securing} in the Vault`}</Chip>
        </View>
      ) : null}
      {note ? (
        <View accessibilityRole="alert" style={{ width: "100%", maxWidth: 860, alignSelf: "center", paddingHorizontal: phone ? 16 : 24, paddingTop: 6 }}>
          <Text size="caption" tone="muted">{note}</Text>
        </View>
      ) : null}

      <StatusLine
        place={<PlacementChip placement={placed.placement} onMove={(to) => void placed.move(to)} />}
        starting={placed.starting}
        presence={group.presenceLine()}
        state={meta.state}
        busy={meta.busy}
        canStop={meta.canStop}
        stopping={meta.stopping}
        offline={meta.connection === "offline"}
        phone={phone}
        onStop={async () => { const why = await store.interrupt(); if (why) setNote(why); }}
      />

      {replyTo ? (
        <View accessibilityLabel="Replying to a message" style={{ width: "100%", maxWidth: 860, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: phone ? 16 : 24 }}>
          <Icon name="chat" />
          <View style={{ flex: 1, minWidth: 0, borderLeftWidth: 3, borderLeftColor: color.accent, paddingLeft: 8 }}><Text size="caption" strong tone="accent" numberOfLines={1}>{`Replying to ${replyTo.name}`}</Text>{replyTo.text ? <Text size="caption" tone="muted" numberOfLines={1}>{excerpt(replyTo.text)}</Text> : null}</View>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" onPress={() => setReplyTo(null)} style={{ minHeight: phone ? 44 : 32, minWidth: 44, alignItems: "center", justifyContent: "center" }}><Icon name="x" /></Pressable>
        </View>
      ) : null}

      {highlights.length ? (
        <View accessibilityLabel="Highlighted for the assistant" style={{ width: "100%", maxWidth: 860, alignSelf: "center", paddingHorizontal: phone ? 12 : 20, paddingTop: 6, gap: 6 }}>
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
      <ChatExtras thread={p.sessionId} empty={!loading && rows.length === 0} busy={meta.busy} />
      <View style={{ paddingBottom: insets.bottom }}>
        <ChatComposer
          key={draftN}
          draftKey={p.sessionId}
          state={meta.state}
          phone={phone}
          autoFocus={p.autoFocusComposer}
          onKey={p.onKey}
          onSend={onSend}
          onTyping={() => store.typing()}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          people={realComposer ? realComposer.people : people ?? (allowsMock() ? [{ name: "juno", family: "assistant", doing: "Waiting on your answer" }, { name: "kit", family: "assistant", doing: "Working on Northwind Bakery" }, { name: "alex", family: "person" }, { name: "Dana Okafor", family: "person" }] : [])}
          records={realComposer ? realComposer.records : allowsMock() ? [{ name: "Northwind Bakery", type: "Matter", sealed: 1 }, { name: "Juniper Studio intake", type: "Project", sealed: 0 }, { name: "Okafor estate", type: "Matter", sealed: 2 }] : []}
          models={realComposer ? realComposer.models : allowsMock() ? [{ id: "fast", label: "Claude Sonnet", fit: 92 }, { id: "deep", label: "Claude Opus", fit: 97 }, { id: "local", label: "Llama, on this Mac", fit: 61 }] : []}
          model={realComposer ? realComposer.model : "fast"}
          onModel={realComposer?.onModel}
          slots={slots}
          runsOn={runsOn}
          onRunsOn={() => setRunsOn((w) => (w === "mac" ? "server" : "mac"))}
          attachments={att.chips.map((c) => ({ key: c.key, name: c.name, line: chipLine(c), state: c.state, thumb: c.thumb }))}
          onRemoveAttachment={att.remove}
          attachProblem={att.problem}
          onAttachFile={() => void att.choose(false)}
          onAttachPhoto={() => void att.choose(true)}
          {...p.composer}
        />
      </View>
      </View>
      {filesOpen && !phone ? <FilesPane chat={p.sessionId} onClose={() => setFilesOpen(false)} /> : null}
      </View>
    </View>
  );
  // A preview open in Vyre: a column beside the chat on a computer, a full-screen sheet on a phone.
  return paneOpen && !phone ? <View style={{ flex: 1, flexDirection: "row" }}><View style={{ flex: 1, minWidth: 0 }}>{body}</View><PreviewPane phone={false} /></View> : <>{body}<PreviewPane phone={phone} /></>;
}
