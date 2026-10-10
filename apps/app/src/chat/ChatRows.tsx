// The chat rows: who said it (an avatar and a name, as the prototype's thread), streaming text
// with its lines reserved (the unrevealed part is laid out and invisible, so a reply never changes
// height as it reveals), tool results as native blocks, asks as inline task cards, quiet notices.
// Each row subscribes to its own key and is memoized on what it draws.

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Animated, Pressable, View, StyleSheet } from "react-native";
import { Caret, Turning } from "./Live";
import { showsCaret, thoughtWord } from "./feel.js";
import { Button, Chip, Icon, Markdown, Sheet, SwipeActions, Text, allowsMock, useUiTheme } from "@vyre/ui";
import { tool } from "../real/box";
import { Face } from "./Face";
import { sizeWord } from "./attach-model.js";
import { normalizeBlock, type Block } from "./blocks.js";
import { BlockView, copy, type BlockCtx } from "./Blocks";
import { codeBlocks, copyForms } from "./polish.js";
import { itemLabel, partsOf } from "./secure-paste.js";
import type { ChatStore } from "./store";
import type { LayoutRow } from "./frames.js";
import { askAudience, authorLabel } from "./group.js";
import { quoteOf } from "./reply.js";
import { timeLineOf } from "../time/show.js";
import { metaOf } from "./stamp.js";
import { useRouter } from "expo-router";
import { artifactHref, artifactOf } from "./extras.js";
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
  s9: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 },
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
function Frame({ children, indent, wide, dense }: { children: React.ReactNode; indent?: boolean; wide: boolean; dense?: boolean }) {
  return (
    <View style={{ width: "100%", maxWidth: MAX, alignSelf: "center", marginLeft: "auto", marginRight: "auto", paddingHorizontal: wide ? 24 : 16, paddingVertical: dense ? 1 : 6, paddingLeft: (wide ? 24 : 16) + (indent ? BODY_INDENT : 0) }}>
      {children}
    </View>
  );
}

function Who({ name, family, meta, sub }: { name: string; family: "person" | "assistant" | "model"; meta?: string; sub?: string | null }) {
  return (
    <View style={S.s1}>
      <View style={S.s2}>
        <Text strong>{name}</Text>
        {meta ? <Text size="caption" tone="label">{meta}</Text> : null}
      </View>
      {sub ? <Text size="caption" tone="label">{sub}</Text> : null}
    </View>
  );
}

type Dress = { flash?: boolean; mentioned?: boolean; divider?: number | null; pinned?: boolean; replies?: number; reply?: boolean; cut?: string | null };


/** The actions under a message (Copy, Highlight, Reply, Edit...) show on hover on a desktop and on a long press on a phone: one quiet row, its room kept so nothing jumps. */
const ActionsOn = createContext(false);
/** Screenshots of the sample world can show the actions row without a pointer (?actions=1). */
const showActions = () => allowsMock() && typeof location !== "undefined" && /[?&]actions=1/.test(location.search);
function ActionRow({ children }: { children: React.ReactNode }) {
  const on = useContext(ActionsOn);
  return (
    <View pointerEvents={on ? "auto" : "none"} accessibilityElementsHidden={!on} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, minHeight: 28, opacity: on ? 1 : 0 }}>
      {children}
    </View>
  );
}

