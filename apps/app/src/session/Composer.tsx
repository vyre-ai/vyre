// The composer, on chat's shared rules (deck/chat/core/composer-state.js, one KEYMAP for the Deck
// and the phone): Enter sends when idle and steers while a turn runs; holding Send (or Alt+Enter)
// queues for after the turn; on a touch keyboard Enter is a new line and the button sends; Esc
// stops a running turn, Esc Esc rewinds (or clears the words); Up and Down recall what was sent
// here. "/" opens the session's commands (threads.commands, ranked by commands.js over match.js);
// /model and /rewind are answered here. The model chip opens the model picker. Text is 16 px so
// iOS does not zoom the page on focus.
//
// Keystroke to paint (native bar 1): the words are this component's own state, so typing re-renders
// the composer and nothing else; the draft goes to the store (memory, then the view cache once
// typing pauses) without a render.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputChangeEventData,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
} from "react-native";
import {
  binding,
  createEsc,
  draftKind,
  enterAction,
  escape,
  historyStore,
  recall,
  recalling,
  remember,
  shortModel,
  stopRecall,
  upAction,
  type SendMode,
} from "@vyre/chat-core/composer-state.js";
import { applyCommand, findCommand, normalizeCommands, rankCommands, sourceLabel, type Command } from "@vyre/chat-core/commands.js";
import { CAPS, NEEDS_UPDATE } from "@vyre/chat-core/caps.js";
import { nextPaint, perf } from "../perf";
import { viewCache } from "../state/cache";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { face, type } from "../theme/type";
import { IconButton } from "../ui/IconButton";
import type { SendResult, SessionStore } from "./store";

const touch = Platform.OS !== "web" || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);

/** What was sent, per session, kept in the view cache (Up recalls it). */
const HISTORY_KEY = "chat.history";
const HISTORY = historyStore();
void viewCache.get(HISTORY_KEY).then((v) => HISTORY.load(v));

type KeyEvent = NativeSyntheticEvent<TextInputKeyPressEventData & { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean }> & {
  preventDefault?: () => void;
};
type Choice = { id: string; label: string; description?: string; now: boolean };
type Menu = { kind: "command"; items: Command[] } | { kind: "model"; items: Choice[] } | null;

