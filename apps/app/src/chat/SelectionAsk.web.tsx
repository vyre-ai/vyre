// The web half of "Ask about this": when words in the conversation are selected (not in the composer or a field), a small button sits above them; one press quotes them into the next message as a chip.
// Nothing is sent by selecting or pressing. A press on the button must not clear the selection first, so it reads the words on pointer down.
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Text, useUiTheme } from "@vyre/ui";

const inField = (n: Node | null) => { const e = n && (n.nodeType === 1 ? (n as Element) : n.parentElement); return !!(e && e.closest("textarea, input, [contenteditable='true'], [data-selection-ask='off']")); };

export function SelectionAsk({ onAsk }: { onAsk: (text: string) => void }) {
  const { color } = useUiTheme();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const words = useRef("");
  useEffect(() => {
    const check = () => {
      const sel = window.getSelection();
      const text = sel ? String(sel).trim() : "";
      if (!sel || sel.isCollapsed || text.length < 2 || inField(sel.anchorNode) || inField(sel.focusNode)) { setAt(null); return; }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) { setAt(null); return; }
      words.current = text;
      setAt({ x: Math.min(Math.max(r.left + r.width / 2, 70), window.innerWidth - 70), y: Math.max(r.top - 8, 48) });
    };
    const later = () => setTimeout(check, 0);
    document.addEventListener("selectionchange", check);
    document.addEventListener("mouseup", later);
    document.addEventListener("keyup", later);
    return () => { document.removeEventListener("selectionchange", check); document.removeEventListener("mouseup", later); document.removeEventListener("keyup", later); };
  }, []);
  if (!at) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "fixed" as never, left: at.x, top: at.y, transform: [{ translateX: -60 }, { translateY: -34 }], zIndex: 50 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Ask about this" onPress={() => { onAsk(words.current); setAt(null); window.getSelection()?.removeAllRanges(); }}
        style={{ backgroundColor: color.text, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 }}>
        <Text size="caption" strong style={{ color: color.bg }}>Ask about this</Text>
      </Pressable>
    </View>
  );
}