function Message({ who, family, meta, sub, dress, children, wide, provider }: { who: string; family: "person" | "assistant" | "model"; meta?: string; sub?: string | null; dress?: Dress; children: React.ReactNode; wide: boolean; provider?: string | null }) {
  const [hover, setHover] = useState(false);
  const [held, setHeld] = useState(false);
  const { color } = useUiTheme();
  return (
    <View {...({ dataSet: { from: who } } as object)} style={{ width: "100%", maxWidth: MAX, alignSelf: "center", marginLeft: "auto", marginRight: "auto" }}>
      {dress?.divider ? <View style={{ paddingHorizontal: wide ? 24 : 16 }}><UnreadDivider count={dress.divider} /></View> : null}
      <Pressable onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)} onLongPress={() => setHeld((v) => !v)} delayLongPress={450} accessible={false}>
      <ActionsOn.Provider value={hover || held || showActions()}>
      <View style={{ paddingHorizontal: wide ? 24 : 16, paddingVertical: 8, flexDirection: wide ? "row" : "column", gap: wide ? 12 : 4, ...(dress?.mentioned || dress?.flash ? { backgroundColor: color["accent-wash"], borderLeftWidth: 2, borderLeftColor: color.accent, paddingLeft: wide ? 22 : 14 } : {}) }}>
        {wide ? <Face name={who} family={family} size={32} provider={provider} /> : null}
        <View style={S.s3}>
          {/* on a phone the face is a small mark beside the name, so the words use the whole width instead of an indent */}
          {wide ? <Who name={who} family={family} meta={dress?.pinned ? (meta ? meta + " · pinned" : "pinned") : meta} sub={sub} /> : <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Face name={who} family={family} size={20} provider={provider} /><Who name={who} family={family} meta={dress?.pinned ? (meta ? meta + " · pinned" : "pinned") : meta} sub={sub} /></View>}
          {dress?.reply ? <Text size="caption" tone="label">in a reply</Text> : null}
          {children}
          {dress?.cut ? <Text size="caption" tone="warn">{dress.cut}</Text> : null}
          {dress?.replies ? <Text size="caption" tone="accent">{`${dress.replies} ${dress.replies === 1 ? "reply" : "replies"}`}</Text> : null}
        </View>
      </View>
      </ActionsOn.Provider>
      </Pressable>
    </View>
  );
}

/** Highlight to assistant: the message, or the part of it the person selected, goes above the composer as a quoted reference. Nothing is sent. */
/** The one renderer for words that may name a Vault item (vault://name): the name is a small shield chip wherever it sits, in a person's message or an assistant's reply. Plain words stay plain text. */
export function refNodes(text: string): React.ReactNode {
  const parts = partsOf(text);
  if (!parts.some((p) => "vault" in p)) return text;
  return parts.map((p, i) => ("vault" in p ? <View key={i} style={{ marginHorizontal: 2, transform: [{ translateY: 5 }] }}><Chip tone="ok" icon="shield">{itemLabel(p.vault)}</Chip></View> : p.text));
}
export function RefText({ text, style }: { text: string; style?: object }) {
  return <Text size="read" selectable style={style}>{refNodes(text)}</Text>;
}

