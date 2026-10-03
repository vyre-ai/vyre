// The native result components (design idea 2): one component per Block kind, never raw JSON.
// `renderBlock(block, ctx)` is the one switch, keyed on the Block contract (docs/work/chat.md, 0.3);
// anything it does not know has already degraded to a short text block (blocks.js). A sealed field
// is the typed placeholder chip and never a value. Callbacks (open terminal, open in Drive, Face ID,
// take over) arrive in `ctx`: the screen decides what they do.

import { memo, useMemo, useState, type ReactNode } from "react";
import { Image, Pressable, ScrollView, TextInput, View, StyleSheet } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Button, Chip, Icon, IconButton, Text, useUiTheme } from "@vyre/ui";
import { parseAnsi, stripAnsi } from "./ansi.js";
import { countDiff, fileTree, parseUnified, sealedCount, sideBySide, TREE_AT, type Block, type DiffFile, type RecordField } from "./blocks.js";

const S = StyleSheet.create({
  s1: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, minHeight: 44, paddingVertical: 4 },
  s2: { flex: 1, minWidth: 0 },
  s3: { alignSelf: "center" },
  s4: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, minHeight: 40, borderBottomWidth: 1, borderBottomColor: "#2A2825" },
  s5: { flex: 1, minWidth: 0, minHeight: 40, justifyContent: "center" },
  s6: { minHeight: 28, justifyContent: "center" },
  s7: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, borderTopWidth: 1, borderTopColor: "#2A2825" },
  s8: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8 },
  s9: { flex: 1 },
  s10: { minHeight: 40, justifyContent: "center", paddingHorizontal: 8 },
  s11: { padding: 12 },
  s12: { flexDirection: "row" },
  s13: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40 },
  s14: { paddingVertical: 4 },
  s15: { paddingHorizontal: 12, paddingVertical: 2 },
  s16: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, minHeight: 36 },
  s17: { padding: 8 },
  s18: { gap: 6 },
  s19: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 24 },
  s20: { width: 88 },
  s21: { flex: 1, minWidth: 0, flexDirection: "row" },
  s22: { flexShrink: 1 },
  s23: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  s24: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  s25: { flexDirection: "row", gap: 8 },
  s26: { gap: 4 },
  s27: { width: "100%", height: "100%" },
});


export type BlockCtx = {
  /** A wide screen shows diffs side by side. */
  wide: boolean;
  onOpenTerminal?: (command: string) => void;
  onOpenInDrive?: (path: string) => void;
  onOpenRecord?: (urn: string) => void;
  onOpenFlow?: () => void;
  onOpenSource?: (url: string) => void;
  onTakeOver?: () => void;
  onCopy?: (text: string) => void;
  /** Face ID for a task's approval: resolves true when the person passed. */
  onFaceId?: () => Promise<boolean>;
  onApprove?: (taskId: string) => void;
  onDecline?: (taskId: string) => void;
  /** A person's own message: edit it and run again, run it again as it was, or branch the session from before it. */
  onEditMessage?: (uuid: string, text: string) => void;
  onRetryMessage?: (uuid: string) => void;
  onBranchFrom?: (uuid: string) => void;
  /** Group chats: reply in a thread to a message (its id and its author's name). */
  onReplyTo?: (message: string, name: string) => void;
  /** The tool is still running (live output, caret). */
  live?: boolean;
};

const copy = async (text: string, ctx: BlockCtx) => {
  if (ctx.onCopy) return ctx.onCopy(text);
  try { await Clipboard.setStringAsync(text); } catch {}
};

