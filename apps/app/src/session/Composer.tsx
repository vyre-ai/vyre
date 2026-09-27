// The composer, on chat's shared rules (deck/chat/core/composer-state.js): Enter sends when idle
// and steers while a turn runs; holding Send (or Alt+Enter) queues for after the turn; on a touch
// keyboard Enter is a new line and the button sends; Esc stops a running turn. Text is 16 px so
// iOS does not zoom the page on focus.

import { useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import { createEsc, enterAction, escape, type SendMode } from "@vyre/chat-core/composer-state.js";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";

const touch = Platform.OS !== "web" || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);

type KeyEvent = NativeSyntheticEvent<TextInputKeyPressEventData & { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean }> & {
  preventDefault?: () => void;
};

export function Composer({
  running,
  placeholder,
  onSend,
  onStop,
}: {
  running: boolean;
  placeholder: string;
  onSend: (text: string, mode: SendMode | null) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onStop: () => void;
}) {
  const { color } = useTheme();
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const esc = useRef(createEsc());

  async function submit(mode: SendMode | null) {
    const t = text.trim();
    if (!t) return;
    setText("");
    setNote(null);
    const r = await onSend(t, mode);
    if (!r.ok) {
      // Nothing typed is lost: the words go back in the box with why.
      setText((cur) => (cur ? cur : t));
      setNote(r.reason);
    }
  }

  function press(o: { button?: boolean; hold?: boolean; e?: KeyEvent }) {
    const n = o.e?.nativeEvent;
    const a = enterAction({ text, running, touch, button: o.button, hold: o.hold, shift: n?.shiftKey, alt: n?.altKey, meta: n?.metaKey, ctrl: n?.ctrlKey, composing: n?.isComposing });
    if (a.do === "send") {
      o.e?.preventDefault?.();
      void submit(a.mode);
    } else if (a.do === "none" && !o.button) o.e?.preventDefault?.();
  }

  function onKey(e: KeyEvent) {
    const key = e.nativeEvent.key;
    if (key === "Enter") press({ e });
    else if (key === "Escape") {
      const act = escape(esc.current, { now: Date.now(), running, text });
      if (act === "interrupt") onStop();
      else if (act === "clear") setText("");
    }
  }

  return (
    <View style={[styles.wrap, { backgroundColor: color.bg, borderTopColor: color.rule }]}>
      {note ? <Text style={[styles.note, { color: color.text2 }]}>{note}</Text> : null}
      <View style={styles.row}>
        <TextInput
          value={text}
          onChangeText={setText}
          onKeyPress={onKey as (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => void}
          multiline
          placeholder={placeholder}
          placeholderTextColor={color.label}
          accessibilityLabel="Message"
          style={[styles.input, { color: color.text, backgroundColor: color.panel, borderColor: color.rule }, focusRing(color.focus)]}
        />
        {running ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={onStop} style={[styles.btn, { backgroundColor: color.hover }]}>
            <Text style={[styles.btnText, { color: color.text }]}>Stop</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={running ? "Send, or hold to queue" : "Send"}
          disabled={!text.trim()}
          onPress={() => press({ button: true })}
          onLongPress={() => press({ button: true, hold: true })}
          delayLongPress={tokens.motion.hold}
          style={[styles.btn, { backgroundColor: text.trim() ? color.primaryBg : color.hover }]}
        >
          <Text style={[styles.btnText, { color: text.trim() ? color.primaryInk : color.label }]}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Focus is lime (the system's focus colour), not the browser's blue. */
const focusRing = (c: string) => (Platform.OS === "web" ? ({ outlineColor: c, outlineWidth: 1 } as object) : null);

const phone = tokens.type.phone;
const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: tokens.layout.gutterPhone, paddingVertical: tokens.space[3], gap: tokens.space[2] },
  row: { flexDirection: "row", alignItems: "flex-end", gap: tokens.space[3] },
  // 16 px: under that, iOS zooms the page when the field takes focus.
  input: {
    flex: 1,
    minHeight: tokens.control.touch,
    maxHeight: 160,
    fontSize: 16,
    lineHeight: 22,
    paddingHorizontal: tokens.space[4],
    paddingVertical: tokens.space[3],
    borderRadius: tokens.radius.buttonTouch,
    borderWidth: StyleSheet.hairlineWidth,
  },
  btn: { height: tokens.control.touch, paddingHorizontal: tokens.space[5], borderRadius: tokens.radius.buttonTouch, justifyContent: "center" },
  btnText: { fontSize: phone.read[0], lineHeight: phone.read[1], fontWeight: tokens.font.weight.strong },
  note: { fontSize: phone.meta[0], lineHeight: phone.meta[1] },
});