/** A person's words. A key they pasted was moved to the Vault and left a reference (vault://name): it reads as a chip, and one quiet line under the words says it is secured. */
export function UserText({ text, pending }: { text: string; pending: boolean }) {
  const style = pending ? { opacity: 0.55 } : undefined;
  const names = [...new Set(partsOf(text).flatMap((p) => ("vault" in p ? [p.vault] : [])))];
  if (!names.length) return <Text size="read" selectable style={style}>{text}</Text>;
  return (
    <View style={{ gap: 6 }}>
      <RefText text={text} style={style} />
      <View accessibilityLabel={`${names.join(", ")} secured in the Vault`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="shield" size={14} tone="ok" />
        <Text size="caption" tone="muted">{names.length === 1 ? "Secured in the Vault" : `${names.length} keys secured in the Vault`}</Text>
      </View>
    </View>
  );
}

function HighlightAction({ from, text, ctx }: { from: string; text: string; ctx: BlockCtx }) {
  const { color } = useUiTheme();
  const picked = useRef("");
  if (!ctx.onHighlight) return null;
  return (
    <View style={S.s4}>
      <Pressable accessibilityRole="button" accessibilityLabel="Ask about this" onPressIn={() => { picked.current = readSelection(); }} onPress={() => ctx.onHighlight?.({ from, text, selected: picked.current })} style={{ minHeight: ctx.wide ? 28 : 44, justifyContent: "center", paddingHorizontal: 8, marginLeft: -8, borderRadius: 8 }}>
        <Text size="caption" tone="label">Ask about this</Text>
      </Pressable>
    </View>
  );
}

function MessageActions({ uuid, text, ctx }: { uuid: string; text: string; ctx: BlockCtx }) {
  const { color } = useUiTheme();
  if (!ctx.onRetryMessage && !ctx.onEditMessage && !ctx.onBranchFrom) return null;
  const h = ctx.wide ? 28 : 44;
  const act = (label: string, run?: () => void) => run ? (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label} this message`} onPress={run} style={{ minHeight: h, justifyContent: "center", paddingHorizontal: 8, marginLeft: -8, borderRadius: 8 }}>
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


/** Copy, Copy as Markdown, and one Copy code for each fenced block of a finished answer (12.1). */
function AnswerActions({ text, ctx }: { text: string; ctx: BlockCtx }) {
  const [said, setSaid] = useState("");
  const h = ctx.wide ? 28 : 44;
  const forms = copyForms(text);
  const blocks = codeBlocks(text);
  const go = (label: string, body: string) => { void copy(body, ctx); setSaid(label); setTimeout(() => setSaid(""), 1500); };
  const btn = (label: string, body: string, name = label) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={name} onPress={() => go(label, body)} style={{ minHeight: h, justifyContent: "center", paddingHorizontal: 8, marginLeft: -8, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Icon name="copy" tone="label" />
      <Text size="caption" tone="label">{said === label ? "Copied" : label}</Text>
    </Pressable>
  );
  return (
    <View style={S.s4}>
      {btn("Copy", forms.plain, "Copy this answer")}
      {btn("Copy as Markdown", forms.markdown)}
      {blocks.map((b, i) => btn(blocks.length > 1 ? `Copy code ${i + 1}` : "Copy code", b.code))}
    </View>
  );
}

/** An assistant's words as markdown (the design system's one renderer): while it streams in, what has arrived so far is drawn, an unclosed mark or fence kept as it is. */
function StreamText({ store, k, text, done, ctx }: { store: ChatStore; k: string; text: string; done: boolean; ctx: BlockCtx }) {
  const n = store.shown(k);
  const cut = n === undefined ? text.length : Math.min(n, text.length);
  return <Markdown text={cut >= text.length ? text : text.slice(0, cut)} onCopy={(code) => void copy(code, ctx)} textNode={refNodes} tail={showsCaret({ done }) ? <Caret /> : undefined} />;
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


/** A teammate's own step or words sit under the hand-off they answer, behind a rule (data.via). */
function Nested({ it, children }: { it: any; children: React.ReactNode }) {
  const { color } = useUiTheme();
  if (!it.via) return <>{children}</>;
  return <View style={{ marginLeft: 12, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: color.edge }}>{children}</View>;
}

/** "Asked kit (billing)", its state, and the teammate's report-back as quoted data: what a teammate wrote is never drawn as the person's words. */
function HandoffLine({ it, store }: { it: any; store: ChatStore }) {
  const { color } = useUiTheme();
  const label = `Asked ${it.name}` + (it.role && it.role !== it.name ? ` (${it.role})` : "");
  const state = it.state === "running" ? "working" : it.state;
  const router = useRouter();
  // Once the teammate has a conversation of its own (it carries the thread), the row opens it.
  const open = it.thread ? () => { if (!allowsMock()) router.push({ pathname: "/u/chats/[id]", params: { id: String(it.thread) } }); } : undefined;
  const Row = open ? Pressable : View;
  return (
    <Row style={{ gap: 4 }} accessibilityLabel={`${label}, ${state}`} {...(open ? { onPress: open, accessibilityRole: "link" as const, accessibilityHint: `Opens ${it.name}'s conversation` } : {})}>
      <View style={S.s9}>
        <Face name={it.name || it.agent} family="assistant" size={24} id={`agent:${it.agent}`} />
        <Text size="caption" strong numberOfLines={1}>{label}</Text>
        {it.project ? <Text size="caption" tone="label" numberOfLines={1} style={S.s10}>{`· ${String(it.project)}`}</Text> : <View style={S.s10} />}
        <Text size="caption" tone={it.state === "failed" ? "err" : "label"}>{state}</Text>
        {open ? <Icon name="chev-r" size={14} tone="muted" /> : null}
      </View>
      {it.text ? <Text size="caption" tone="muted" numberOfLines={2}>{it.text}</Text> : null}
    </Row>
  );
}

