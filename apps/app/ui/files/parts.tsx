// The pieces the file viewer draws: code with line numbers, a JSON tree, an image with zoom, a diff, and the card for a file nothing here can draw. Each takes plain data.
import { useMemo, useState } from "react";
import { FlatList, Image, Platform, Pressable, ScrollView, View } from "react-native";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { highlight } from "../markdown/highlight.js";
import { hunks, type DiffOp } from "./diff.js";

/** Code or text, one row per line with its number, coloured by the shared tokenizer. A long file scrolls by row, so only what shows is drawn. */
export function CodeLines({ text, lang }: { text: string; lang: string }) {
  const { color } = useUiTheme();
  const lines = useMemo(() => highlight(text, lang), [text, lang]);
  const ink: Record<string, string> = { kw: color.accent, str: color.ok, com: color.label, num: color.warn, key: color.accent, tag: color.accent, plain: color.text };
  const gutter = String(lines.length).length * 8 + 16;
  return (
    <ScrollView horizontal nestedScrollEnabled style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
      <FlatList
        data={lines}
        keyExtractor={(_, i) => String(i)}
        initialNumToRender={60}
        windowSize={9}
        style={{ minWidth: "100%" }}
        renderItem={({ item, index }) => (
          <View style={{ flexDirection: "row" }}>
            <Text mono size="caption" tone="faint" style={{ width: gutter, textAlign: "right", paddingRight: 12, fontSize: 12.5, lineHeight: 19, userSelect: "none" } as object}>{index + 1}</Text>
            <Text mono selectable size="caption" style={{ fontSize: 12.5, lineHeight: 19 }}>
              {item.length ? item.map((t, j) => <Text key={j} mono size="caption" style={{ color: ink[t.k], fontSize: 12.5, lineHeight: 19, ...(t.k === "com" ? { fontStyle: "italic" as const } : null) }}>{t.v}</Text>) : " "}
            </Text>
          </View>
        )}
      />
    </ScrollView>
  );
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function Node({ name, value, depth, open0 }: { name?: string; value: Json; depth: number; open0: boolean }) {
  const { color } = useUiTheme();
  const [open, setOpen] = useState(open0);
  const compound = value !== null && typeof value === "object";
  const entries = compound ? (Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as object)) : [];
  const brief = Array.isArray(value) ? `[${value.length}]` : `{${entries.length}}`;
  const ink = typeof value === "string" ? color.ok : typeof value === "number" ? color.warn : typeof value === "boolean" ? color.accent : color.label;
  return (
    <View style={{ paddingLeft: depth ? 16 : 0 }}>
      <Pressable accessibilityRole={compound ? "button" : undefined} accessibilityState={compound ? { expanded: open } : undefined} onPress={compound ? () => setOpen(!open) : undefined} style={{ flexDirection: "row", gap: 6, minHeight: 22, alignItems: "center" }}>
        {compound ? <Text mono size="caption" tone="label">{open ? "▾" : "▸"}</Text> : <Text mono size="caption"> </Text>}
        {name !== undefined ? <Text mono size="caption" tone="accent">{name}:</Text> : null}
        {compound ? <Text mono size="caption" tone="label">{open ? (Array.isArray(value) ? "[" : "{") : brief}</Text> : <Text mono selectable size="caption" style={{ color: ink }}>{JSON.stringify(value)}</Text>}
      </Pressable>
      {compound && open ? entries.map(([k, v]) => <Node key={k} name={k} value={v as Json} depth={depth + 1} open0={depth < 1} />) : null}
      {compound && open ? <Text mono size="caption" tone="label" style={{ paddingLeft: 16 }}>{Array.isArray(value) ? "]" : "}"}</Text> : null}
    </View>
  );
}

