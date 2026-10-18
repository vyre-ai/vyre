// The message context menu, drawn: at the pointer on a screen with one (web, Mac), as a sheet on a phone or when opened from the keyboard. A strip of quick reactions, then the groups of the model
// (message-menu-model.js), shortcut hints at the right in label tone. Copy opens its choices in place. Escape or a press outside closes it.
import { useEffect, useState } from "react";
import { Platform, Pressable, View, useWindowDimensions } from "react-native";
import { Divider, Row, Sheet, Text, useUiTheme } from "@vyre/ui";
import { elevation } from "../../ui/lib/elevation";
import type { MenuItem, MessageMenu } from "./message-menu-model.js";

const W = 248;

export function MessageMenuView({ menu, at, onPick, onReact, onClose }: { menu: MessageMenu; at: { x: number; y: number } | null; onPick: (id: string) => void; onReact: (emoji: string) => void; onClose: () => void }) {
  const { color, resolved } = useUiTheme();
  const { width, height } = useWindowDimensions();
  const [copyOpen, setCopyOpen] = useState(false);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", on, true);
    return () => document.removeEventListener("keydown", on, true);
  }, [onClose]);
  const run = (id: string) => { onClose(); onPick(id); };
  const item = (i: MenuItem) => (
    <View key={i.id}>
      <Pressable accessibilityRole="menuitem" accessibilityLabel={i.label} onPress={() => (i.children ? setCopyOpen((v) => !v) : run(i.id))}
        style={({ hovered, focused }: any) => ({ flexDirection: "row", alignItems: "center", minHeight: 34, paddingHorizontal: 10, borderRadius: 8, backgroundColor: hovered || focused ? color.hover : "transparent" })}>
        <Text style={{ flex: 1 }} tone={i.danger ? "err" : "default"}>{i.label}</Text>
        {i.children ? <Text tone="label" size="caption">{copyOpen ? "⌃" : "›"}</Text> : i.hint ? <Text tone="label" size="caption">{i.hint}</Text> : null}
      </Pressable>
      {i.children && copyOpen ? i.children.map((c) => (
        <Pressable key={c.id} accessibilityRole="menuitem" onPress={() => run(c.id)} style={({ hovered, focused }: any) => ({ minHeight: 32, paddingLeft: 24, paddingRight: 10, justifyContent: "center", borderRadius: 8, backgroundColor: hovered || focused ? color.hover : "transparent" })}>
          <Text>{c.label}</Text>
        </Pressable>
      )) : null}
    </View>
  );
  const strip = menu.reactions.length ? (
    <View style={{ flexDirection: "row", gap: 4, paddingHorizontal: 6, paddingVertical: 4 }}>
      {menu.reactions.map((e) => <Pressable key={e} accessibilityRole="button" accessibilityLabel={`React ${e}`} onPress={() => { onClose(); onReact(e); }} style={({ hovered }: any) => ({ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: hovered ? color.hover : "transparent" })}><Text size="title">{e}</Text></Pressable>)}
    </View>
  ) : null;
  const body = (
    <View style={{ gap: 2 }}>
      {strip}
      {strip && menu.groups.length ? <Divider /> : null}
      {menu.groups.map((g, gi) => <View key={gi} style={{ gap: 2 }}>{gi ? <Divider /> : null}{g.map(item)}</View>)}
    </View>
  );
  if (!at || Platform.OS !== "web") {
    return (
      <Sheet open onClose={onClose} title="Message">
        {menu.reactions.length ? <View style={{ flexDirection: "row", gap: 8, paddingBottom: 8 }}>{menu.reactions.map((e) => <Pressable key={e} accessibilityRole="button" accessibilityLabel={`React ${e}`} onPress={() => { onClose(); onReact(e); }} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Text size="title">{e}</Text></Pressable>)}</View> : null}
        {menu.groups.flatMap((g, gi) => [gi ? <Divider key={`d${gi}`} /> : null, ...g.flatMap((i) => (i.children ? i.children.map((c) => <Row key={c.id} dense title={c.label} onPress={() => run(c.id)} />) : [<Row key={i.id} dense title={i.label} onPress={() => run(i.id)} />]))])}
      </Sheet>
    );
  }
  const left = Math.max(8, Math.min(at.x, width - W - 8)), top = Math.max(8, Math.min(at.y, height - 360));
  return (
    <>
      <Pressable accessibilityLabel="Close the menu" onPress={onClose} {...({ onContextMenu: (e: any) => { e.preventDefault(); onClose(); } } as object)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 90 } as any} />
      <View accessibilityRole="menu" style={{ position: "fixed", left, top, width: W, zIndex: 91, padding: 6, borderRadius: 12, borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], ...elevation(resolved.scheme, 2) } as any}>{body}</View>
    </>
  );
}
