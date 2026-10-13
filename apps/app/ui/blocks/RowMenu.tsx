import { useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Icon } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { useUiTheme } from "../theme";

/**
 * A list row's own menu: a "..." that shows when the row is hovered or has the keyboard (always on a phone), and the same menu on a right-click or the keyboard's context key (Shift+F10, the menu key).
 * `children` draws the row and takes the "..." to put in its end. The menu is a Menu, so Up and Down, Enter and Esc work inside it.
 */
export function MenuRow({ items, children }: { items: MenuItem[]; children: (menu: React.ReactNode) => React.ReactNode }) {
  const { color, phone } = useUiTheme();
  const [on, setOn] = useState(false);
  const btn = useRef<View>(null);
  if (!items.length) return <>{children(null)}</>;
  const web = Platform.OS === "web";
  const show = phone || on;
  const open = () => { const el = btn.current as unknown as HTMLElement | null; el?.focus?.(); el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); };
  const menu = (
    <View style={{ opacity: show ? 1 : 0 }}>
      <Menu items={items} trigger={
        <Pressable ref={btn} accessibilityRole="button" accessibilityLabel="More actions for this row" hitSlop={phone ? 6 : 0}
          style={({ hovered }: any) => ({ width: phone ? 44 : 32, height: phone ? 44 : 32, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: hovered ? color.hover : "transparent" })}>
          <Icon name="more" size={18} tone="label" />
        </Pressable>
      } />
    </View>
  );
  return (
    <View
      {...(web ? ({ onPointerEnter: () => setOn(true), onPointerLeave: () => setOn(false), onFocus: () => setOn(true), onBlur: () => setOn(false), onContextMenu: (e: Event) => { e.preventDefault(); open(); } } as object) : {})}
    >
      {children(menu)}
    </View>
  );
}