/** JSON as a tree you open and close; the top two levels start open. */
export function JsonTree({ text }: { text: string }) {
  const parsed = useMemo<{ ok: true; v: Json } | { ok: false }>(() => { try { return { ok: true, v: JSON.parse(text) as Json }; } catch { return { ok: false }; } }, [text]);
  if (!parsed.ok) return <CodeLines text={text} lang="json" />;
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}><Node value={parsed.v} depth={0} open0 /></ScrollView>;
}

/** An image you can zoom: fit, then steps up to 400%, scrolling both ways when it is bigger than the box. */
export function ImageZoom({ uri, width = 720 }: { uri: string; width?: number }) {
  const { color } = useUiTheme();
  const [zoom, setZoom] = useState(1);
  const [ratio, setRatio] = useState(1);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8 }}>
        <Button size="sm" kind="ghost" label={"−"} accessibilityLabel="Zoom out" onPress={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))} />
        <Text size="caption" tone="label">{Math.round(zoom * 100)}%</Text>
        <Button size="sm" kind="ghost" label="+" accessibilityLabel="Zoom in" onPress={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))} />
        <Button size="sm" kind="ghost" label="Fit" onPress={() => setZoom(1)} />
      </View>
      <ScrollView style={{ flex: 1, backgroundColor: color["surface-3"] }} contentContainerStyle={{ alignItems: "center", justifyContent: "center", flexGrow: 1, padding: 12 }} horizontal={false}>
        <ScrollView horizontal contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}>
          <Image source={{ uri }} resizeMode="contain" onLoad={(e) => { const s = (e.nativeEvent as { source?: { width: number; height: number } }).source; if (s?.width && s.height) setRatio(s.height / s.width); }} style={{ width: width * zoom, height: width * zoom * ratio }} accessibilityIgnoresInvertColors />
        </ScrollView>
      </ScrollView>
    </View>
  );
}

/** "Show changes": the lines a version changed, with a few around each and the unchanged stretches folded. */
export function DiffView({ ops }: { ops: DiffOp[] }) {
  const { color } = useUiTheme();
  const rows = useMemo(() => hunks(ops, 3), [ops]);
  if (!ops.some((o) => o.t !== "eq")) return <View style={{ padding: 16 }}><Text tone="muted">Nothing changed from the version before.</Text></View>;
  return (
    <ScrollView style={{ flex: 1 }}>
      {rows.map((r, i) => r.t === "gap" ? (
        <View key={i} style={{ paddingHorizontal: 12, paddingVertical: 2, backgroundColor: color["surface-3"] }}><Text mono size="caption" tone="faint">{`⋯ ${r.skipped} unchanged ${r.skipped === 1 ? "line" : "lines"}`}</Text></View>
      ) : (
        <View key={i} style={{ flexDirection: "row", paddingHorizontal: 12, backgroundColor: r.t === "add" ? color["ok-wash"] : r.t === "del" ? color["err-wash"] : "transparent" }}>
          <Text mono size="caption" style={{ width: 16, fontSize: 12.5, lineHeight: 19, color: r.t === "add" ? color.ok : r.t === "del" ? color.err : color.faint }}>{r.t === "add" ? "+" : r.t === "del" ? "−" : " "}</Text>
          <Text mono selectable size="caption" style={{ flex: 1, fontSize: 12.5, lineHeight: 19, color: r.t === "eq" ? color.label : color.text }}>{r.line || " "}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

/** A file nothing here draws: its facts and Download. */
export function OtherCard({ name, size, note, onDownload }: { name: string; size?: number; note?: string; onDownload?: () => void }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      <Icon name="file" size={24} />
      <Text strong>{name}</Text>
      {size != null ? <Text tone="muted" size="secondary">{size < 1024 ? `${size} B` : size < 1048576 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`}</Text> : null}
      <Text tone="muted" size="secondary" style={{ textAlign: "center" }}>{note ?? "Vyre cannot show this kind of file here."}</Text>
      {onDownload ? <Button kind="secondary" icon="download" label="Download" onPress={onDownload} /> : null}
    </View>
  );
}

export const isWeb = Platform.OS === "web";
