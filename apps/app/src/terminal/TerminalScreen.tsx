import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, PanResponder, Platform, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton } from "@vyre/ui";
import { Terminal, type TermState, type TerminalHandle, type TerminalProps } from "./Terminal";
import { TerminalHeader } from "./chrome";
import { AccessoryRow } from "./AccessoryRow";
import { press } from "./keys";

export type TerminalScreenProps = Omit<TerminalProps, "testID" | "onAppCursor"> & {
  title: string;
  subtitle?: string;
  /** Back to the chat: the header's back button, and a swipe right from the left edge. */
  onBack: () => void;
};

/** How far the on-screen keyboard lifts the bottom of the window: the keyboard's height on a phone, and the visual viewport's loss in a mobile browser. */
function useKeyboardInset(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (Platform.OS === "web") {
      const vv = typeof window !== "undefined" ? window.visualViewport : null;
      if (!vv) return;
      const f = () => setH(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
      vv.addEventListener("resize", f); vv.addEventListener("scroll", f); f();
      return () => { vv.removeEventListener("resize", f); vv.removeEventListener("scroll", f); };
    }
    const a = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow", (e) => setH(Math.max(0, e.endCoordinates.height)));
    const b = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setH(0));
    return () => { a.remove(); b.remove(); };
  }, []);
  return h;
}

/**
 * Phone: the terminal full screen, with the accessory row (esc, tab, ctrl, arrows, pipe, slash) riding above the keyboard. A back
 * button and a swipe from the left edge return to the chat. Pinch the text to resize it (the page handles the gesture).
 */
export function TerminalScreen({ title, subtitle, onBack, ...term }: TerminalScreenProps) {
  const ref = useRef<TerminalHandle | null>(null);
  const [state, setState] = useState<TermState | null>(null);
  const [mode, setMode] = useState({ appCursor: false });
  const [ctrl, setCtrl] = useState({ ctrl: false });
  const inset = useKeyboardInset();
  const safe = useSafeAreaInsets();

  const onKey = useCallback((id: string) => {
    const r = press(ctrl, id, mode);
    setCtrl(r.state);
    ref.current?.setCtrl(r.state.ctrl);
    if (r.send) ref.current?.sendKeys(r.send);
    ref.current?.focus();
  }, [ctrl, mode]);

  // Swipe right from the left edge to go back.
  const edge = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => g.dx > 24 && Math.abs(g.dy) < 20,
    onPanResponderRelease: (_e, g) => { if (g.dx > 60) onBackRef.current(); },
  })).current;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  return (
    <View testID="terminal-screen" className="flex-1 bg-code-bg" style={{ paddingTop: safe.top, paddingBottom: inset > 0 ? inset : safe.bottom }}>
      <TerminalHeader
        title={title}
        subtitle={subtitle}
        state={state}
        left={<IconButton icon="chev-l" label="Back to the chat" onPress={onBack} touch />}
        onCopy={() => { ref.current?.copy(); }}
        onPaste={async () => { const t = await Clipboard.getStringAsync(); if (t) { ref.current?.paste(t); ref.current?.focus(); } }}
      />
      <View className="flex-1">
        <Terminal ref={ref} {...term} onState={(s) => { setState(s); term.onState?.(s); }} onAppCursor={(on) => setMode({ appCursor: on })} onCtrlDone={() => setCtrl({ ctrl: false })} testID="terminal" />
        <View {...edge.panHandlers} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 14 }} />
      </View>
      <AccessoryRow ctrlArmed={ctrl.ctrl} onKey={onKey} />
    </View>
  );
}
