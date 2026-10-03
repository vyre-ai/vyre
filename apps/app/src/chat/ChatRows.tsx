// The chat rows: who said it (an avatar and a name, as the prototype's thread), streaming text
// with its lines reserved (the unrevealed part is laid out and invisible, so a reply never changes
// height as it reveals), tool results as native blocks, asks as inline task cards, quiet notices.
// Each row subscribes to its own key and is memoized on what it draws.

import { memo, useEffect, useRef, useSyncExternalStore } from "react";
import { Animated, Pressable, View, StyleSheet } from "react-native";
import { Chip, Icon, Text, useUiTheme } from "@vyre/ui";
import { ChatAvatar } from "./ChatAvatar";
import { normalizeBlock, type Block } from "./blocks.js";
import { BlockView, type BlockCtx } from "./Blocks";
import type { ChatStore } from "./store";
import type { LayoutRow } from "./frames.js";
import { askAudience } from "./group.js";
import { readSelection } from "./highlight.js";
import { FanoutSet } from "./FanoutSet";
import { MessageTools, Reactions, UnreadDivider, WaitingCard } from "./GroupParts";

const S = StyleSheet.create({
  s1: { marginBottom: 2 },
  s2: { flexDirection: "row", alignItems: "center", gap: 8 },
  s3: { flex: 1, minWidth: 0 },
  s4: { flexDirection: "row", gap: 4, marginTop: 2 },
  s5: { opacity: 0 },
  s6: { paddingTop: 12 },
  s7: { flexDirection: "row", gap: 12, paddingVertical: 8 },
  s8: { flex: 1, gap: 8 },
  s9: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 },
  s10: { flex: 1 },
});


export const PERSON = "alex";
export const ASSISTANT = "juno";
const BODY_INDENT = 44;
const MAX = 820;

function useRow(store: ChatStore, key: string) {
  useSyncExternalStore((f) => store.subscribeRow(key, f), () => store.rowRev(key));
  return store.item(key);
}

/** One row's frame: a centred column, 16 px gutters on a phone, 24 on a desktop. */
function Frame({ children, indent, wide }: { children: React.ReactNode; indent?: boolean; wide: boolean }) {
  return (
    <View style={{ width: "100%", maxWidth: MAX, alignSelf: "center", marginLeft: "auto", marginRight: "auto", paddingHorizontal: wide ? 24 : 16, paddingVertical: 6, paddingLeft: (wide ? 24 : 16) + (indent ? BODY_INDENT : 0) }}>
      {children}
    </View>
  );
}

function Who({ name, family, meta, sub }: { name: string; family: "person" | "assistant" | "model"; meta?: string; sub?: string | null }) {
  return (
    <View style={S.s1}>
      <View style={S.s2}>
        <Text strong>{name}</Text>
        {family === "assistant" ? <Chip>assistant</Chip> : null}
        {meta ? <Text size="caption" tone="label">{meta}</Text> : null}
      </View>
      {sub ? <Text size="caption" tone="label">{sub}</Text> : null}
    </View>
  );
}

const avFam = (f: "person" | "assistant" | "model") => (f === "model" ? "agent" : f);

type Dress = { mentioned?: boolean; divider?: number | null; pinned?: boolean; replies?: number; reply?: boolean; cut?: string | null };

function Message({ who, family, meta, sub, dress, children, wide }: { who: string; family: "person" | "assistant" | "model"; meta?: string; sub?: string | null; dress?: Dress; children: React.ReactNode; wide: boolean }) {
  const { color } = useUiTheme();
  return (
    <View style={{ width: "100%", maxWidth: MAX, alignSelf: "center", marginLeft: "auto", marginRight: "auto" }}>
      {dress?.divider ? <View style={{ paddingHorizontal: wide ? 24 : 16 }}><UnreadDivider count={dress.divider} /></View> : null}
      <View style={{ paddingHorizontal: wide ? 24 : 16, paddingVertical: 8, flexDirection: "row", gap: 12, ...(dress?.mentioned ? { backgroundColor: color["accent-wash"], borderLeftWidth: 2, borderLeftColor: color.accent, paddingLeft: wide ? 22 : 14 } : {}) }}>
        <ChatAvatar name={who} family={avFam(family)} size="md" />
        <View style={S.s3}>
          <Who name={who} family={family} meta={dress?.pinned ? (meta ? meta + " · pinned" : "pinned") : meta} sub={sub} />
          {dress?.reply ? <Text size="caption" tone="label">in a thread</Text> : null}
          {children}
          {dress?.cut ? <Text size="caption" tone="warn">{dress.cut}</Text> : null}
          {dress?.replies ? <Text size="caption" tone="accent">{`${dress.replies} ${dress.replies === 1 ? "reply" : "replies"}`}</Text> : null}
        </View>
      </View>
    </View>
  );
}

