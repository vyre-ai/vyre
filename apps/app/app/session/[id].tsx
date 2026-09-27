import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Queued } from "@vyre/chat-core/session-state.js";
import { modeLabel } from "@vyre/chat-core/composer-state.js";
import { Composer } from "../../src/session/Composer";
import { Frame } from "../../src/session/Frame";
import { busy, stateWords, type TranscriptRow } from "../../src/session/model";
import { TranscriptRowView } from "../../src/session/Rows";
import { sessionStore, type SessionStore } from "../../src/session/store";
import { Transcript } from "../../src/session/Transcript";
import { useOutbox } from "../../src/state/connection";
import { useThread } from "../../src/state/threads";
import { useTheme } from "../../src/theme/theme";
import { tokens } from "../../src/theme/tokens";
import { SignInBar } from "../../src/ui/SignInBar";
import { StatusMark } from "../../src/ui/StatusMark";

function useHead(store: SessionStore) {
  return useSyncExternalStore(
    (f) => store.subscribeHead(f),
    () => store.headRev(),
  );
}

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string; ask?: string }>();
  const thread = String(id);
  const store = useMemo(() => sessionStore(thread), [thread]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { color } = useTheme();

  useHead(store);
  const listRev = useSyncExternalStore(
    (f) => store.subscribeList(f),
    () => store.listRev(),
  );
  // Rows are rebuilt only when the list's shape changes; a streaming reply repaints its own row.
  const rows = useMemo(() => store.rows(), [store, listRev]);
  const s = store.session;
  const rec = store.record;
  const listed = useThread(thread);
  const st = store.status;
  const words = stateWords(s);
  const running = busy(s.state);
  const [stopNote, setStopNote] = useState<string | null>(null);

  const renderRow = useCallback((row: TranscriptRow) => <TranscriptRowView store={store} row={row} />, [store]);
  const onNearTop = useCallback(() => void store.earlier(), [store]);
  const title = rec.name ?? "Session";
  const chip = [rec.agent, s.provider, s.model ?? rec.model, listed?.projectName ?? rec.project].filter(Boolean).join(" · ");

  return (
    <View style={[styles.page, { backgroundColor: color.bg, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: color.rule }]}>
        <Pressable accessibilityRole="button" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} style={styles.back} hitSlop={8}>
          <Text style={[styles.meta, { color: color.text2 }]}>Back</Text>
        </Pressable>
        <View style={styles.headCol}>
          <Text numberOfLines={1} accessibilityRole="header" style={[styles.title, { color: color.text }]}>{title}</Text>
          <View style={styles.stateLine}>
            <StatusMark status={running ? "running" : words.ended ? "done" : s.asks.size && [...s.asks.values()].some((a) => a.state === "open") ? "needsYou" : "done"} size={8} />
            <Text numberOfLines={1} style={[styles.meta, { color: color.label }]}>
              {[words.word, words.note, chip].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </View>
      </View>
      <SignInBar />
      <Frame
        transcript={
          <Transcript
            rows={rows}
            renderRow={renderRow}
            hasMore={st.hasMore}
            onNearTop={onNearTop}
            head={
              st.error ? (
                <Text style={[styles.headNote, { color: color.text2 }]}>{st.error}</Text>
              ) : st.loading ? (
                <Text style={[styles.headNote, { color: color.label }]}>{st.loaded ? "Loading earlier" : "Loading"}</Text>
              ) : null
            }
          />
        }
        composer={
          <View style={{ backgroundColor: color.bg, paddingBottom: insets.bottom }}>
            <Pending store={store} />
            {stopNote ? <Text style={[styles.pad, styles.meta, { color: color.text2 }]}>{stopNote}</Text> : null}
            <Composer
              running={running}
              placeholder={`Reply to ${rec.agent ?? "the session"}`}
              onSend={(text, mode) => store.sendText(text, mode)}
              onStop={async () => setStopNote(await store.stop())}
            />
            <Text style={[styles.pad, styles.meta, { color: color.label, paddingBottom: tokens.space[3] }]}>{modeLabel(s.mode)}</Text>
          </View>
        }
      />
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
  if (!s.queued.length && !mine.length && !note) return null;
  const takeBack = async (q: Queued) => setNote(await store.takeBack(q));
  return (
    <View style={[styles.pending, { borderTopColor: color.rule }]}>
      {s.queued.map((q, i) => (
        <View key={q.uuid ?? `q${q.queued ?? i}`} style={styles.pendingRow}>
          <Text style={[styles.meta, { color: color.label }]}>Queued</Text>
          <Text numberOfLines={1} style={[styles.pendingText, { color: color.text }]}>{q.text}</Text>
          <Pressable accessibilityRole="button" onPress={() => void takeBack(q)} hitSlop={8}>
            <Text style={[styles.meta, styles.strong, { color: color.text }]}>Take back</Text>
          </Pressable>
        </View>
      ))}
      {mine.map((o) => (
        <View key={o.key} style={styles.pendingRow}>
          <Text style={[styles.meta, { color: color.label }]}>{o.status === "refused" ? "Not sent" : "Sending"}</Text>
          <Text numberOfLines={1} style={[styles.pendingText, { color: color.text2 }]}>
            {o.status === "refused" ? o.error?.message : String((o.input as { text?: string } | null)?.text ?? "")}
          </Text>
        </View>
      ))}
      {note ? <Text style={[styles.meta, { color: color.text2 }]}>{note}</Text> : null}
    </View>
  );
}

const phone = tokens.type.phone;
const G = tokens.layout.gutterPhone;
const styles = StyleSheet.create({
  page: { flex: 1 },
  header: { minHeight: tokens.layout.phoneHeader + tokens.space[4], flexDirection: "row", alignItems: "center", gap: tokens.space[4], paddingHorizontal: G, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { height: tokens.control.touch, justifyContent: "center" },
  headCol: { flex: 1, minWidth: 0 },
  title: { fontSize: phone.read[0], lineHeight: phone.read[1], fontWeight: tokens.font.weight.strong },
  stateLine: { flexDirection: "row", alignItems: "center", gap: tokens.space[2] },
  meta: { fontSize: phone.meta[0], lineHeight: phone.meta[1] },
  strong: { fontWeight: tokens.font.weight.strong },
  pad: { paddingHorizontal: G },
  headNote: { fontSize: phone.meta[0], lineHeight: phone.meta[1], textAlign: "center", paddingVertical: tokens.space[4] },
  pending: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: G, paddingTop: tokens.space[3], gap: tokens.space[2] },
  pendingRow: { flexDirection: "row", alignItems: "center", gap: tokens.space[3], minHeight: 24 },
  pendingText: { flex: 1, fontSize: phone.base[0], lineHeight: phone.base[1] },
});
