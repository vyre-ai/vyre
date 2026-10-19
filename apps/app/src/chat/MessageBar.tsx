// The actions on a message as one quiet icon row: Copy (Shift-click copies as Markdown), Reply, Ask about this, and a "..." menu for the rest (Copy as Markdown, Copy code, Edit, Retry,
// Fork from here, React, Pin). It shows on hover, on keyboard focus of the message and on a long press; each icon has a tooltip naming it and its key. The keys (R, C, Shift+C, A, E, B, P, M)
// are read by useMessageKeys (message-keys.js), which sends them here as a "vyre-msg" event on this row so one place does each thing.

import { useContext, useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Icon, Tip, useUiTheme, type IconName } from "@vyre/ui";
import { readSelection } from "./highlight.js";
import { codeBlocks, copyForms } from "./polish.js";
import { copy, type BlockCtx } from "./Blocks";
import { MenuHostCtx } from "./message-menu-host";
import { messageMenu } from "./message-menu-model.js";
import { MessageMenuView } from "./MessageMenuView";

const QUICK = ["\u{1F44D}", "✅", "\u{1F440}"];

export type BarGroup = { onReply?: () => void; onReact?: (emoji: string) => void; pinned?: boolean; onPin?: (pinned: boolean) => void };

export function MessageBar({ text, from, ctx, uuid, mine, done = true, group }: { text: string; from: string; ctx: BlockCtx; uuid?: string; mine?: boolean; done?: boolean; group?: BarGroup }) {
  const { color } = useUiTheme();
  const root = useRef<View>(null);
  const [said, setSaid] = useState(false);
  // The message menu: opened by a right-click or a long press on the message (the row calls the opener), or by the three dots; at: where the pointer was, or null for a sheet.
  const host = useContext(MenuHostCtx);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null | undefined>(undefined);
  useEffect(() => { if (!host) return; host.open.current = (at) => { setMenuAt(at); host.shown?.(true); }; return () => { host.open.current = null; }; }, [host]);
  const closeMenu = () => { setMenuAt(undefined); host?.shown?.(false); };
  const forms = copyForms(text);
  const blocks = codeBlocks(text);
  const h = ctx.wide ? 28 : 44;
  const doCopy = (md: boolean) => { void copy(md ? forms.markdown : forms.plain, ctx); setSaid(true); setTimeout(() => setSaid(false), 1500); };
  const ask = () => ctx.onHighlight?.({ from, text, selected: readSelection() });
  const edit = mine && uuid && ctx.onEditMessage ? () => ctx.onEditMessage?.(uuid, text) : undefined;
  // Retry sits on an answer: it sends the person's own message before it again (spec: Retry, agent answers).
  const asked = !mine && uuid && done && ctx.onRetryMessage ? ctx.askedBefore?.(uuid) ?? null : null;
  const retry = asked ? () => ctx.onRetryMessage?.(asked) : undefined;
  const branch = uuid && ctx.onBranchFrom ? () => ctx.onBranchFrom?.(uuid) : undefined;
  const rewind = uuid && ctx.onRewindTo ? () => ctx.onRewindTo?.(uuid) : undefined;
  const second = uuid && ctx.onSecondOpinion && !mine ? () => ctx.onSecondOpinion?.(uuid) : undefined;
  const actions: Record<string, (() => void) | undefined> = {
    reply: group?.onReply, copy: done ? () => doCopy(false) : undefined, "copy-md": done ? () => doCopy(true) : undefined, ask: ctx.onHighlight ? ask : undefined, edit, branch,
    pin: group?.onPin ? () => group.onPin?.(!group.pinned) : undefined,
  };
  const menu = messageMenu({
    mine, done, reactions: group?.onReact ? QUICK : [], pinned: group?.pinned, codeBlocks: blocks.length,
    can: { reply: !!group?.onReply, forward: !!(uuid && ctx.onForward), fork: !!branch, ask: !!ctx.onHighlight, second: !!second, edit: !!edit, retry: !!retry, rewind: !!rewind, pin: !!group?.onPin },
  });
  const pickItem = (id: string) => {
    if (id === "reply") group?.onReply?.();
    else if (id === "forward") { if (uuid) ctx.onForward?.(uuid, text, from); }
    else if (id === "copy-text") doCopy(false);
    else if (id === "copy-md") doCopy(true);
    else if (id.startsWith("copy-code-")) { const b = blocks[Number(id.slice(10))]; if (b) void copy(b.code, ctx); }
    else if (id === "fork") branch?.();
    else if (id === "ask") ask();
    else if (id === "second") second?.();
    else if (id === "edit") edit?.();
    else if (id === "retry") retry?.();
    else if (id === "rewind") rewind?.();
    else if (id === "pin") group?.onPin?.(!group.pinned);
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

  // The hover bar is three things: Copy, Reply and the three dots, which open the same menu a right-click does.
  const dots = (e: any) => { const n = e?.nativeEvent; setMenuAt(Platform.OS === "web" && n && typeof n.clientX === "number" ? { x: n.clientX, y: n.clientY } : null); host?.shown?.(true); };
  return (
    <View ref={root} {...(Platform.OS === "web" ? ({ dataSet: { msgbar: "1" } } as object) : {})} style={{ flexDirection: "row", alignItems: "center", gap: 2, marginTop: 2 }}>
      {icon(said ? "check" : "copy", said ? "Copied" : "Copy", "C. Shift for Markdown", actions.copy, actions["copy-md"])}
      {icon("back", "Reply", "R", actions.reply)}
      <Pressable accessibilityRole="button" accessibilityLabel="More actions" {...(Platform.OS === "web" ? ({ title: "More actions (M)" } as object) : {})} onPress={dots}
        style={({ hovered }: any) => ({ width: h, height: h, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: hovered ? color.hover : "transparent" })}>
        <Icon name="more" size={16} tone="label" />
      </Pressable>
      {menuAt !== undefined && (menu.groups.length || menu.reactions.length) ? <MessageMenuView menu={menu} at={menuAt} onPick={pickItem} onReact={(e) => group?.onReact?.(e)} onClose={closeMenu} /> : null}
    </View>
  );
}
