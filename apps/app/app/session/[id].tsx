// One session, as the Deck shows it and held to the native bar (docs/design/native-bar.md): the
// header (the state chip, the model, the context meter), the transcript (its own subscription, so
// the header and the composer never re-lay it), and the composer (its own state, so a keystroke
// re-renders nothing else). Stop flips the chip to "stopping" in the frame it is pressed; Esc Esc
// or /rewind opens the rewind sheet.

import { memo, useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Queued } from "@vyre/chat-core/session-state.js";
import { modeLabel } from "@vyre/chat-core/composer-state.js";
import { NEEDS_UPDATE } from "@vyre/chat-core/caps.js";
import ChatDemo from "../chat-demo";
import { Composer } from "../../src/session/Composer";
import { Frame } from "../../src/session/Frame";
import { busy, stateWords, type TranscriptRow } from "../../src/session/model";
import { TranscriptRowView } from "../../src/session/Rows";
import { sessionStore, type SessionStore } from "../../src/session/store";
import { Transcript } from "../../src/session/Transcript";
import { useOutbox } from "../../src/state/connection";
import { useGlassFor } from "../../src/state/glass";
import { useNeeds } from "../../src/state/needs";
import { COPY } from "../../src/state/glass-model.js";
import { useThread } from "../../src/state/threads";
import { useTheme } from "../../src/theme/theme";
import { tokens } from "../../src/theme/tokens";
import { type } from "../../src/theme/type";
import { BackButton } from "../../src/ui/BackButton";
import { Button } from "../../src/ui/Button";
import { GlassCard, GlassPill, useScreenFocused } from "../../src/ui/GlassMini";
import { IconButton } from "../../src/ui/IconButton";
import { SignInBar } from "../../src/ui/SignInBar";
import { StatusMark } from "../../src/ui/StatusMark";

function useHead(store: SessionStore) {
  return useSyncExternalStore(
    (f) => store.subscribeHead(f),
    () => store.headRev(),
  );
}

/** /session/demo is the 0.3 chat screen on the mock stream (src/chat); every other id is a box session. */
export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return String(id) === "demo" ? <ChatDemo /> : <BoxSession />;
}

