// The right-click menu of Files, drawn at the pointer on the web and Mac (a portal to document.body, so no panel clips it), in the look of the chat message menu: a rounded surface, groups divided, the shortcut at the right.
// Esc, a click outside or another right-click closes it. The items come from file-menu-model.js (only what the item's source does).
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Pressable, View, useWindowDimensions } from "react-native";
import { Divider, Text, useUiTheme } from "@vyre/ui";
import { elevation } from "../../ui/lib/elevation";

type Item = { id: string; label: string; hint?: string; danger?: boolean };
const W = 232;

export function FileContextMenu({ groups, at, onPick, onClose }: { groups: Item[][]; at: { x: number; y: number }; onPick: (id: string) => void; onClose: () => void }) {
  const { color, resolved } = useUiTheme();
  const { width, height } = useWindowDimensions();
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", on, true);
    return () => document.removeEventListener("keydown", on, true);
  }, [onClose]);
  if (typeof document === "undefined" || !groups.length) return null;
  const rows = groups.reduce((n, g) => n + g.length, 0);
  const left = Math.max(8, Math.min(at.x, width - W - 8)), top = Math.max(8, Math.min(at.y, height - (rows * 36 + groups.length * 10 + 24)));
  return createPortal(
    <>
      <Pressable accessibilityLabel="Close the menu" onPress={onClose} {...({ onContextMenu: (e: any) => { e.preventDefault(); onClose(); } } as object)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 90 } as any} />
      <View accessibilityRole="menu" style={{ position: "fixed", left, top, width: W, zIndex: 91, padding: 6, borderRadius: 12, borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], ...elevation(resolved.scheme, 2) } as any}>
        <View style={{ gap: 2 }}>
          {groups.map((g, gi) => (
            <View key={gi} style={{ gap: 2 }}>
              {gi ? <Divider /> : null}
              {g.map((i) => (
                <Pressable key={i.id} accessibilityRole="menuitem" accessibilityLabel={i.label} onPress={() => { onClose(); onPick(i.id); }}
                  style={({ hovered, focused }: any) => ({ flexDirection: "row", alignItems: "center", minHeight: 34, paddingHorizontal: 10, borderRadius: 8, backgroundColor: hovered || focused ? color.hover : "transparent" })}>
                  <Text style={{ flex: 1 }} tone={i.danger ? "err" : "default"}>{i.label}</Text>
                  {i.hint ? <Text tone="label" size="caption">{i.hint}</Text> : null}
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      </View>
    </>,
    document.body,
  );
}
