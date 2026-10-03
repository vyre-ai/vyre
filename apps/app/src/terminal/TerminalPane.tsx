import { useCallback, useRef, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { IconButton } from "@vyre/ui";
import { Terminal, type TermState, type TerminalHandle, type TerminalProps } from "./Terminal";
import { TerminalHeader } from "./chrome";

export type TerminalPaneProps = Omit<TerminalProps, "testID"> & {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  /** Starting width in px (the chat screen keeps it between sessions). */
  width?: number;
  minWidth?: number;
  /** Wider than this fraction of the window it will not go. */
  maxFraction?: number;
  onWidth?: (px: number) => void;
};

/**
 * Desktop: a terminal pane that sits beside the chat. Drag its left edge to resize it; the terminal refits and tells the box. The
 * parent lays it out as the right-hand child of a row (it sizes itself with `width`, the chat takes the rest).
 */
export function TerminalPane({ title, subtitle, onClose, width = 520, minWidth = 320, maxFraction = 0.7, onWidth, ...term }: TerminalPaneProps) {
  const ref = useRef<TerminalHandle | null>(null);
  const [state, setState] = useState<TermState | null>(null);
  const [w, setW] = useState(width);
  const drag = useRef<{ x: number; w: number } | null>(null);

  // The resize edge is a pointer-captured strip (web: the desktop is the only place this pane is used).
  const down = useCallback((e: any) => {
    const ev = e.nativeEvent ?? e;
    drag.current = { x: ev.clientX ?? ev.pageX, w };
    (e.target as any)?.setPointerCapture?.(ev.pointerId);
  }, [w]);
  const move = useCallback((e: any) => {
    if (!drag.current) return;
    const ev = e.nativeEvent ?? e;
    const max = Math.floor((typeof window === "undefined" ? 1280 : window.innerWidth) * maxFraction);
    // The pane is on the right: dragging left makes it wider.
    const next = Math.max(minWidth, Math.min(max, drag.current.w + (drag.current.x - (ev.clientX ?? ev.pageX))));
    setW(next);
  }, [minWidth, maxFraction]);
  const up = useCallback(() => { if (drag.current) { drag.current = null; onWidth?.(w); } }, [onWidth, w]);

  return (
    <View testID="terminal-pane" className="flex-row bg-code-bg" style={{ width: w }}>
      <View
        // @ts-ignore pointer events exist on react-native-web
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        accessibilityRole="adjustable" accessibilityLabel="Resize the terminal"
        className="bg-edge"
        style={{ width: 5, cursor: "col-resize", touchAction: "none" } as any}
      />
      <View className="flex-1">
        <TerminalHeader
          title={title}
          subtitle={subtitle}
          state={state}
          onCopy={() => { ref.current?.copy(); }}
          onPaste={async () => { const t = await Clipboard.getStringAsync(); if (t) { ref.current?.paste(t); ref.current?.focus(); } }}
          right={onClose ? <IconButton icon="x" label="Close terminal" onPress={onClose} /> : undefined}
        />
        <Terminal ref={ref} {...term} onState={(s) => { setState(s); term.onState?.(s); }} testID="terminal" />
      </View>
    </View>
  );
}
