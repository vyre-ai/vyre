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
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chip, Icon, Text, useUiTheme } from "@vyre/ui";
import { Transcript } from "../session/Transcript";
import type { TranscriptRow } from "../session/model";
import { ChatComposer, type ComposerProps } from "./ChatComposer";
import { ChatRow, SkeletonThread } from "./ChatRows";
import type { BlockCtx } from "./Blocks";
import { createFollow, follow, pillLabel } from "./follow.js";
import type { StreamSource } from "./mock-stream";
import { useSessionStream, type PerfSink } from "./store";
import { ChatHeader } from "./ChatHeader";
import { AboutSheet, type AboutInfo } from "./AboutSheet";
import { StatusLine } from "./StatusLine";
import { addHighlight, chipLabel, makeHighlight, removeHighlight, withQuotes, type Highlight } from "./highlight.js";
import { markSealedNoteSeen, sealedNoteSeen, sealedNoteText } from "./group.js";

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

export function ChatScreen(p: ChatScreenProps) {
  const { color, phone } = useUiTheme();
  const insets = useSafeAreaInsets();
  const { store, rows, meta, loading } = useSessionStream(p.sessionId, { source: p.source, perf: p.perf, viewer: p.viewer });
  const viewer = store.group.viewer;
  const [note, setNote] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(!!p.initialAbout);
  const [muted, setMuted] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [runsOn, setRunsOn] = useState<"mac" | "server">(p.about?.runsOn ?? "server");
  const [replyTo, setReplyTo] = useState<{ message: string; name: string } | null>(null);
  // The sealed note shows once per chat, on its first open. Storage can be missing or throw: then it shows again, never hides.
  const [sealedNote, setSealedNote] = useState(() => p.showSealedNote ?? !sealedNoteSeen(storage(), p.sessionId));
  useEffect(() => { if (sealedNote) markSealedNoteSeen(storage(), p.sessionId); }, [sealedNote, p.sessionId]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [editing, setEditing] = useState<{ id: number; uuid: string; text: string } | null>(null);
  const actions = store.actions;
  const { onBranched } = p;
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
      onReplyTo: (message: string, name: string) => setReplyTo({ message, name }),
      onHighlight: (o: { from: string; text: string; selected?: string; kind?: "message" | "terminal" }) => setHighlights((l) => addHighlight(l, makeHighlight(o))),
      ...(p.onOpenTerminal ? { onOpenTerminal: () => p.onOpenTerminal?.() } : {}),
      ...p.handlers,
    }),
    [phone, p.handlers, p.onOpenTerminal, actions, onBranched],
  );
  const onSend = useCallback(
    async (text: string, o?: { to: string[]; fanout: boolean }) => {
      setNote(null);
      if (editing && actions) {
        const r = await actions.editRetry!(editing.uuid, text);
        if (!r.ok) setNote(r.reason);
        else setEditing(null);
        return;
      }
      store.social.markRead(store.group.last); // sending says you have read everything above
      const parent = replyTo?.message;
      setReplyTo(null);
      // What the person highlighted is quoted into the message they send now, and the chips clear: nothing was sent before this.
      const body = withQuotes(text, highlights);
      setHighlights([]);
      const why = o && (o.to.length || o.fanout || parent) ? await store.sendTo(body, { to: o.to, fanout: o.fanout, parent }) : await store.send(body);
      if (why) setNote(why);
    },
    [store, editing, actions, replyTo, highlights],
  );
  const renderRow = useCallback((row: TranscriptRow) => <ChatRow store={store} row={row as never} ctx={ctx} />, [store, ctx]);
  const base = useRef(rows.length);
  base.current = Math.min(base.current, rows.length);

  const group = store.group;
  const found = group.participants();
  const faces = found.length ? found : [{ id: viewer, name: parseName(viewer), family: "person" as const }, { id: "assistant:juno", name: "juno", family: "assistant" as const }];
  const info: AboutInfo = { record: null, sealed: 0, ...p.about, runsOn };
  const line = [info.record?.title, info.space].filter(Boolean).join(" · ") + (muted ? (info.record || info.space ? " · muted" : "muted") : "");
  const assistantsHere = faces.filter((f) => f.family === "assistant").length;
  const people = found.length ? found.filter((f) => f.id !== viewer).map((f) => ({ name: f.name, family: f.family === "assistant" ? ("assistant" as const) : ("person" as const) })) : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: color["surface-1"], paddingTop: insets.top }}>
      <ChatHeader title={p.title ?? "Session"} participants={faces} viewer={viewer} line={line} phone={phone} onBack={p.onBack} onOpen={() => setAboutOpen(true)} />
      <AboutSheet
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        title={p.title ?? "Session"}
        participants={found.length ? found : faces.map((f) => ({ ...f, family: f.family as "person" | "assistant" }))}
        viewer={viewer}
        info={info}
        muted={muted}
        pinned={pinned}
        onMute={setMuted}
        onPin={setPinned}
        onMove={() => setRunsOn((w) => (w === "mac" ? "server" : "mac"))}
        onOpenTerminal={p.onOpenTerminal}
      />

      {p.belowHeader}

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

      {note ? (
        <View accessibilityRole="alert" style={{ width: "100%", maxWidth: 860, alignSelf: "center", paddingHorizontal: phone ? 16 : 24, paddingTop: 6 }}>
          <Text size="caption" tone="muted">{note}</Text>
        </View>
      ) : null}

      <StatusLine
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
        <View accessibilityLabel="Replying in a thread" style={{ width: "100%", maxWidth: 860, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: phone ? 16 : 24 }}>
          <Icon name="chat" />
          <Text size="caption" tone="muted" style={{ flex: 1 }} numberOfLines={1}>{`Replying in a thread to ${replyTo.name}`}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" onPress={() => setReplyTo(null)} style={{ minHeight: phone ? 44 : 32, justifyContent: "center", paddingHorizontal: 8 }}><Text size="caption" strong>Cancel</Text></Pressable>
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

      <View style={{ paddingBottom: insets.bottom }}>
        <ChatComposer
          state={meta.state}
          phone={phone}
          autoFocus={p.autoFocusComposer}
          onKey={p.onKey}
          onSend={onSend}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          people={people ?? [{ name: "juno", family: "assistant" }, { name: "kit", family: "assistant" }, { name: "alex", family: "person" }, { name: "Dana Okafor", family: "person" }]}
          records={[{ name: "Northwind Bakery", type: "Matter", sealed: 1 }, { name: "Harlow Legal intake", type: "Project", sealed: 0 }, { name: "Okafor estate", type: "Matter", sealed: 2 }]}
          models={[{ id: "sonnet", label: "Sonnet", fit: 92 }, { id: "opus", label: "Opus", fit: 97 }, { id: "local", label: "Local model", fit: 61 }]}
          model="sonnet"
          runsOn={runsOn}
          onRunsOn={() => setRunsOn((w) => (w === "mac" ? "server" : "mac"))}
          {...p.composer}
        />
      </View>
    </View>
  );
}
