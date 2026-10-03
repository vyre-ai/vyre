// The chat rows: who said it (an avatar and a name, as the prototype's thread), streaming text
// with its lines reserved (the unrevealed part is laid out and invisible, so a reply never changes
// height as it reveals), tool results as native blocks, asks as inline task cards, quiet notices.
// Each row subscribes to its own key and is memoized on what it draws.

import { memo, useEffect, useRef, useSyncExternalStore } from "react";
import { Animated, Pressable, View } from "react-native";
import { Avatar, Chip, Icon, Text, useUiTheme } from "@vyre/ui";
import { normalizeBlock, type Block } from "./blocks.js";
import { BlockView, type BlockCtx } from "./Blocks";
import type { ChatStore } from "./store";
import type { LayoutRow } from "./frames.js";

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

function Who({ name, family, meta }: { name: string; family: "person" | "assistant"; meta?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 }}>
      <Text strong>{name}</Text>
      {family === "assistant" ? <Chip>assistant</Chip> : null}
      {meta ? <Text size="caption" tone="label">{meta}</Text> : null}
    </View>
  );
}

function Message({ who, family, meta, children, wide }: { who: string; family: "person" | "assistant"; meta?: string; children: React.ReactNode; wide: boolean }) {
  return (
    <View style={{ width: "100%", maxWidth: MAX, alignSelf: "center", marginLeft: "auto", marginRight: "auto", paddingHorizontal: wide ? 24 : 16, paddingVertical: 8, flexDirection: "row", gap: 12 }}>
      <Avatar name={who} family={family} size="md" />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Who name={who} family={family} meta={meta} />
        {children}
      </View>
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
    <View style={{ flexDirection: "row", gap: 4, marginTop: 2 }}>
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
      <Text size="read" style={{ opacity: 0 }}>{text.slice(cut)}</Text>
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
    <View accessibilityLabel="Loading the conversation" style={{ paddingTop: 12 }}>
      {[0, 1, 2].map((i) => (
        <Frame key={i} wide={wide}>
          <View style={{ flexDirection: "row", gap: 12, paddingVertical: 8 }}>
            <Skeleton w={32} h={32} r={16} />
            <View style={{ flex: 1, gap: 8 }}>
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
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 }}>
      <Icon name={running ? "refresh" : it.status === "failed" ? "failed" : "check"} tone={it.status === "failed" ? "err" : "text-2"} />
      <Text size="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>{it.tool} {it.summary}</Text>
      {running ? <Text size="caption" tone="label">running</Text> : null}
    </View>
  );
}

function ItemBody({ store, k, ctx }: { store: ChatStore; k: string; ctx: BlockCtx }) {
  const it = useRow(store, k);
  if (!it) return null;
  const wide = ctx.wide;
  switch (it.kind) {
    case "user":
      return (
        <Message who={PERSON} family="person" meta={it.pickedUp ? "picked up" : undefined} wide={wide}>
          <Text size="read" selectable>{it.text}</Text>
          <MessageActions uuid={k.slice(2)} text={it.text} ctx={ctx} />
        </Message>
      );
    case "text":
      return <Message who={ASSISTANT} family="assistant" wide={wide}><StreamText store={store} k={k} text={it.text} done={it.done} /></Message>;
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
      const here: BlockCtx = { ...ctx, onApprove: () => void store.answer(it.ask, "approve"), onDecline: () => void store.answer(it.ask, "deny") };
      return <Frame wide={wide} indent>{task ? <BlockView block={task} ctx={here} decided={decided} /> : null}</Frame>;
    }
    case "notice":
      return <Frame wide={wide} indent><Text size="caption" tone="label">{it.text}</Text></Frame>;
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
