// The actions on a message as one quiet icon row: Copy (Shift-click copies as Markdown), Reply, Ask about this, and a "..." menu for the rest (Copy as Markdown, Copy code, Edit, Retry,
// Branch from here, React, Pin). It shows on hover, on keyboard focus of the message and on a long press; each icon has a tooltip naming it and its key. The keys (R, C, Shift+C, A, E, B, P, M)
// are read by useMessageKeys (message-keys.js), which sends them here as a "vyre-msg" event on this row so one place does each thing.

import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Icon, Menu, Text, Tip, useUiTheme, type IconName } from "@vyre/ui";
import { readSelection } from "./highlight.js";
import { codeBlocks, copyForms } from "./polish.js";
import { copy, type BlockCtx } from "./Blocks";

const QUICK = ["\u{1F44D}", "✅", "\u{1F440}"];

export type BarGroup = { onReply?: () => void; onReact?: (emoji: string) => void; pinned?: boolean; onPin?: (pinned: boolean) => void };

export function MessageBar({ text, from, ctx, uuid, mine, done = true, group }: { text: string; from: string; ctx: BlockCtx; uuid?: string; mine?: boolean; done?: boolean; group?: BarGroup }) {
  const { color } = useUiTheme();
  const root = useRef<View>(null);
  const [said, setSaid] = useState(false);
  const forms = copyForms(text);
  const blocks = codeBlocks(text);
  const h = ctx.wide ? 28 : 44;
  const doCopy = (md: boolean) => { void copy(md ? forms.markdown : forms.plain, ctx); setSaid(true); setTimeout(() => setSaid(false), 1500); };
  const ask = () => ctx.onHighlight?.({ from, text, selected: readSelection() });
  const edit = mine && uuid && ctx.onEditMessage ? () => ctx.onEditMessage?.(uuid, text) : undefined;
  const retry = mine && uuid && ctx.onRetryMessage ? () => ctx.onRetryMessage?.(uuid) : undefined;
  const branch = uuid && ctx.onBranchFrom ? () => ctx.onBranchFrom?.(uuid) : undefined;
  const actions: Record<string, (() => void) | undefined> = {
    reply: group?.onReply, copy: done ? () => doCopy(false) : undefined, "copy-md": done ? () => doCopy(true) : undefined, ask: ctx.onHighlight ? ask : undefined, edit, branch,
    pin: group?.onPin ? () => group.onPin?.(!group.pinned) : undefined,
  };
  const ref = useRef(actions);
  ref.current = actions;
  // The keys arrive as an event on this row (web).
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = root.current as unknown as HTMLElement | null;
    if (!el) return;
    const on = (e: Event) => { const a = (e as CustomEvent<{ action: string }>).detail?.action; if (a === "menu") { const m = el.querySelector<HTMLElement>('[aria-label="More actions"]'); m?.focus(); m?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); } else ref.current[a]?.(); };
    el.addEventListener("vyre-msg", on);
    return () => el.removeEventListener("vyre-msg", on);
  }, []);

  const icon = (name: IconName, label: string, key: string | undefined, run: (() => void) | undefined, onShift?: () => void) => run ? (
    <Tip key={label} label={label} hint={key} side="top">
      <Pressable accessibilityRole="button" accessibilityLabel={label} {...(Platform.OS === "web" ? ({ title: key ? `${label} (${key})` : label } as object) : {})} onPress={(e: any) => { if (onShift && (e?.shiftKey || e?.nativeEvent?.shiftKey)) onShift(); else run(); }}
        style={({ hovered }: any) => ({ width: h, height: h, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: hovered ? color.hover : "transparent" })}>
        <Icon name={name} size={16} tone="label" />
      </Pressable>
    </Tip>
  ) : null;

  const items = [
    ...(done ? [{ label: "Copy as Markdown", onPress: () => doCopy(true) }] : []),
    ...(done ? blocks.map((b, i) => ({ label: blocks.length > 1 ? `Copy code ${i + 1}` : "Copy code", onPress: () => { void copy(b.code, ctx); } })) : []),
    ...(edit ? [{ label: "Edit", onPress: edit }] : []),
    ...(retry ? [{ label: "Retry", onPress: retry }] : []),
    ...(branch ? [{ label: "Branch from here", onPress: branch }] : []),
    ...(group?.onReact ? QUICK.map((e) => ({ label: `React ${e}`, onPress: () => group.onReact?.(e) })) : []),
    ...(group?.onPin ? [{ label: group.pinned ? "Unpin" : "Pin", onPress: () => group.onPin?.(!group.pinned) }] : []),
  ];
  return (
    <View ref={root} {...(Platform.OS === "web" ? ({ dataSet: { msgbar: "1" } } as object) : {})} style={{ flexDirection: "row", alignItems: "center", gap: 2, marginTop: 2 }}>
      {icon(said ? "check" : "copy", said ? "Copied" : "Copy", "C. Shift for Markdown", actions.copy, actions["copy-md"])}
      {icon("back", "Reply", "R", actions.reply)}
      {icon("spark", "Ask about this", "A", actions.ask)}
      {items.length ? (
        <Menu items={items} trigger={
          <Pressable accessibilityRole="button" accessibilityLabel="More actions" {...(Platform.OS === "web" ? ({ title: "More actions (M)" } as object) : {})} style={({ hovered }: any) => ({ width: h, height: h, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: hovered ? color.hover : "transparent" })}>
            <Icon name="more" size={16} tone="label" />
          </Pressable>
        } />
      ) : null}
    </View>
  );
}