/** Highlight to assistant: the message, or the part of it the person selected, goes above the composer as a quoted reference. Nothing is sent. */
function HighlightAction({ from, text, ctx }: { from: string; text: string; ctx: BlockCtx }) {
  const { color } = useUiTheme();
  const picked = useRef("");
  if (!ctx.onHighlight) return null;
  return (
    <View style={S.s4}>
      <Pressable accessibilityRole="button" accessibilityLabel="Highlight to assistant" onPressIn={() => { picked.current = readSelection(); }} onPress={() => ctx.onHighlight?.({ from, text, selected: picked.current })} style={({ pressed, hovered }: any) => ({ minHeight: ctx.wide ? 28 : 44, justifyContent: "center", paddingHorizontal: 8, marginLeft: -8, borderRadius: 8, backgroundColor: pressed ? color.press : hovered ? color.hover : "transparent" })}>
        <Text size="caption" tone="label">Highlight to assistant</Text>
      </Pressable>
    </View>
  );
}

function MessageActions({ uuid, text, ctx }: { uuid: string; text: string; ctx: BlockCtx }) {
  const { color } = useUiTheme();
  if (!ctx.onRetryMessage && !ctx.onEditMessage && !ctx.onBranchFrom) return null;
  const h = ctx.wide ? 28 : 44;
  const act = (label: string, run?: () => void) => run ? (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label} this message`} onPress={run} style={({ pressed, hovered }: any) => ({ minHeight: h, justifyContent: "center", paddingHorizontal: 8, marginLeft: -8, borderRadius: 8, backgroundColor: pressed ? color.press : hovered ? color.hover : "transparent" })}>
      <Text size="caption" tone="label">{label}</Text>
    </Pressable>
  ) : null;
  return (
    <View style={S.s4}>
      {act("Edit", ctx.onEditMessage && (() => ctx.onEditMessage?.(uuid, text)))}
      {act("Retry", ctx.onRetryMessage && (() => ctx.onRetryMessage?.(uuid)))}
      {act("Branch", ctx.onBranchFrom && (() => ctx.onBranchFrom?.(uuid)))}
    </View>
  );
}

function StreamText({ store, k, text, done }: { store: ChatStore; k: string; text: string; done: boolean }) {
  const n = store.shown(k);
  const cut = n === undefined ? text.length : Math.min(n, text.length);
  if (cut >= text.length) return <Text size="read" selectable>{text}</Text>;
  // The rest is laid out, so the height is the final height; it is only not drawn yet.
  return (
    <Text size="read">
      {text.slice(0, cut)}
      <Text size="read" style={S.s5}>{text.slice(cut)}</Text>
    </Text>
  );
}

export function Skeleton({ w, h = 12, r = 6 }: { w: number | `${number}%`; h?: number; r?: number }) {
  const { color } = useUiTheme();
  const v = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([Animated.timing(v, { toValue: 1, duration: 800, useNativeDriver: false }), Animated.timing(v, { toValue: 0.45, duration: 800, useNativeDriver: false })]));
    a.start();
    return () => a.stop();
  }, [v]);
  return <Animated.View style={{ width: w, height: h, borderRadius: r, backgroundColor: color.hover, opacity: v }} />;
}

/** The thread while it loads: the shape of what is coming, never a spinner. */
export function SkeletonThread({ wide }: { wide: boolean }) {
  return (
    <View accessibilityLabel="Loading the conversation" style={S.s6}>
      {[0, 1, 2].map((i) => (
        <Frame key={i} wide={wide}>
          <View style={S.s7}>
            <Skeleton w={32} h={32} r={16} />
            <View style={S.s8}>
              <Skeleton w={96} h={12} />
              <Skeleton w="92%" h={14} />
              <Skeleton w={i === 1 ? "40%" : "70%"} h={14} />
            </View>
          </View>
        </Frame>
      ))}
    </View>
  );
}

function ToolLine({ it, running }: { it: any; running: boolean }) {
  return (
    <View style={S.s9}>
      <Icon name={running ? "refresh" : it.status === "failed" ? "failed" : "check"} tone={it.status === "failed" ? "err" : "text-2"} />
      <Text size="caption" tone="muted" numberOfLines={1} style={S.s10}>{it.tool} {it.summary}</Text>
      {running ? <Text size="caption" tone="label">running</Text> : null}
    </View>
  );
}

/** Who wrote this row. Without an author on the frame (a one-to-one over the old stream) it is the person or the assistant of the chat. */
function whoOf(store: ChatStore, k: string): { name: string; family: "person" | "assistant" | "model"; sub: string | null } {
  if (store.group.author(k.slice(2))?.author) return store.group.label(k);
  return k.startsWith("u:") ? { name: PERSON, family: "person", sub: null } : { name: ASSISTANT, family: "assistant", sub: null };
}

function dressOf(store: ChatStore, k: string, text: string): Dress {
  const g = store.group;
  const m = k.slice(2);
  const d = g.divider();
  return { mentioned: g.mentioned(m, text), divider: d.key === k ? d.count : null, pinned: g.pinned(m), replies: g.replyCount(m), reply: !!g.parent(m), cut: g.cut(m) };
}

/** Reactions and the Reply / React / Pin tools, only in a chat that has people in it (a group). */
function GroupTools({ store, k, ctx, name }: { store: ChatStore; k: string; ctx: BlockCtx; name: string }) {
  const g = store.group;
  if (!g.participants().length) return null;
  const m = k.slice(2);
  return (
    <>
      <Reactions items={g.reactions(m)} big={!ctx.wide} onToggle={(e, mine) => store.social.react(m, e, mine)} />
      <MessageTools big={!ctx.wide} pinned={g.pinned(m)} onReply={ctx.onReplyTo ? () => ctx.onReplyTo?.(m, name) : undefined} onReact={(e) => store.social.react(m, e)} onPin={(p) => store.social.pin(m, p)} />
    </>
  );
}

function ItemBody({ store, k, ctx }: { store: ChatStore; k: string; ctx: BlockCtx }) {
  const it = useRow(store, k);
  if (!it) return null;
  const wide = ctx.wide;
  switch (it.kind) {
    case "user": {
      const w = whoOf(store, k);
      const mine = store.group.isMine(k);
      return (
        <Message who={w.name} family={w.family} sub={w.sub} meta={it.pickedUp ? "picked up" : undefined} dress={dressOf(store, k, it.text)} wide={wide}>
          <Text size="read" selectable>{it.text}</Text>
          {mine ? <MessageActions uuid={k.slice(2)} text={it.text} ctx={ctx} /> : null}
          <HighlightAction from={w.name} text={it.text} ctx={ctx} />
          <GroupTools store={store} k={k} ctx={ctx} name={w.name} />
        </Message>
      );
    }
    case "text": {
      const fo = store.group.fanoutAt(k);
      if (fo) {
        if (!fo.first) return null;
        return <Frame wide={wide} indent={wide}><FanoutSet store={store} fanout={fo.fanout} wide={wide} renderText={(key) => { const x = store.item(key); return x ? <StreamText store={store} k={key} text={x.text} done={x.done} /> : null; }} /></Frame>;
      }
      const w = whoOf(store, k);
      return (
        <Message who={w.name} family={w.family} sub={w.sub} dress={dressOf(store, k, it.text)} wide={wide}>
          <StreamText store={store} k={k} text={it.text} done={it.done} />
          {it.done ? <HighlightAction from={w.name} text={it.text} ctx={ctx} /> : null}
          <GroupTools store={store} k={k} ctx={ctx} name={w.name} />
        </Message>
      );
    }
    case "tool":
      return <Frame wide={wide} indent><ToolLine it={it} running={it.status === "running"} /></Frame>;
    case "block": {
      const running = it.status === "running";
      let block: Block | null = it.block ? normalizeBlock(it.block, `${it.tool} ${it.summary}`.trim()) : null;
      if (!block && it.toolKind === "terminal") block = { block: "terminal", command: it.summary, output: it.output, exit: null, running: true };
      return (
        <Frame wide={wide} indent>
          {block ? <BlockView block={block} ctx={ctx} output={running ? it.output : undefined} running={running} /> : <ToolLine it={it} running={running} />}
        </Frame>
      );
    }
    case "ask": {
      const block = it.task ? normalizeBlock(it.task, it.title ?? "Needs your approval") : normalizeBlock({ block: "task", id: it.ask, title: it.title ?? "Needs your approval", state: "needs-approval" });
      const task = block.block === "task" ? block : null;
      const decided = it.state === "answered" ? (it.decision === "deny" ? "deny" : "approve") : null;
      const aud = askAudience({ asker: store.group.asker(it.ask), viewer: store.group.viewer, names: store.group.names() });
      if (!aud.mine && !decided && aud.waitingFor) return <Frame wide={wide} indent><WaitingCard title={task?.title ?? it.title ?? "Needs approval"} who={aud.waitingFor} /></Frame>;
      const here: BlockCtx = { ...ctx, onApprove: () => void store.answer(it.ask, "approve"), onDecline: () => void store.answer(it.ask, "deny") };
      return <Frame wide={wide} indent>{task ? <BlockView block={task} ctx={here} decided={decided} /> : null}</Frame>;
    }
    case "notice":
      return <Frame wide={wide} indent><Text size="caption" tone="label">{String(it.text).replace(/\b(?:person|assistant|model):/g, "")}</Text></Frame>;
    default:
      return null;
  }
}

export const ChatRow = memo(
  function ChatRow({ store, row, ctx }: { store: ChatStore; row: LayoutRow; ctx: BlockCtx }) {
    return <ItemBody store={store} k={row.key} ctx={ctx} />;
  },
  (a, b) => a.store === b.store && a.row.key === b.row.key && a.row.kind === b.row.kind && a.ctx === b.ctx,
);
