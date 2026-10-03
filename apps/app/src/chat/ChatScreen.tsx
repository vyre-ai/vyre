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

import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chip, Icon, IconButton, Text, useUiTheme } from "@vyre/ui";
import { Transcript } from "../session/Transcript";
import type { TranscriptRow } from "../session/model";
import { ChatComposer, type ComposerProps } from "./ChatComposer";
import { ChatRow, SkeletonThread } from "./ChatRows";
import type { BlockCtx } from "./Blocks";
import { createFollow, follow, pillLabel } from "./follow.js";
import type { StreamSource } from "./mock-stream";
import { useSessionStream, type PerfSink } from "./store";

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
};

function JumpPill({ go, count, base, bottom }: { go: () => void; count: number; base: number; bottom: number }) {
  const { color } = useUiTheme();
  const s = follow(follow(createFollow(), { type: "scroll", atBottom: false }), { type: "rows", added: count - base });
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom, alignItems: "center" }}>
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
  const { store, rows, meta, loading } = useSessionStream(p.sessionId, { source: p.source, perf: p.perf });
  const [note, setNote] = useState<string | null>(null);
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
      ...(p.onOpenTerminal ? { onOpenTerminal: () => p.onOpenTerminal?.() } : {}),
      ...p.handlers,
    }),
    [phone, p.handlers, p.onOpenTerminal, actions, onBranched],
  );
  const onSend = useCallback(
    async (text: string) => {
      setNote(null);
      if (editing && actions) {
        const r = await actions.editRetry!(editing.uuid, text);
        if (!r.ok) setNote(r.reason);
        else setEditing(null);
        return;
      }
      const why = await store.send(text);
      if (why) setNote(why);
    },
    [store, editing, actions],
  );
  const renderRow = useCallback((row: TranscriptRow) => <ChatRow store={store} row={row as never} ctx={ctx} />, [store, ctx]);
  const base = useRef(rows.length);
  base.current = Math.min(base.current, rows.length);

  const tone = meta.state === "asking" ? "accent" : meta.busy ? "ok" : "plain";
  return (
    <View style={{ flex: 1, backgroundColor: color["surface-1"], paddingTop: insets.top }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 52, paddingHorizontal: phone ? 8 : 20, borderBottomWidth: 1, borderBottomColor: color.edge }}>
        {p.onBack ? <IconButton icon="chat" label="Back to chats" touch onPress={p.onBack} /> : null}
        <View style={{ flex: 1, minWidth: 0, paddingLeft: p.onBack ? 0 : 8 }}>
          <Text strong numberOfLines={1}>{p.title ?? "Session"}</Text>
          <Text size="caption" tone="label" numberOfLines={1}>{meta.connection === "offline" ? "Offline, showing what was saved" : meta.state === "asking" ? "Waiting for you" : meta.busy ? "Working" : "Ready"}</Text>
        </View>
        <View style={{ alignSelf: "center" }}><Chip tone={tone as never}>{meta.word}</Chip></View>
        {p.onOpenTerminal ? <IconButton icon="terminal" label="Open full terminal" touch={phone} onPress={p.onOpenTerminal} /> : null}
        {meta.canStop ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={async () => { const why = await store.interrupt(); if (why) setNote(why); }} style={{ minHeight: phone ? 44 : 32, justifyContent: "center" }}>
            <Chip icon="stop" tone="err">Stop</Chip>
          </Pressable>
        ) : meta.stopping ? <View style={{ alignSelf: "center" }}><Chip>Stopping</Chip></View> : null}
      </View>

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
            head={<View style={{ height: 12 }} />}
            jump={(go) => <JumpPill go={go} count={rows.length} base={base.current} bottom={12} />}
          />
        )}
      </View>

      {meta.queue.length ? (
        <View accessibilityLabel="Queued messages" style={{ width: "100%", maxWidth: 860, alignSelf: "center", marginLeft: "auto", marginRight: "auto", paddingHorizontal: phone ? 12 : 20, gap: 4, paddingTop: 6 }}>
          {meta.queue.map((q) => (
            <View key={q.key} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"] }}>
              <View style={{ alignSelf: "center" }}><Chip icon="clock">Queued</Chip></View>
              <Text numberOfLines={1} style={{ flex: 1 }}>{q.text}</Text>
              <Text size="caption" tone="label">after this step</Text>
            </View>
          ))}
        </View>
      ) : null}

      {note ? (
        <View accessibilityRole="alert" style={{ width: "100%", maxWidth: 860, alignSelf: "center", paddingHorizontal: phone ? 16 : 24, paddingTop: 6 }}>
          <Text size="caption" tone="muted">{note}</Text>
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
          people={[{ name: "juno", family: "assistant" }, { name: "kit", family: "assistant" }, { name: "alex", family: "person" }, { name: "Dana Okafor", family: "person" }]}
          records={[{ name: "Northwind Bakery", type: "Matter", sealed: 1 }, { name: "Harlow Legal intake", type: "Project", sealed: 0 }, { name: "Okafor estate", type: "Matter", sealed: 2 }]}
          models={[{ id: "sonnet", label: "Sonnet", fit: 92 }, { id: "opus", label: "Opus", fit: 97 }, { id: "local", label: "Local model", fit: 61 }]}
          model="sonnet"
          runsOn="server"
          {...p.composer}
        />
      </View>
    </View>
  );
}
