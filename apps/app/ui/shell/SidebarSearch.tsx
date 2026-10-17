// The search at the top of a sidebar: 36 high, full width inside the gutters, with an optional control inside its right end (the filter). Cmd or Ctrl and K focuses it, wherever the focus is.

import { useEffect, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { Icon } from "../components/Icon";
import { useUiTheme } from "../theme";
import { facesFor } from "../../src/theme/fonts";
import { RAIL } from "./rail-tokens.js";

export function SidebarSearch({ value, onChange, placeholder, end, label }: { value: string; onChange: (v: string) => void; placeholder: string; /** A control inside the right end (a filter menu's button). */ end?: React.ReactNode; label?: string }) {
  const { color, resolved } = useUiTheme();
  const ref = useRef<TextInput>(null);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      e.preventDefault(); e.stopImmediatePropagation();
      ref.current?.focus();
    };
    document.addEventListener("keydown", on, true);
    return () => document.removeEventListener("keydown", on, true);
  }, []);
  const faces = facesFor(resolved.font);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: RAIL.searchH, marginHorizontal: RAIL.gutter, paddingLeft: 12, paddingRight: end ? 2 : 12, borderRadius: RAIL.rowRadius, backgroundColor: color["surface-3"],
      ...(focus ? { borderWidth: 2, borderColor: color.primary } : {}) }}>
      <Icon name="search" tone="label" size={RAIL.iconSize} />
      <TextInput ref={ref} value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={color.label} accessibilityLabel={label ?? placeholder} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        onKeyPress={(e: any) => { if (e.nativeEvent.key === "Escape" && value) { e.preventDefault?.(); onChange(""); } }}
        style={[faces.regular as object, { flex: 1, minWidth: 0, height: RAIL.searchH, color: color.text, fontSize: RAIL.labelSize, outlineStyle: "none" } as object]} />
      {end}
    </View>
  );
}