/** "3 files, 4 commands, 1 min" under a turn: opens the changes panel, every file the turn touched with its diff. */
export function TurnChip({ it, ctx, session, defaultOpen = false }: { it: any; ctx: BlockCtx; session: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [said, setSaid] = useState<Record<string, string>>({});
  const diff = useMemo(() => { const n = normalizeBlock({ block: "files", files: it.diffs }); return n.block === "diff" ? n : { block: "diff" as const, files: [] }; }, [it.diffs]);
  const has = diff.files.length > 0;
  /** Put one file back as it was before the turn; the box refuses, in words, when the file has changed since. */
  const undo = (path: string) => tool<{ restored: string }>("threads.undo-edit", { thread: session, path })
    .then((r) => setSaid((m) => ({ ...m, [path]: r.restored === "removed" ? "Removed again" : "Put back" })))
    .catch((e) => setSaid((m) => ({ ...m, [path]: e instanceof Error && e.message ? e.message : "That did not go through." })));
  return (
    <View>
      <Chip tone="plain" icon={has ? "file" : undefined} onPress={has ? () => setOpen(true) : undefined}>{it.line}</Chip>
      {has ? (
        <Sheet open={open} onClose={() => setOpen(false)} title="Changes in this turn">
          <View style={{ padding: 16, gap: 12 }}>
            <BlockView block={diff} ctx={ctx} />
            {(it.files || []).map((f: { path: string }) => (
              <View key={f.path} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text size="caption" mono numberOfLines={1} style={{ flex: 1 }}>{f.path}</Text>
                {said[f.path] ? <Text size="caption" tone="label">{said[f.path]}</Text> : <Button size="sm" kind="ghost" label="Undo" onPress={() => void undo(f.path)} />}
              </View>
            ))}
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}

/** What the teammate reported back, quoted: data from another session, never the person's words. */
function HandoffResult({ it }: { it: any }) {
  const { color } = useUiTheme();
  return (
    <View style={{ gap: 2 }} accessibilityLabel={`${it.name} reported back`}>
      <Text size="caption" tone="label">{`${it.name} reported`}</Text>
      <View style={{ borderLeftWidth: 3, borderLeftColor: color.edge, paddingLeft: 10 }}><Text size="caption" tone="muted" selectable>{it.result}</Text></View>
    </View>
  );
}

function ToolLine({ it, running }: { it: any; running: boolean }) {
  const [open, setOpen] = useState(false);
  // the plain words ("Looking up overdue invoices"); the tool's own name is the detail, one tap away
  const words = String(it.summary || "").trim() || String(it.tool);
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${words}. ${open ? "Hide" : "Show"} the details`} onPress={() => setOpen((v) => !v)}>
      <View style={S.s9}>
        {running ? <Turning name="refresh" /> : <Icon name={it.status === "failed" ? "failed" : "check"} tone={it.status === "failed" ? "err" : "text-2"} />}
        <Text size="caption" tone={running ? "default" : "muted"} numberOfLines={1} style={S.s10}>{words}</Text>
        {running ? <Text size="caption" tone="label">running</Text> : null}
      </View>
      {open ? <Text size="caption" tone="label" mono style={{ paddingLeft: 28 }}>{`${it.tool}${it.status === "failed" ? " failed" : ""}`}</Text> : null}
    </Pressable>
  );
}

/** The assistant's thinking, folded: a quiet line that opens to the words. Never the reply itself. */
function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const { color } = useUiTheme();
  const [open, setOpen] = useState(false);
  // how long it thought, from the moment we saw it start to the moment it finished; a thread loaded from before has no start to quote
  const t0 = useRef(streaming ? Date.now() : 0);
  const [took, setTook] = useState(0);
  useEffect(() => { if (streaming && !t0.current) t0.current = Date.now(); if (!streaming && t0.current) { setTook(Date.now() - t0.current); t0.current = 0; } }, [streaming]);
  return (
    <View style={{ gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={open ? "Hide the thinking" : "Show the thinking"} onPress={() => setOpen((v) => !v)} style={{ minHeight: 22, justifyContent: "center", alignSelf: "flex-start" }}>
        <Text size="caption" tone="label">{`${thoughtWord(streaming, took)} ${open ? "▾" : "▸"}`}</Text>
      </Pressable>
      {open ? <View style={{ borderLeftWidth: 2, borderLeftColor: color.edge ?? color.hover, paddingLeft: 10 }}><Text size="caption" tone="muted" selectable>{text}</Text></View> : null}
    </View>
  );
}

/** Who wrote this row. Without an author on the frame (a one-to-one over the old stream) it is the person or the assistant of the chat. */
function whoOf(store: ChatStore, k: string): { name: string; family: "person" | "assistant" | "model"; sub: string | null } {
  if (store.group.author(k.slice(2))?.author) return store.group.label(k);
  // The sample names (alex, juno) belong to the sample world only: a real chat says You and the chat's own assistant.
  // "o:" is a message the person just sent, shown before the box has echoed it
  const own = k.startsWith("u:") || k.startsWith("o:");
  if (!allowsMock()) return own ? { name: "You", family: "person", sub: null } : { name: store.group.assistantName(), family: "assistant", sub: null };
  return own ? { name: PERSON, family: "person", sub: null } : { name: ASSISTANT, family: "assistant", sub: null };
}

function dressOf(store: ChatStore, k: string, text: string, ctx: BlockCtx): Dress {
  const g = store.group;
  const m = k.slice(2);
  const d = g.divider();
  return { flash: ctx.flash === m, mentioned: g.mentioned(m, text), divider: d.key === k ? d.count : null, pinned: g.pinned(m), replies: g.replyCount(m), reply: !!g.parent(m), cut: g.cut(m) };
}

/** The small quote above a reply: who said it and the first words. Tapping it goes to the original and lights it up; it never opens a side thread. */
function QuoteBlock({ store, it, ctx }: { store: ChatStore; it: { [k: string]: any }; ctx: BlockCtx }) {
  const { color } = useUiTheme();
  const q = quoteOf(it);
  if (!q) return null;
  const who = q.author ? authorLabel({ author: q.author, viewer: store.group.viewer, names: store.group.names() }).name : "";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Go to the message${who ? ` from ${who}` : ""}`} onPress={() => ctx.onJumpTo?.(q.message)}
      style={{ borderLeftWidth: 3, borderLeftColor: color.accent, backgroundColor: color["surface-2"], borderRadius: 6, paddingVertical: 4, paddingHorizontal: 8, gap: 1, alignSelf: "flex-start", maxWidth: "100%" }}>
      {who ? <Text size="caption" strong tone="accent" numberOfLines={1}>{who}</Text> : null}
      <Text size="caption" tone="muted" numberOfLines={2}>{q.text || "A message above"}</Text>
    </Pressable>
  );
}

/** Reply to a message in any chat: swipe it on a phone, or long-press it anywhere. The same timeline, never a thread. */
function Replyable({ ctx, message, name, text, children }: { ctx: BlockCtx; message: string; name: string; text: string; children: React.ReactNode }) {
  const go = ctx.onReplyTo ? () => ctx.onReplyTo?.(message, name, text) : undefined;
  if (!go) return <>{children}</>;
  return (
    <SwipeActions enabled={!ctx.wide} leading={[{ id: "reply", label: "Reply", icon: "back", tone: "accent", onPress: go, haptic: "selection" }]}>
      <Pressable accessibilityActions={[{ name: "reply", label: "Reply" }]} onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === "reply") go(); }}>{children}</Pressable>
    </SwipeActions>
  );
}