export const Composer = memo(function Composer({
  store,
  running,
  model,
  placeholder,
  onSend,
  onStop,
  onRewind,
}: {
  store: SessionStore;
  running: boolean;
  model: string | null;
  placeholder: string;
  onSend: (text: string, mode: SendMode | null) => Promise<SendResult>;
  onStop: () => void;
  /** Esc Esc with nothing typed, or /rewind. */
  onRewind: () => void;
}) {
  const { color } = useTheme();
  const [text, setTextState] = useState(() => store.draft);
  const [note, setNote] = useState<string | null>(null);
  const [commands, setCommands] = useState<Command[] | null>(null);
  const [models, setModels] = useState<Choice[] | null>(null);
  const caret = useRef(text.length);
  const typedAt = useRef<number | null>(null);
  const esc = useRef(createEsc());
  const hist = useMemo(() => HISTORY.get(store.thread), [store]);

  const setText = (t: string) => {
    caret.current = t.length;
    setTextState(t);
    store.setDraft(t);
  };

  // A draft read from the cache after this drew, or a rewind's words back in the box.
  useEffect(() => store.onDraft((t, force) => setTextState((cur) => (force || !cur ? t : cur))), [store]);

  /** The words the "/" menu was closed on (Esc): it stays closed until they change. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const cmd = dismissed === text ? null : findCommand(text, Math.min(caret.current, text.length));
  const wantCommands = cmd !== null && !commands;
  useEffect(() => {
    if (wantCommands) void store.commands().then(setCommands);
  }, [wantCommands, store]);

  const menu: Menu = models
    ? { kind: "model", items: models }
    : cmd
      ? { kind: "command", items: rankCommands(commands ?? normalizeCommands(null), cmd.query).slice(0, 6) }
      : null;
  const pickerOpen = !!menu && menu.items.length > 0;

  async function submit(mode: SendMode | null) {
    const t = text.trim();
    if (!t) return;
    const kind = draftKind(t);
    if (kind === "command") {
      const name = t.slice(1).split(/\s/)[0];
      const local = (commands ?? normalizeCommands(null)).find((c) => c.name === name && c.local);
      if (local?.local) {
        setText("");
        runLocal(local.local);
        return;
      }
    }
    if ((kind === "shell" && CAPS.has("threads.shell") === false) || (kind === "memory" && CAPS.has("threads.remember") === false)) {
      setNote(`${kind === "shell" ? "Shell" : "Memory"}: ${NEEDS_UPDATE}`);
      return;
    }
    setText("");
    setNote(null);
    remember(hist, t);
    void viewCache.set(HISTORY_KEY, HISTORY.toJSON());
    const r = await onSend(t, mode);
    if (!r.ok) {
      // Nothing typed is lost: the words go back in the box with why.
      setTextState((cur) => (cur ? cur : t));
      store.setDraft(t);
      setNote(r.reason);
    }
  }

  function runLocal(what: "model" | "rewind" | "undo" | "find" | "goal") {
    if (what === "model") void openModels();
    else if (what === "rewind") onRewind();
    else setNote(`/${what} works in the Deck for now.`);
  }

  async function openModels() {
    if (!store.canSwitchModel()) {
      setNote(NEEDS_UPDATE);
      return;
    }
    setModels(await store.models());
  }

  async function pickModel(m: Choice) {
    setModels(null);
    setNote(await store.setModel(m.id));
  }

  function pickCommand(c: Command) {
    if (c.local) {
      setText("");
      runLocal(c.local);
      return;
    }
    const range = findCommand(text, text.length) ?? { start: 0, end: text.length, query: "" };
    setText(applyCommand(text, range, c.name).text);
  }

  function press(o: { button?: boolean; hold?: boolean; e?: KeyEvent }) {
    const n = o.e?.nativeEvent;
    const a = enterAction({ text, running, touch, pickerOpen, button: o.button, hold: o.hold, shift: n?.shiftKey, alt: n?.altKey, meta: n?.metaKey, ctrl: n?.ctrlKey, composing: n?.isComposing });
    if (a.do === "pick" && menu) {
      o.e?.preventDefault?.();
      if (menu.kind === "command") pickCommand(menu.items[0]);
      else void pickModel(menu.items[0]);
    } else if (a.do === "send") {
      o.e?.preventDefault?.();
      void submit(a.mode);
    } else if (a.do === "none" && !o.button) o.e?.preventDefault?.();
  }

  function onKey(e: KeyEvent) {
    const key = e.nativeEvent.key;
    if (key === "Enter") press({ e });
    else if (key === "Escape") {
      const act = escape(esc.current, { now: Date.now(), running, text, pickerOpen, recalled: recalling(hist) });
      if (act === "close") {
        if (models) setModels(null);
        else setDismissed(text);
      } else if (act === "interrupt") onStop();
      else if (act === "rewind") onRewind();
      else if (act === "clear") {
        stopRecall(hist);
        setText("");
      } else if (act === "leave-mode") setText(text.slice(1));
    } else if ((key === "ArrowUp" || key === "ArrowDown") && !pickerOpen) {
      const firstLine = !text.slice(0, caret.current).includes("\n");
      if (key === "ArrowUp" && upAction({ text, firstLine, recalling: recalling(hist), queued: 0 }) !== "recall") return;
      if (key === "ArrowDown" && !recalling(hist)) return;
      const t = recall(hist, key === "ArrowUp" ? "up" : "down", text);
      if (t === null) return;
      e.preventDefault?.();
      setTextState(t);
      caret.current = t.length;
    }
  }

  const hint = running ? `${binding("send")?.tap} steers · ${binding("queue")?.tap} queues` : null;

  return (
    <View style={[styles.wrap, { backgroundColor: color.bg, borderTopColor: color.rule }]}>
      {pickerOpen && menu ? (
        <View accessibilityRole="menu" style={[styles.menu, { borderColor: color.rule, backgroundColor: color.panel }]}>
          {menu.kind === "command"
            ? menu.items.map((c) => (
                <Pressable key={c.name} accessibilityRole="menuitem" onPress={() => pickCommand(c)} style={styles.menuRow}>
                  <Text style={[type.baseStrong, { color: color.text }]}>/{c.name}</Text>
                  <Text numberOfLines={1} style={[type.meta, styles.menuDesc, { color: color.text2 }]}>
                    {c.description}
                  </Text>
                  {sourceLabel(c.source) ? <Text style={[type.meta, { color: color.label }]}>{sourceLabel(c.source)}</Text> : null}
                </Pressable>
              ))
            : menu.items.map((m) => (
                <Pressable key={m.id} accessibilityRole="menuitem" onPress={() => void pickModel(m)} style={styles.menuRow}>
                  <Text style={[type.baseStrong, { color: color.text }]}>{m.label}</Text>
                  <Text numberOfLines={1} style={[type.meta, styles.menuDesc, { color: color.text2 }]}>
                    {m.description ?? ""}
                  </Text>
                  {m.now ? <Text style={[type.meta, { color: color.label }]}>now</Text> : null}
                </Pressable>
              ))}
        </View>
      ) : null}
      {note ? <Text style={[type.meta, { color: color.text2 }]}>{note}</Text> : null}
      <View style={styles.row}>
        <TextInput
          value={text}
          onChange={(e: NativeSyntheticEvent<TextInputChangeEventData>) => {
            if (!perf.on) return;
            const ts = (e as unknown as { timeStamp?: number }).timeStamp;
            typedAt.current = typeof ts === "number" && ts > 0 && ts <= perf.now() ? ts : perf.now();
          }}
          onChangeText={(t) => {
            const w0 = perf.on ? perf.now() : 0;
            caret.current = t.length;
            setTextState(t);
            store.setDraft(t);
            if (recalling(hist)) stopRecall(hist);
            if (models) setModels(null);
            const t0 = typedAt.current;
            typedAt.current = null;
            if (t0 !== null) nextPaint((tp) => perf.record("keystroke", tp - t0));
            // chat.keystroke: this handler's synchronous work; the render it asks for lands in "keystroke".
            if (perf.on) perf.record("keystroke.work", perf.now() - w0);
          }}
          onSelectionChange={(e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
            caret.current = e.nativeEvent.selection.end;
          }}
          onKeyPress={onKey as (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => void}
          multiline
          placeholder={placeholder}
          placeholderTextColor={color.label}
          accessibilityLabel="Message"
          style={[styles.input, { color: color.text, backgroundColor: color.panel, borderColor: color.rule }, focusRing(color.focus)]}
        />
        {running ? <IconButton icon="stop" round size="touch" accessibilityLabel="Stop" onPress={onStop} /> : null}
        <IconButton
          icon="send"
          round
          size="touch"
          primary={!!text.trim()}
          accessibilityLabel={running ? "Send, or hold to queue" : "Send"}
          disabled={!text.trim()}
          onPress={() => press({ button: true })}
          onLongPress={() => press({ button: true, hold: true })}
          delayLongPress={tokens.motion.hold}
        />
      </View>
      <View style={styles.chips}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Switch the model"
          onPress={() => (models ? setModels(null) : void openModels())}
          hitSlop={8}
          style={[styles.chip, { borderColor: color.rule }]}
        >
          <Text style={[type.meta, { color: color.text2 }]}>{shortModel(model) ?? "Model"}</Text>
        </Pressable>
        {hint ? <Text style={[type.meta, { color: color.label }]}>{hint}</Text> : null}
      </View>
    </View>
  );
});

/** Focus is bone (the system's focus colour), not the browser's blue. */
const focusRing = (c: string) => (Platform.OS === "web" ? ({ outlineColor: c, outlineWidth: 1 } as object) : null);

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: tokens.layout.gutterPhone, paddingVertical: tokens.space[3], gap: tokens.space[2] },
  row: { flexDirection: "row", alignItems: "flex-end", gap: tokens.space[3] },
  // 16 px: under that, iOS zooms the page when the field takes focus. The size is the field's own
  // (no type step is 16); the face is the system's.
  input: {
    flex: 1,
    minHeight: tokens.control.touch,
    maxHeight: 160,
    ...face.regular,
    fontSize: 16,
    lineHeight: 22,
    paddingHorizontal: tokens.space[4],
    paddingVertical: tokens.space[3],
    borderRadius: tokens.radius.buttonTouch,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chips: { flexDirection: "row", alignItems: "center", gap: tokens.space[3], flexWrap: "wrap" },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: tokens.radius.buttonTouch, paddingHorizontal: tokens.space[3], paddingVertical: 2 },
  menu: { borderWidth: StyleSheet.hairlineWidth, borderRadius: tokens.radius.cardPhone, paddingVertical: tokens.space[2] },
  menuRow: { flexDirection: "row", alignItems: "center", gap: tokens.space[3], minHeight: tokens.control.touch, paddingHorizontal: tokens.space[4] },
  menuDesc: { flex: 1 },
});