function BoxSession() {
  const { id } = useLocalSearchParams<{ id: string; ask?: string }>();
  const thread = String(id);
  const store = useMemo(() => sessionStore(thread), [thread]);
  const insets = useSafeAreaInsets();
  const { color } = useTheme();
  useLayoutEffect(() => store.opened(), [store]);

  useHead(store);
  const s = store.session;
  const rec = store.record;
  const listed = useThread(thread);
  const words = stateWords(s, store.stopping);
  const running = busy(s.state);
  const ctx = store.context();
  const [note, setNote] = useState<string | null>(null);
  const [rewinding, setRewinding] = useState(false);

  const onSend = useCallback((text: string, mode: Parameters<SessionStore["sendText"]>[1]) => store.sendText(text, mode), [store]);
  const onStop = useCallback(async () => setNote(await store.stop()), [store]);
  const onRewind = useCallback(() => (store.canRewind() ? setRewinding(true) : setNote(`Rewind: ${NEEDS_UPDATE}`)), [store]);
  const title = rec.name ?? "Session";
  const chip = [rec.agent, s.model ?? rec.model, listed?.projectName ?? rec.project].filter(Boolean).join(" · ");
  const openAsk = [...s.asks.values()].some((a) => a.state === "open");

  return (
    <View style={[styles.page, { backgroundColor: color.bg, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: color.rule }]}>
        <BackButton />
        <View style={styles.headCol}>
          <Text numberOfLines={1} accessibilityRole="header" style={[type.readStrong, { color: color.text }]}>{title}</Text>
          <View style={styles.stateLine}>
            <StatusMark status={running ? "running" : words.word === "failed" ? "failed" : openAsk ? "needsYou" : "done"} />
            <Text testID="session-state" numberOfLines={1} style={[type.meta, styles.shrink, { color: color.label }]}>
              {[words.word, words.note, chip].filter(Boolean).join(" · ")}
            </Text>
            {ctx ? (
              <Text accessibilityLabel={ctx.title ?? ctx.text} style={[type.meta, { color: ctx.share >= 0.8 ? color.text : color.label }]}>
                {ctx.text}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
      <ThreadGlass agent={listed?.agent ?? rec.agent} thread={thread} />
      <SignInBar />
      <Frame
        transcript={<TranscriptHost store={store} />}
        composer={
          <View style={{ backgroundColor: color.bg, paddingBottom: insets.bottom }}>
            {rewinding ? <RewindSheet store={store} onClose={() => setRewinding(false)} /> : null}
            <Pending store={store} />
            {note ? <Text style={[styles.pad, type.meta, { color: color.text2 }]}>{note}</Text> : null}
            <Composer
              store={store}
              running={running}
              model={s.model ?? rec.model}
              placeholder={`Reply to ${rec.agent ?? "the session"}`}
              onSend={onSend}
              onStop={onStop}
              onRewind={onRewind}
            />
            <Text style={[styles.pad, type.meta, { color: color.label, paddingBottom: tokens.space[3] }]}>{modeLabel(s.mode)}</Text>
          </View>
        }
      />
    </View>
  );
}

/**
 * The thread's agent's computer under the header (glass-mini.md): the Card, collapsible to the Pill
 * by its own icon button ("Hide screen", "Show screen"). Nothing when the agent has no computer.
 */
function ThreadGlass({ agent, thread }: { agent: string | null; thread: string }) {
  const view = useGlassFor(agent);
  const focused = useScreenFocused();
  const [open, setOpen] = useState(true);
  const needs = useNeeds();
  if (!view) return null;
  const waiting = needs.find((n) => n.thread === thread || (!n.thread && n.agent === agent))?.title ?? null;
  return (
    <View style={styles.glass}>
      <View style={styles.glassBody}>
        {open ? <GlassCard view={view} waiting={waiting} visible={focused} here={thread} /> : <GlassPill view={view} waiting={waiting} here={thread} />}
      </View>
      {/* The icon set has no chev-u: Hide is chev-d turned over. */}
      <View style={open ? styles.flip : null}>
        <IconButton icon="chev-d" size="touch" accessibilityLabel={open ? COPY.hide : COPY.show} onPress={() => setOpen((o) => !o)} testID="glass-toggle" />
      </View>
    </View>
  );
}

/** The transcript on its own subscription: a new row re-lays the list, nothing else does. */
const TranscriptHost = memo(function TranscriptHost({ store }: { store: SessionStore }) {
  const listRev = useSyncExternalStore(
    (f) => store.subscribeList(f),
    () => store.listRev(),
  );
  // Rows are rebuilt only when the list's shape changes; a streaming reply repaints its own row.
  const rows = useMemo(() => store.rows(), [store, listRev]);
  const renderRow = useCallback((row: TranscriptRow) => <TranscriptRowView store={store} row={row} />, [store]);
  const onNearTop = useCallback(() => void store.earlier(), [store]);
  const head = useMemo(() => <HeadNote store={store} />, [store]);
  const jump = useCallback(
    (go: () => void) => (
      <View style={styles.jump}>
        <Button kind="secondary" size="sm" label="Jump to latest" accessibilityLabel="Jump to latest" onPress={go} />
      </View>
    ),
    [],
  );
  return <Transcript rows={rows} renderRow={renderRow} hasMore={store.status.hasMore} onNearTop={onNearTop} head={head} jump={jump} />;
});

/** Above the oldest row: loading, or why what shows is not current. */
function HeadNote({ store }: { store: SessionStore }) {
  const { color } = useTheme();
  useHead(store);
  const st = store.status;
  if (st.error) return <Text style={[type.meta, styles.headNote, { color: color.text2 }]}>{st.loaded ? `Not current: ${st.error}` : st.error}</Text>;
  if (st.loading) return <Text style={[type.meta, styles.headNote, { color: color.label }]}>{st.loaded ? "Loading earlier" : "Loading"}</Text>;
  return null;
}

/** Rewind to before one of your messages: the conversation, the code, or both (when the box can put files back). */
function RewindSheet({ store, onClose }: { store: SessionStore; onClose: () => void }) {
  const { color } = useTheme();
  const [busyOn, setBusyOn] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const points = store.checkpoints().slice(0, 8);
  const code = store.canRestoreCode();
  const go = async (p: { uuid: string; text: string }, restore: "conversation" | "code" | "both") => {
    setBusyOn(p.uuid);
    const r = await store.rewind(p, restore);
    setBusyOn(null);
    if (r.note) return setNote(r.note);
    if (r.text !== null) store.prefill(r.text);
    onClose();
  };
  return (
    <View style={[styles.sheet, { borderTopColor: color.rule }]}>
      <View style={styles.pendingRow}>
        <Text style={[type.metaStrong, styles.shrink, { color: color.text }]}>Rewind to before</Text>
        <Button kind="ghost" label="Close" onPress={onClose} />
      </View>
      {points.length ? null : <Text style={[type.meta, { color: color.label }]}>No messages to go back to yet.</Text>}
      {points.map((p) => (
        <View key={p.key} style={styles.pendingRow}>
          <Text numberOfLines={1} style={[type.base, styles.pendingText, { color: busyOn === p.uuid ? color.label : color.text }]}>{p.text}</Text>
          <Button kind="secondary" label="Rewind" disabled={!!busyOn} onPress={() => void go(p, "conversation")} />
          {code ? <Button kind="ghost" label="With code" disabled={!!busyOn} onPress={() => void go(p, "both")} /> : null}
        </View>
      ))}
      {note ? <Text style={[type.meta, { color: color.text2 }]}>{note}</Text> : null}
    </View>
  );
}

/** What waits above the composer: messages queued for after the turn (Take back), and sends still in the outbox. */
function Pending({ store }: { store: SessionStore }) {
  const { color } = useTheme();
  const outbox = useOutbox();
  const [note, setNote] = useState<string | null>(null);
  const s = store.session;
  const mine = outbox.filter((o) => o.tool === "threads.send" && (o.input as { thread?: string } | null)?.thread === store.thread);
  // A send already drawn in the transcript shows here as a count; its words are on screen.
  const drawn = mine.filter((o) => o.status !== "refused" && s.meta.uuids.has(String((o.input as { uuid?: string } | null)?.uuid ?? "")));
  const rest = mine.filter((o) => !drawn.includes(o));
  if (!s.queued.length && !mine.length && !note) return null;
  const takeBack = async (q: Queued) => setNote(await store.takeBack(q));
  return (
    <View style={[styles.pending, { borderTopColor: color.rule }]}>
      {s.queued.map((q, i) => (
        <View key={q.uuid ?? `q${q.queued ?? i}`} style={styles.pendingRow}>
          <Text style={[type.meta, { color: color.label }]}>Queued</Text>
          <Text numberOfLines={1} style={[type.base, styles.pendingText, { color: color.text }]}>{q.text}</Text>
          <Button kind="ghost" label="Take back" onPress={() => void takeBack(q)} />
        </View>
      ))}
      {drawn.length ? <Text style={[type.meta, { color: color.label }]}>{drawn.length === 1 ? "Sending" : `Sending ${drawn.length} messages`}</Text> : null}
      {rest.map((o) => (
        <View key={o.key} style={styles.pendingRow}>
          <Text style={[type.meta, { color: color.label }]}>{o.status === "refused" ? "Not sent" : "Sending"}</Text>
          <Text numberOfLines={1} style={[type.base, styles.pendingText, { color: color.text2 }]}>
            {o.status === "refused" ? o.error?.message : String((o.input as { text?: string } | null)?.text ?? "")}
          </Text>
        </View>
      ))}
      {note ? <Text style={[type.meta, { color: color.text2 }]}>{note}</Text> : null}
    </View>
  );
}

const G = tokens.layout.gutterPhone;
const styles = StyleSheet.create({
  page: { flex: 1 },
  header: { minHeight: tokens.layout.phoneHeader + tokens.space[4], flexDirection: "row", alignItems: "center", gap: tokens.space[4], paddingHorizontal: G, borderBottomWidth: StyleSheet.hairlineWidth },
  headCol: { flex: 1, minWidth: 0 },
  stateLine: { flexDirection: "row", alignItems: "center", gap: tokens.space[2] },
  shrink: { flexShrink: 1 },
  pad: { paddingHorizontal: G },
  headNote: { textAlign: "center", paddingVertical: tokens.space[4] },
  pending: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: G, paddingTop: tokens.space[3], gap: tokens.space[2] },
  pendingRow: { flexDirection: "row", alignItems: "center", gap: tokens.space[3], minHeight: 24 },
  pendingText: { flex: 1 },
  sheet: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: G, paddingVertical: tokens.space[3], gap: tokens.space[2] },
  jump: { position: "absolute", bottom: tokens.space[4], alignSelf: "center" },
  glass: { flexDirection: "row", alignItems: "flex-start", gap: tokens.space[3], paddingLeft: G, paddingRight: G - tokens.space[3], paddingVertical: tokens.space[3] },
  glassBody: { flex: 1, minWidth: 0, justifyContent: "center", minHeight: tokens.control.touch },
  flip: { transform: [{ rotate: "180deg" }] },
});
