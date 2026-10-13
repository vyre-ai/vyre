// Markdown as a document: drawn with the app's own typography, and one press away from editing it. Editing is a clean text editor with a formatting bar and a live preview beside it (below it on a phone),
// Enter continues a list, and @ and # tags are drawn as chips. Saving belongs to the caller (FileViewer), which asks before throwing away what is typed.
import { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from "react-native";
import { Markdown } from "../components/Markdown";
import { Segmented } from "../components/Segmented";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { applyFormat, continueList, type Format } from "./edit-ops.js";
import { tagParts } from "./viewer-model.js";

const TASK = /^\[( |x|X)\] /;

/** Plain words with tags as chips and a checklist box where a list item starts with one. */
export function richText(v: string, color: Record<string, string>): React.ReactNode {
  const task = TASK.exec(v);
  const rest = task ? v.slice(task[0].length) : v;
  return (
    <>
      {task ? <Text size="read" tone={task[1] === " " ? "label" : "accent"}>{task[1] === " " ? "☐ " : "☑ "}</Text> : null}
      {tagParts(rest).map((p, i) => p.t === "text" ? p.v : (
        <Text key={i} size="read" strong style={{ color: p.kind === "mention" ? color.accent : color.ok, backgroundColor: color["surface-3"] }}>{` ${p.v} `}</Text>
      ))}
    </>
  );
}

export function MarkdownView({ text }: { text: string }) {
  const { color } = useUiTheme();
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, maxWidth: 820, width: "100%", alignSelf: "center" }}>
      <Markdown text={text} textNode={(v) => richText(v, color as unknown as Record<string, string>)} />
    </ScrollView>
  );
}

const BAR: [Format, string, string][] = [
  ["h1", "H1", "Heading 1"], ["h2", "H2", "Heading 2"], ["bold", "B", "Bold"], ["italic", "I", "Italic"], ["code", "<>", "Code"], ["link", "Link", "Link"],
  ["bullet", "•", "Bulleted list"], ["number", "1.", "Numbered list"], ["task", "☑", "Checklist"], ["quote", "“", "Quote"], ["fence", "{ }", "Code block"],
];

export function MarkdownEditor({ value, onChange, onSave }: { value: string; onChange: (t: string) => void; onSave?: () => void }) {
  const { color } = useUiTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [pane, setPane] = useState<"write" | "preview">("write");
  const sel = useRef({ start: 0, end: 0 });
  const input = useRef<TextInput>(null);
  const [pending, setPending] = useState<{ start: number; end: number } | undefined>();
  const format = (f: Format) => {
    const r = applyFormat(value, sel.current, f);
    onChange(r.text);
    sel.current = r.sel;
    setPending(r.sel);
    setTimeout(() => { setPending(undefined); input.current?.focus(); }, 0);
  };
  const onKey = (e: { nativeEvent: { key: string }; preventDefault?: () => void }) => {
    if (e.nativeEvent.key !== "Enter" || sel.current.start !== sel.current.end) return;
    const r = continueList(value, sel.current.start);
    if (!r) return;
    e.preventDefault?.();
    onChange(r.text);
    sel.current = { start: r.at, end: r.at };
    setPending(sel.current);
    setTimeout(() => setPending(undefined), 0);
  };
  const editor = (
    <TextInput
      ref={input}
      multiline
      value={value}
      onChangeText={onChange}
      onSelectionChange={(e) => { sel.current = e.nativeEvent.selection; }}
      selection={pending}
      onKeyPress={Platform.OS === "web" ? (onKey as never) : undefined}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck
      accessibilityLabel="Markdown"
      placeholder="Write in markdown"
      placeholderTextColor={color.faint}
      style={{ flex: 1, padding: 16, color: color.text, fontFamily: Platform.select({ web: "ui-monospace, Menlo, monospace", default: "Courier" }), fontSize: 14, lineHeight: 22, textAlignVertical: "top", ...(Platform.OS === "web" ? { outlineStyle: "none", resize: "none" } as object : null) }}
    />
  );
  return (
    <View style={{ flex: 1 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: color.edge }} contentContainerStyle={{ gap: 2, padding: 6, alignItems: "center" }}>
        {BAR.map(([f, label, name]) => (
          <Pressable key={f} accessibilityRole="button" accessibilityLabel={name} onPress={() => format(f)} style={{ minWidth: 36, minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: 8, paddingHorizontal: 8 }}>
            <Text size="secondary" strong={f === "bold"} style={f === "italic" ? { fontStyle: "italic" } : undefined}>{label}</Text>
          </Pressable>
        ))}
        {!wide ? <View style={{ marginLeft: 12 }}><Segmented options={[["write", "Write"], ["preview", "Preview"]]} value={pane} onChange={setPane} label="Pane" /></View> : null}
      </ScrollView>
      <View style={{ flex: 1, flexDirection: wide ? "row" : "column" }}>
        {wide || pane === "write" ? <View style={{ flex: 1, minWidth: 0 }}>{editor}</View> : null}
        {wide ? <View style={{ width: 1, backgroundColor: color.edge }} /> : null}
        {wide || pane === "preview" ? <View style={{ flex: 1, minWidth: 0 }}><MarkdownView text={value} /></View> : null}
      </View>
    </View>
  );
}