/** The shell every block shares: a hairline card on surface-2, a header line, a body. */
function Shell({ icon, title, sub, right, children, flush, tint }: { icon: "terminal" | "file" | "key" | "todo" | "chat" | "refresh" | "globe" | "link" | "check"; title: ReactNode; sub?: string; right?: ReactNode; children?: ReactNode; flush?: boolean; tint?: "accent" }) {
  const { color } = useUiTheme();
  return (
    <View style={{ borderWidth: 1, borderColor: tint ? color["edge-strong"] : color.edge, backgroundColor: tint ? color["accent-wash"] : color["surface-2"], borderRadius: 12, overflow: "hidden", minWidth: 0 }}>
      <View style={S.s1}>
        <Icon name={icon} />
        <View style={S.s2}>
          {typeof title === "string" ? <Text strong numberOfLines={2}>{title}</Text> : title}
          {sub ? <Text size="caption" tone="label" numberOfLines={1}>{sub}</Text> : null}
        </View>
        {right ? <View style={S.s3}>{right}</View> : null}
      </View>
      {children ? <View style={flush ? undefined : { paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}>{children}</View> : null}
    </View>
  );
}

// ---------------------------------------------------------------- terminal

const ANSI: Record<string, string> = { black: "#6B665D", red: "#F2796B", green: "#7FD08A", yellow: "#E3B26B", blue: "#8FB7E8", magenta: "#D6A5E8", cyan: "#7BD3D3", white: "#D8D3C8" };
const TERM_BG = "#0B0A09";
const TERM_INK = "#D8D3C8";
const TERM_LINE = 20;

export function TerminalBlock({ block, ctx, output, running }: { block: Extract<Block, { block: "terminal" }>; ctx: BlockCtx; output?: string; running?: boolean }) {
  const { color } = useUiTheme();
  const [open, setOpen] = useState(false);
  const text = output ?? block.output;
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const live = running ?? block.running;
  const shown = open ? lines : lines.slice(-5);
  const hidden = lines.length - shown.length;
  const exit = block.exit;
  return (
    <View style={{ borderWidth: 1, borderColor: "#2A2825", backgroundColor: TERM_BG, borderRadius: 12, overflow: "hidden", minWidth: 0 }}>
      <View style={S.s4}>
        <Icon name="terminal" tone="label" />
        <Pressable accessibilityRole="button" accessibilityLabel={open ? "Collapse output" : "Expand output"} accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} style={S.s5}>
          <Text mono size="caption" numberOfLines={1} style={{ color: TERM_INK }}>{block.command ? `$ ${block.command}` : "Terminal"}</Text>
        </Pressable>
        <View style={S.s3}>
          {live ? <Chip tone="accent">running</Chip> : exit != null ? <Chip tone={exit === 0 ? "ok" : "err"}>{exit === 0 ? "exit 0" : `exit ${exit}`}</Chip> : null}
        </View>
      </View>
      <ScrollView nestedScrollEnabled style={{ maxHeight: open ? 320 : undefined }} contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 10 }}>
        {hidden > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={S.s6}>
            <Text size="caption" style={{ color: ANSI.black }}>{hidden} earlier line{hidden === 1 ? "" : "s"}, show all</Text>
          </Pressable>
        ) : null}
        {shown.map((line, i) => (
          <Text key={i} mono selectable style={{ color: TERM_INK, fontSize: 12.5, lineHeight: TERM_LINE }}>
            {parseAnsi(line).map((s, j) => (
              <Text key={j} mono style={{ color: s.fg ? ANSI[s.fg] : TERM_INK, fontWeight: s.bold ? "700" : undefined, opacity: s.dim ? 0.6 : 1, fontSize: 12.5, lineHeight: TERM_LINE }}>{s.text}</Text>
            ))}
            {line === "" ? " " : null}
          </Text>
        ))}
        {live ? <View style={{ width: 8, height: 15, backgroundColor: TERM_INK, marginTop: 2, opacity: 0.8 }} /> : null}
      </ScrollView>
      <View style={S.s7}>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy output" onPress={() => copy(stripAnsi(text), ctx)} style={S.s8}>
          <Icon name="copy" tone="label" /><Text size="caption" style={{ color: ANSI.white }}>Copy</Text>
        </Pressable>
        {ctx.onOpenTerminal ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Open full terminal" onPress={() => ctx.onOpenTerminal?.(block.command)} style={S.s8}>
            <Icon name="terminal" tone="label" /><Text size="caption" style={{ color: ANSI.white }}>Open full terminal</Text>
          </Pressable>
        ) : null}
        <View style={S.s9} />
        {lines.length > 5 ? (
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} style={S.s10}>
            <Text size="caption" style={{ color: ANSI.white }}>{open ? "Collapse" : "Expand"}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- diff

const MONO = { fontSize: 12, lineHeight: 19 } as const;

function DiffLines({ file, wide }: { file: DiffFile; wide: boolean }) {
  const { color } = useUiTheme();
  const lines = useMemo(() => parseUnified(file.diff), [file.diff]);
  const tone = (t: string) => (t === "add" ? { bg: color["ok-wash"], ink: color.ok } : t === "del" ? { bg: color["err-wash"], ink: color.err } : { bg: "transparent", ink: t === "hunk" ? color.faint : color.label });
  const sign = (t: string) => (t === "add" ? "+ " : t === "del" ? "- " : "  ");
  if (!lines.length) return <Text size="caption" tone="label" style={S.s11}>{file.op === "create" ? "New file" : file.op === "delete" ? "File removed" : "No line changes to show"}</Text>;
  if (wide) {
    const pairs = sideBySide(lines);
    return (
      <View>
        {pairs.map((p, i) => (
          <View key={i} style={S.s12}>
            {[p.left, p.right].map((l, k) => {
              const t = l ? tone(l.t) : { bg: "transparent", ink: color.label };
              return (
                <View key={k} style={{ flex: 1, minWidth: 0, backgroundColor: l && (k === 0 ? l.t === "del" || l.t === "ctx" : l.t === "add" || l.t === "ctx") ? t.bg : "transparent", paddingHorizontal: 12, borderLeftWidth: k ? 1 : 0, borderLeftColor: color.edge }}>
                  <Text mono style={{ ...MONO, color: t.ink }}>{l ? (k === 0 && l.t === "add" ? " " : k === 1 && l.t === "del" ? " " : l.text || " ") : " "}</Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    );
  }
  return (
    <View>
      {lines.map((l, i) => {
        const t = tone(l.t);
        return (
          <View key={i} style={{ backgroundColor: t.bg, paddingHorizontal: 12 }}>
            <Text mono style={{ ...MONO, color: t.ink }}>{l.t === "hunk" ? l.text : sign(l.t) + l.text}</Text>
          </View>
        );
      })}
    </View>
  );
}

function FileHead({ file, ctx, onPress, open }: { file: DiffFile; ctx: BlockCtx; onPress?: () => void; open?: boolean }) {
  const { color } = useUiTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, minHeight: 40, borderBottomWidth: 1, borderBottomColor: color.edge }}>
      <Pressable accessibilityRole={onPress ? "button" : undefined} accessibilityState={onPress ? { expanded: !!open } : undefined} onPress={onPress} style={S.s13}>
        <Icon name="file" />
        <Text mono size="caption" strong numberOfLines={1} style={S.s9}>{file.path}</Text>
      </Pressable>
      <Text size="caption" tone="ok" mono>+{file.add}</Text>
      <Text size="caption" tone="err" mono>-{file.del}</Text>
      {ctx.onOpenInDrive ? <IconButton icon="drive" label="Open in Drive" onPress={() => ctx.onOpenInDrive?.(file.path)} /> : null}
    </View>
  );
}

export function DiffBlock({ block, ctx }: { block: Extract<Block, { block: "diff" }>; ctx: BlockCtx }) {
  const { color } = useUiTheme();
  const many = block.files.length > TREE_AT;
  const [openFile, setOpenFile] = useState<string | null>(null);
  const tree = useMemo(() => (many ? fileTree(block.files) : []), [many, block.files]);
  const add = block.files.reduce((n, f) => n + f.add, 0);
  const del = block.files.reduce((n, f) => n + f.del, 0);
  const frame = { borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], borderRadius: 12, overflow: "hidden", minWidth: 0 } as const;
  if (!many) {
    return (
      <View style={frame}>
        {block.files.map((f) => (
          <View key={f.path}>
            <FileHead file={f} ctx={ctx} />
            <DiffLines file={f} wide={ctx.wide} />
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={frame}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, minHeight: 40, borderBottomWidth: 1, borderBottomColor: color.edge }}>
        <Icon name="file" />
        <Text strong style={S.s9}>{block.files.length} files changed</Text>
        <Text size="caption" tone="ok" mono>+{add}</Text>
        <Text size="caption" tone="err" mono>-{del}</Text>
      </View>
      {tree.map((g) => (
        <View key={g.dir} style={S.s14}>
          <Text size="caption" tone="label" mono style={S.s15}>{g.dir === "." ? "(root)" : g.dir + "/"}</Text>
          {g.files.map((f) => {
            const path = g.dir === "." ? f.name : `${g.dir}/${f.name}`;
            const full = block.files.find((x) => x.path === path);
            const open = openFile === path;
            return (
              <View key={path}>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpenFile(open ? null : path)} style={S.s16}>
                  <Chip tone={f.op === "create" ? "ok" : f.op === "delete" ? "err" : "plain"}>{f.op === "create" ? "new" : f.op === "delete" ? "gone" : "edit"}</Chip>
                  <Text mono size="caption" numberOfLines={1} style={S.s9}>{f.name}</Text>
                  <Text size="caption" tone="ok" mono>+{f.add}</Text>
                  <Text size="caption" tone="err" mono>-{f.del}</Text>
                </Pressable>
                {open && full ? (
                  <View style={{ borderTopWidth: 1, borderTopColor: color.edge }}>
                    <DiffLines file={full} wide={ctx.wide} />
                    {ctx.onOpenInDrive ? <View style={S.s17}><Button size="sm" icon="drive" label="Open in Drive" onPress={() => ctx.onOpenInDrive?.(path)} /></View> : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- record

/** A sealed field: the typed placeholder chip, never a value. */
export function SealedChip({ f }: { f: Extract<RecordField, { sealed: true }> }) {
  return <Chip tone="sealed" icon="shield">{`${f.cls}: ${f.present ? "on file, sealed" : "not set, sealed"}`}</Chip>;
}

export function RecordCard({ block, ctx }: { block: Extract<Block, { block: "record" }>; ctx: BlockCtx }) {
  const sealed = sealedCount(block);
  return (
    <Shell icon="file" title={block.title} sub={block.type} right={sealed ? <Chip tone="sealed" icon="shield">{`${sealed} sealed`}</Chip> : null}>
      <View style={S.s18}>
        {block.fields.map((f) => (
          <View key={f.label} style={S.s19}>
            <Text size="caption" tone="label" style={S.s20} numberOfLines={1}>{f.label}</Text>
            <View style={S.s21}>
              {f.sealed ? <SealedChip f={f} /> : <Text numberOfLines={1} style={S.s22}>{f.value}</Text>}
            </View>
          </View>
        ))}
      </View>
      {block.urn && ctx.onOpenRecord ? <View style={S.s12}><Button size="sm" label="Open record" onPress={() => ctx.onOpenRecord?.(block.urn!)} /></View> : null}
    </Shell>
  );
}

// ---------------------------------------------------------------- task

/** A task card, approvals inline (never a modal): Face ID is a callback the screen answers. */
export function TaskCard({ block, ctx, decided }: { block: Extract<Block, { block: "task" }>; ctx: BlockCtx; decided?: "approve" | "deny" | null }) {
  const [busy, setBusy] = useState(false);
  const state = decided === "approve" ? "done" : decided === "deny" ? "declined" : block.state;
  const approve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (block.face && ctx.onFaceId && !(await ctx.onFaceId())) return;
      ctx.onApprove?.(block.id);
    } finally { setBusy(false); }
  };
  return (
    <Shell icon="todo" tint={state === "needs-approval" ? "accent" : undefined} title={<Text strong>{block.title}</Text>} sub={block.doer ? `For ${block.doer}` : undefined}
      right={state === "needs-approval" ? <Chip tone="accent" icon="now">Needs you</Chip> : state === "done" ? <Chip tone="ok" icon="check">Approved</Chip> : state === "declined" ? <Chip icon="x">Declined</Chip> : null}>
      {block.why ? <Text tone="muted">{block.why}</Text> : null}
      {block.tags.length ? <View style={S.s23}>{block.tags.map((t) => <Chip key={t}>{t}</Chip>)}</View> : null}
      {state === "needs-approval" ? (
        <View style={S.s24}>
          <Button kind="primary" icon={block.face ? "faceid" : "check"} label={block.approve} onPress={approve} />
          <Button kind="ghost" size="sm" label="Decline" onPress={() => ctx.onDecline?.(block.id)} />
        </View>
      ) : null}
    </Shell>
  );
}

// ---------------------------------------------------------------- draft

export function DraftBlock({ block, ctx }: { block: Extract<Block, { block: "draft" }>; ctx: BlockCtx }) {
  const { color } = useUiTheme();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(block.body);
  return (
    <Shell icon="chat" title={block.subject ?? "Draft"} sub={block.to ? `To ${block.to}` : block.kind}
      right={<Chip>Draft, nothing sent</Chip>}>
      {editing ? (
        <TextInput multiline value={body} onChangeText={setBody} accessibilityLabel="Edit the draft" style={{ color: color.text, minHeight: 96, borderWidth: 1, borderColor: color["edge-strong"], borderRadius: 8, padding: 8, fontSize: 15, lineHeight: 22 }} />
      ) : (
        <Text selectable>{body}</Text>
      )}
      <View style={S.s25}>
        <Button size="sm" label={editing ? "Done" : "Edit"} onPress={() => setEditing((e) => !e)} />
        <Button size="sm" kind="ghost" icon="copy" label="Copy" onPress={() => copy(body, ctx)} />
      </View>
    </Shell>
  );
}

// ---------------------------------------------------------------- flow change

export function FlowChange({ block, ctx }: { block: Extract<Block, { block: "flow-change" }>; ctx: BlockCtx }) {
  const { color } = useUiTheme();
  const mark = (op: string) => (op === "add" ? { icon: "plus" as const, tone: color.ok, bg: color["ok-wash"] } : op === "remove" ? { icon: "minus" as const, tone: color.err, bg: color["err-wash"] } : { icon: "refresh" as const, tone: color["text-2"], bg: color.hover });
  return (
    <Shell icon="refresh" title={block.title} sub="Proposed change to a Flow">
      <View style={S.s26}>
        {block.steps.map((s, i) => {
          const m = mark(s.op);
          return (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: m.bg, borderRadius: 8, paddingHorizontal: 8, minHeight: 32 }}>
              <Icon name={m.icon} tone={s.op === "add" ? "ok" : s.op === "remove" ? "err" : "text-2"} />
              <Text style={S.s9}>{s.label}</Text>
            </View>
          );
        })}
      </View>
      {ctx.onOpenFlow ? <View style={S.s12}><Button size="sm" label="Review in Flows" onPress={ctx.onOpenFlow} /></View> : null}
    </Shell>
  );
}

// ---------------------------------------------------------------- answer with sources

export function CitedAnswer({ block, ctx }: { block: Extract<Block, { block: "answer" }>; ctx: BlockCtx }) {
  return (
    <Shell icon="link" title="From memory" sub={`${block.sources.length} source${block.sources.length === 1 ? "" : "s"}`}>
      <Text selectable>{block.text}</Text>
      <View style={S.s23}>
        {block.sources.map((s, i) => (
          <Pressable key={i} accessibilityRole="button" accessibilityLabel={`Source ${i + 1}: ${s.title}`} onPress={() => s.url && ctx.onOpenSource?.(s.url)} style={S.s6}>
            <Chip icon="link">{`${i + 1}  ${s.title}`}</Chip>
          </Pressable>
        ))}
      </View>
    </Shell>
  );
}

// ---------------------------------------------------------------- screen frames

export function ScreenFrames({ block, ctx }: { block: Extract<Block, { block: "screen" }>; ctx: BlockCtx }) {
  const { color } = useUiTheme();
  const frame = block.frames[block.frames.length - 1];
  return (
    <Shell icon="globe" title={block.label || "Screen"} sub={block.live ? "Live" : "Last frame"} right={block.live ? <Chip tone="accent">live</Chip> : null}>
      <View style={{ aspectRatio: 16 / 10, borderRadius: 8, overflow: "hidden", backgroundColor: color["code-bg"], alignItems: "center", justifyContent: "center" }}>
        {frame ? <Image accessibilityLabel="What the assistant sees" source={{ uri: frame }} style={S.s27} resizeMode="cover" /> : <Text tone="label" size="caption">Waiting for the first frame</Text>}
      </View>
      {block.live && ctx.onTakeOver ? <View style={S.s12}><Button size="sm" kind="primary" icon="hand" label="Take over" onPress={ctx.onTakeOver} /></View> : null}
    </Shell>
  );
}

// ---------------------------------------------------------------- text fallback

export function TextBlock({ block }: { block: Extract<Block, { block: "text" }> }) {
  return <Text tone="muted" selectable>{block.text}</Text>;
}

/** The one switch. `output`/`running` feed a terminal that is still streaming. */
export function renderBlock(block: Block, ctx: BlockCtx, extra: { output?: string; running?: boolean; decided?: "approve" | "deny" | null } = {}): ReactNode {
  switch (block.block) {
    case "terminal": return <TerminalBlock block={block} ctx={ctx} output={extra.output} running={extra.running} />;
    case "diff": return <DiffBlock block={block} ctx={ctx} />;
    case "record": return <RecordCard block={block} ctx={ctx} />;
    case "task": return <TaskCard block={block} ctx={ctx} decided={extra.decided} />;
    case "draft": return <DraftBlock block={block} ctx={ctx} />;
    case "flow-change": return <FlowChange block={block} ctx={ctx} />;
    case "answer": return <CitedAnswer block={block} ctx={ctx} />;
    case "screen": return <ScreenFrames block={block} ctx={ctx} />;
    default: return <TextBlock block={block} />;
  }
}

export const BlockView = memo(function BlockView({ block, ctx, output, running, decided }: { block: Block; ctx: BlockCtx; output?: string; running?: boolean; decided?: "approve" | "deny" | null }) {
  return <>{renderBlock(block, ctx, { output, running, decided })}</>;
});
