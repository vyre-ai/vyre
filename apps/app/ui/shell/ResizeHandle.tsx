// A drag handle on the inner edge of a sidebar or a side panel. Web only (a phone has neither). Drag with the pointer, arrow keys on the focused handle (Shift for bigger steps, Home and End for the
// ends), double-click or Enter for the default. The width is remembered per device by name (resize.js). It sits in the layout so every section's sidebar and the chat's panel share it.

import { useCallback, useState } from "react";
import { Platform, View } from "react-native";
import { useUiTheme } from "../theme";
import { OPEN_AFTER, clampWidth, dragWidth, keyStep, rawWidth, readWidth, snapsShut, writeWidth } from "./resize.js";

const store = () => { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } };

/** A width kept per device under `name`: the default until the person drags it. */
export function useStoredWidth(name: string, def: number, min: number, max: number) {
  const [kept, setKept] = useState<number | null>(() => readWidth(store(), name));
  const width = kept === null ? def : clampWidth(kept, min, max);
  const set = useCallback((w: number) => { const v = clampWidth(w, min, max); setKept(v); writeWidth(store(), name, v); }, [name, min, max]);
  const reset = useCallback(() => { setKept(null); writeWidth(store(), name, null); }, [name]);
  return { width, set, reset };
}

/**
 * THE one resize handle: a thin line on a pane's inner edge that shows on hover (cursor col-resize), drags, resets on a double click and takes the arrow keys; the width is remembered per pane
 * with useStoredWidth. Import both from "@vyre/ui". A pane that can fold (the sidebar) passes `onCollapse`: dragging it past its least width snaps it shut. A folded pane draws the handle with
 * `collapsed` and `onOpen`: dragging out from its edge opens it.
 */
export function ResizeHandle({ width, onChange, onReset, min, max, def, edge, label, onCollapse, collapsed, onOpen }: {
  /** A pane that can fold: dragging past its least width calls this once. */ onCollapse?: () => void;
  /** The pane is folded: the handle sits on its edge and a drag outward calls onOpen with the width asked for. */ collapsed?: boolean; onOpen?: (w: number) => void;
  width: number; onChange: (w: number) => void; onReset: () => void; min: number; max: number; def: number;
  /** Which edge of the panel the handle sits on: "right" for the left sidebar, "left" for the right panel. */ edge: "left" | "right"; label: string;
}) {
  const { color } = useUiTheme();
  const [on, setOn] = useState(false);
  const [drag, setDrag] = useState(false);
  if (Platform.OS !== "web") return null;
  const down = (e: { clientX: number; preventDefault: () => void }) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    setDrag(true);
    let shut = false;
    const move = (m: PointerEvent) => {
      if (shut) return;
      const dx = m.clientX - x0;
      if (collapsed) { if (rawWidth(0, dx, edge) > OPEN_AFTER) { shut = true; onOpen?.(clampWidth(rawWidth(0, dx, edge), min, max)); } return; }
      if (onCollapse && snapsShut(rawWidth(w0, dx, edge), min)) { shut = true; onCollapse(); return; }
      onChange(dragWidth(w0, dx, edge, { min, max }));
    };
    const up = () => { setDrag(false); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };
  const key = (e: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
    // The arrow that points toward the content grows the panel, whichever side it is on.
    const k = edge === "left" && (e.key === "ArrowLeft" || e.key === "ArrowRight") ? (e.key === "ArrowLeft" ? "ArrowRight" : "ArrowLeft") : e.key;
    const w = keyStep(k, width, { min, max, def, shift: e.shiftKey });
    if (w === null) return;
    e.preventDefault();
    if (e.key === "Enter") onReset(); else onChange(w);
  };
  const lit = on || drag;
  return (
    <View
      {...({ role: "separator", "aria-orientation": "vertical", "aria-label": label, "aria-valuenow": width, "aria-valuemin": min, "aria-valuemax": max, tabIndex: 0,
        onPointerDown: down, onKeyDown: key, onDoubleClick: onReset,
        onPointerEnter: () => setOn(true), onPointerLeave: () => setOn(false), onFocus: () => setOn(true), onBlur: () => setOn(false) } as object)}
      style={[{ position: "absolute", top: 0, bottom: 0, width: 6, zIndex: 20 }, edge === "right" ? { right: -3 } : { left: -3 }, { cursor: "col-resize" } as object]}
    >
      <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 2, width: 2, backgroundColor: lit ? color["edge-strong"] : "transparent", ...({ transitionProperty: "background-color", transitionDuration: "150ms" } as object) }} />
    </View>
  );
}
