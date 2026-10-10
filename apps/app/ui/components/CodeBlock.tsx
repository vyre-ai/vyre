// A block of code: its language in the corner, Copy beside it, the code in the mono face with colours from the design tokens, scrolling sideways rather than wrapping. The tokenizer is markdown/highlight.js.
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { useUiTheme } from "../theme";
import { familyOf, highlight } from "../markdown/highlight.js";

const LABEL: Record<string, string> = { js: "JavaScript", ts: "TypeScript", py: "Python", sh: "Shell", sql: "SQL", go: "Go", rust: "Rust", c: "Code", yaml: "YAML", json: "JSON", css: "CSS", html: "HTML" };

/** The word shown for a fence's language: the usual name when it is known, the label as written otherwise, nothing when there is none. */
export const langLabel = (lang: string): string => { const f = familyOf(lang); return f ? (lang && lang.length <= 12 && !LABEL[lang.toLowerCase()] ? lang : LABEL[f]) : lang; };

export function CodeBlock({ code, lang = "", onCopy }: { code: string; lang?: string; onCopy?: (code: string) => void }) {
  const { color, phone } = useUiTheme();
  const [said, setSaid] = useState(false);
  const lines = useMemo(() => highlight(code, lang), [code, lang]);
  const ink: Record<string, string> = { kw: color.accent, str: color.ok, com: color.label, num: color.warn, key: color.accent, tag: color.accent, plain: color.text };
  const copy = () => {
    if (onCopy) onCopy(code);
    else if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) void navigator.clipboard.writeText(code);
    setSaid(true); setTimeout(() => setSaid(false), 1500);
  };
  const label = langLabel(lang);
  return (
    <View style={{ borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-3"], borderRadius: 12, overflow: "hidden", minWidth: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 12, paddingRight: 4, minHeight: phone ? 44 : 36, borderBottomWidth: 1, borderBottomColor: color.edge }}>
        <Text size="caption" tone="label" mono numberOfLines={1} style={{ flex: 1 }}>{label || "Code"}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={label ? `Copy the ${label} code` : "Copy the code"} onPress={copy} style={{ minHeight: phone ? 44 : 32, minWidth: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 8 }}>
          <Icon name={said ? "check" : "copy"} tone="label" />
          <Text size="caption" tone="label">{said ? "Copied" : "Copy"}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 10 }}>
        <View>
          {lines.map((l, i) => (
            <Text key={i} mono selectable size="caption" style={{ fontSize: 12.5, lineHeight: 19 }}>
              {l.length ? l.map((t, j) => <Text key={j} mono size="caption" style={{ color: ink[t.k], fontSize: 12.5, lineHeight: 19, ...(t.k === "com" ? { fontStyle: "italic" as const } : null) }}>{t.v}</Text>) : " "}
            </Text>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
