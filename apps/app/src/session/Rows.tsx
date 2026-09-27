// The transcript's rows, drawn from chat core items: what the person said, the reply (paced while
// it streams: the store's one frame clock says how much shows), one quiet row per tool call with
// runs folded (grouping.js, a tap opens a run), turn ends with time and tokens, notices, and asks
// inline with Allow and Deny. Each row subscribes to its own key and is memoized on what it draws
// (sameRow), so a streaming reply repaints only itself and a new row re-renders no other.

import { memo, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Item } from "@vyre/chat-core/session-state.js";
import { toolDetail, toolDisplay } from "@vyre/chat-core/tool-detail.js";
import { answers } from "../state/live";
import { fromAsk } from "../state/needs-model";
import { MONO } from "../theme/fonts";
import { useTheme, type Palette } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { StatusMark } from "../ui/StatusMark";
import { sameRow, type TranscriptRow } from "./model";
import type { SessionStore } from "./store";

const phone = tokens.type.phone;
const G = tokens.layout.gutterPhone;

function useRow(store: SessionStore, key: string) {
  useSyncExternalStore(
    (f) => store.subscribeRow(key, f),
    () => store.rowRev(key),
  );
  return store.session.byKey.get(key) ?? null;
}

const seconds = (ms: number | null | undefined) =>
  typeof ms !== "number" ? "" : ms < 1000 ? "under 1 s" : ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)} s`;
const kTokens = (t: unknown) => {
  const o = t && typeof t === "object" ? (t as Record<string, number>) : null;
  const n = o ? (o.output ?? 0) + (o.input ?? 0) : 0;
  return !n ? "" : n < 1000 ? `${n} tokens` : `${(n / 1000).toFixed(1)}k tokens`;
};
/** A live tool's summary often starts with its own name ("Write /path"): the title already says it. */
const withoutName = (summary: string, name: string) => (name && summary.startsWith(name + " ") ? summary.slice(name.length + 1) : summary);

export const TranscriptRowView = memo(
  function TranscriptRowView({ store, row }: { store: SessionStore; row: TranscriptRow }) {
    if (row.type === "run") return <RunRow store={store} row={row} />;
    return <ItemRow store={store} k={row.key} />;
  },
  (a, b) => a.store === b.store && sameRow(a.row, b.row),
);

function RunRow({ store, row }: { store: SessionStore; row: Extract<TranscriptRow, { type: "run" }> }) {
  const { color } = useTheme();
  useRow(store, row.key);
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: row.open }} onPress={() => store.toggle(row.key)} style={styles.tool}>
      <StatusMark status={row.running ? "running" : row.failed ? "failed" : "done"} size={8} />
      <Text numberOfLines={1} style={[styles.toolText, { color: color.text2 }]}>
        {row.summary}
        {row.failed ? ` · ${row.failed} failed` : ""}
      </Text>
      <Text style={[styles.meta, { color: color.label }]}>{row.open ? "Hide" : "Show"}</Text>
    </Pressable>
  );
}

function ItemRow({ store, k }: { store: SessionStore; k: string }) {
  const it = useRow(store, k);
  const { color } = useTheme();
  if (!it) return null;
  return <ItemBody it={it} color={color} store={store} />;
}

function ItemBody({ it, color, store }: { it: Item; color: Palette; store: SessionStore }) {
  switch (it.kind) {
    case "user":
      return (
        <View style={styles.userWrap}>
          <View style={[styles.user, { backgroundColor: color.panel, borderColor: color.rule }]}>
            <Text selectable style={[styles.read, { color: color.text }]}>{it.text}</Text>
          </View>
        </View>
      );
    case "text": {
      const n = store.shown(it.key);
      return (
        <View style={styles.block}>
          <Text selectable style={[styles.read, { color: color.text }]}>
            {n === undefined ? it.text : it.text.slice(0, n)}
          </Text>
        </View>
      );
    }
    case "reasoning":
      return (
        <View style={styles.tool}>
          <Text style={[styles.meta, { color: color.label }]}>{it.streaming ? "Thinking" : `Thought · ${it.text.length} characters`}</Text>
        </View>
      );
    case "tool": {
      const d = toolDisplay(it.detail ?? toolDetail(it.name, it.input ?? {}, undefined, { bodies: false }), it.name);
      const status = it.status === "running" ? "running" : it.status === "failed" ? "failed" : "done";
      return (
        <View style={styles.tool}>
          <StatusMark status={status} size={8} />
          <Text numberOfLines={1} style={[styles.toolText, { color: color.text2 }]}>
            {d.title}{" "}
            <Text style={{ fontFamily: MONO, color: color.text2 }}>{it.summary ? withoutName(it.summary, it.name) : d.subtitle}</Text>
          </Text>
          {it.status === "running" ? <Text style={[styles.meta, { color: color.label }]}>running</Text> : null}
        </View>
      );
    }
    case "turn": {
      const parts = [it.canceled || it.reason === "interrupted" ? "Stopped by you" : null, seconds(it.duration_ms), kTokens(it.tokens), it.error ?? null].filter(Boolean);
      return (
        <View style={styles.tool}>
          <Text style={[styles.meta, { color: color.label }]}>{parts.join(" · ") || "Turn done"}</Text>
        </View>
      );
    }
    case "notice":
      return (
        <View style={styles.tool}>
          <Text style={[styles.meta, { color: color.label }]}>{it.text}</Text>
        </View>
      );
    case "steer":
      return (
        <View style={styles.tool}>
          <Text style={[styles.meta, { color: color.label }]}>{it.pending ? "Steering" : it.step != null ? `Steered at step ${it.step}` : "Steered"}</Text>
        </View>
      );
    case "ask":
      return <AskCard it={it} color={color} store={store} />;
    default:
      return null;
  }
}

function AskCard({ it, color, store }: { it: Extract<Item, { kind: "ask" }>; color: Palette; store: SessionStore }) {
  const open = it.state === "open";
  const question = it.askKind === "question";
  const need = fromAsk({ id: it.ask, thread: store.thread, tool: it.tool, summary: it.summary, kind: it.askKind, at: it.at ?? Date.now() });
  const answer = (d: "approve" | "reject") => need && answers.commit(need, d);
  return (
    <View style={[styles.card, { backgroundColor: color.panel, borderColor: open ? color.beacon : color.rule }]}>
      <View style={styles.cardHead}>
        {open ? <StatusMark status="needsYou" /> : null}
        <Text style={[styles.meta, { color: color.label }]}>{question ? "Question" : "Permission"}{open ? "" : ` · ${it.state === "cancelled" ? "cancelled" : it.decision === "deny" ? "denied" : "allowed"}`}</Text>
      </View>
      <Text selectable style={[styles.read, !question && { fontFamily: MONO, fontSize: phone.base[0] }, { color: color.text }]}>{it.summary ?? it.tool ?? ""}</Text>
      {open ? (
        <View style={styles.cardButtons}>
          {question ? (
            <Text style={[styles.meta, { color: color.text2 }]}>Answer it in the Deck for now. Also in Needs.</Text>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => answer("approve")} style={[styles.btn, { backgroundColor: color.primaryBg }]}>
              <Text style={[styles.btnText, { color: color.primaryInk }]}>Allow once</Text>
            </Pressable>
          )}
          <Pressable accessibilityRole="button" onPress={() => answer("reject")} style={styles.btn}>
            <Text style={[styles.btnText, { color: color.text }]}>Deny</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { paddingHorizontal: G, paddingVertical: tokens.space[3] },
  read: { fontSize: phone.read[0], lineHeight: phone.read[1] },
  userWrap: { paddingHorizontal: G, paddingVertical: tokens.space[3], alignItems: "flex-end" },
  user: { maxWidth: "88%", borderRadius: tokens.radius.bubble, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: tokens.space[4], paddingVertical: tokens.space[3] },
  tool: { flexDirection: "row", alignItems: "center", gap: tokens.space[3], paddingHorizontal: G, minHeight: 28, paddingVertical: tokens.space[2] },
  toolText: { flex: 1, fontSize: phone.base[0], lineHeight: phone.base[1] },
  meta: { fontSize: phone.meta[0], lineHeight: phone.meta[1] },
  card: { marginHorizontal: G, marginVertical: tokens.space[3], padding: tokens.space[4], gap: tokens.space[3], borderRadius: tokens.radius.cardPhone, borderWidth: 1 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: tokens.space[3] },
  cardButtons: { flexDirection: "row", alignItems: "center", gap: tokens.space[3], flexWrap: "wrap" },
  btn: { height: tokens.control.touch, paddingHorizontal: tokens.space[5], borderRadius: tokens.radius.buttonTouch, justifyContent: "center" },
  btnText: { fontSize: phone.base[0], lineHeight: phone.base[1], fontWeight: tokens.font.weight.strong },
});