/** Reactions and the Reply / React / Pin tools, only in a chat that has people in it (a group). */
function GroupTools({ store, k, ctx, name }: { store: ChatStore; k: string; ctx: BlockCtx; name: string }) {
  const g = store.group;
  const m = k.slice(2);
  if (!g.participants().length) return ctx.onReplyTo ? <MessageTools big={!ctx.wide} pinned={false} onReply={() => ctx.onReplyTo?.(m, name, "")} /> : null;
  return (
    <>
      <Reactions items={g.reactions(m)} big={!ctx.wide} onToggle={(e, mine) => store.social.react(m, e, mine)} />
      <MessageTools big={!ctx.wide} pinned={g.pinned(m)} onReply={ctx.onReplyTo ? () => ctx.onReplyTo?.(m, name, "") : undefined} onReact={(e) => store.social.react(m, e)} onPin={(p) => store.social.pin(m, p)} />
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
        <Replyable ctx={ctx} message={k.slice(2)} name={w.name} text={it.text}>
        <Message who={w.name} family={w.family} sub={it.via === "assistant" ? "(Sent by Vyre Assistant)" : w.sub} meta={metaOf(it, timeLineOf)} dress={dressOf(store, k, it.text, ctx)} wide={wide}>
          <QuoteBlock store={store} it={it} ctx={ctx} />
          <UserText text={it.text} pending={!!it.pending} />
          {Array.isArray(it.attachments) && it.attachments.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{it.attachments.map((a: { id: string; name: string; bytes: number }) => <Chip key={a.id} tone="plain" icon="file">{`${a.name} · ${sizeWord(a.bytes)}`}</Chip>)}</View> : null}
          {it.pending ? <Text size="caption" tone="label">Sending</Text> : null}
          {it.pending ? null : (
            <ActionRow>
              {mine ? <MessageActions uuid={k.slice(2)} text={it.text} ctx={ctx} /> : null}
              <HighlightAction from={w.name} text={it.text} ctx={ctx} />
              <GroupTools store={store} k={k} ctx={ctx} name={w.name} />
            </ActionRow>
          )}
        </Message>
        </Replyable>
      );
    }
    case "text": {
      const fo = store.group.fanoutAt(k);
      if (fo) {
        if (!fo.first) return null;
        return <Frame wide={wide} indent={wide}><FanoutSet store={store} fanout={fo.fanout} wide={wide} renderText={(key) => { const x = store.item(key); return x ? <StreamText store={store} k={key} text={x.text} done={x.done} ctx={ctx} /> : null; }} /></Frame>;
      }
      const w = whoOf(store, k);
      return (
        <Replyable ctx={ctx} message={k.slice(2)} name={w.name} text={it.text}>
        <Message who={w.name} family={w.family} sub={w.sub} dress={dressOf(store, k, it.text, ctx)} wide={wide} provider={it.provider ?? null}>
          <StreamText store={store} k={k} text={it.text} done={it.done} ctx={ctx} />
          {it.done ? (
            <ActionRow>
              <AnswerActions text={it.text} ctx={ctx} />
              <HighlightAction from={w.name} text={it.text} ctx={ctx} />
              <GroupTools store={store} k={k} ctx={ctx} name={w.name} />
            </ActionRow>
          ) : <GroupTools store={store} k={k} ctx={ctx} name={w.name} />}
        </Message>
        </Replyable>
      );
    }
    case "handoffResult":
      return <Frame wide={wide} indent dense><HandoffResult it={it} /></Frame>;
    case "turnsummary":
      return <Frame wide={wide} indent dense><TurnChip it={it} ctx={ctx} session={store.session} /></Frame>;
    case "handoff":
      return <Frame wide={wide} indent dense><HandoffLine it={it} store={store} /></Frame>;
    case "tool":
      return <Frame wide={wide} indent dense><Nested it={it}><ToolLine it={it} running={it.status === "running"} /></Nested></Frame>;
    case "block": {
      const running = it.status === "running";
      let block: Block | null = it.block ? normalizeBlock(it.block, `${it.tool} ${it.summary}`.trim()) : null;
      if (!block && it.toolKind === "terminal") block = { block: "terminal", command: it.summary, output: it.output, exit: null, running: true };
      const art = block && block.block === "text" ? artifactOf(it.key, block.text) : null;
      if (art) return <Frame wide={wide} indent><ArtifactLink title={art.title} href={artifactHref(art)} /></Frame>;
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
    case "reasoning":
      return <Frame wide={wide} indent dense><Reasoning text={String(it.text)} streaming={!it.done} /></Frame>;
    case "notice":
      return <Frame wide={wide} indent><Text size="caption" tone="label">{String(it.text).replace(/\b(?:person|assistant|model):/g, "")}</Text></Frame>;
    default:
      return null;
  }
}

/** An artifact made in this chat: one tap opens its page. */
function ArtifactLink({ title, href }: { title: string; href: string }) {
  const router = useRouter();
  const { color } = useUiTheme();
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`Open ${title}`} onPress={() => router.push(href as never)} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], alignSelf: "flex-start" }}>
      <Icon name="file" />
      <Text strong numberOfLines={1}>{title}</Text>
      <Icon name="chev" />
    </Pressable>
  );
}

export const ChatRow = memo(
  function ChatRow({ store, row, ctx }: { store: ChatStore; row: LayoutRow; ctx: BlockCtx }) {
    return <ItemBody store={store} k={row.key} ctx={ctx} />;
  },
  (a, b) => a.store === b.store && a.row.key === b.row.key && a.row.kind === b.row.kind && a.ctx === b.ctx,
);
