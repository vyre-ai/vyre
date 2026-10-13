// Markdown as a document: drawn with the app's own typography, and one press away from editing it. Editing is a clean text editor with a formatting bar and a live preview beside it (below it on a phone),
// Enter continues a list, and @ and # tags are drawn as chips. A reference picked from the Space (a person, agent, record, file or tag) is stored as a markdown link to its vyre:// address (lib/doc-refs.js); the
// editor shows only its name, the preview and the row of references show it as a chip that opens the thing. Saving belongs to the caller (FileViewer), which asks before throwing away what is typed.
import { useMemo, useRef, useState, type ComponentType, type MutableRefObject } from "react";
import { Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from "react-native";
import { Markdown } from "../components/Markdown";
import { Segmented } from "../components/Segmented";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { applyFormat, continueList, type Format } from "./edit-ops.js";
import { tagParts } from "./viewer-model.js";
import { RefChip } from "./RefChip";
import { fromEditable, parseRefs, toEditable } from "../../../../lib/doc-refs.js";

const TASK = /^\[( |x|X)\] /;
const kindOfUrn = (urn: string) => parseRefs(`[@x](${urn})`)[0]?.kind ?? "record";

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

export function MarkdownView({ text, onOpenRef }: { text: string; onOpenRef?: (urn: string) => void }) {
  const { color } = useUiTheme();
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, maxWidth: 820, width: "100%", alignSelf: "center" }}>
      <Markdown text={text} textNode={(v) => richText(v, color as unknown as Record<string, string>)} renderRef={(r) => <RefChip lead={r.lead} name={r.name} kind={kindOfUrn(r.urn)} onOpen={onOpenRef ? () => onOpenRef(r.urn) : undefined} />} />
    </ScrollView>
  );
}

const BAR: [Format, string, string][] = [
  ["h1", "H1", "Heading 1"], ["h2", "H2", "Heading 2"], ["bold", "B", "Bold"], ["italic", "I", "Italic"], ["code", "<>", "Code"], ["link", "Link", "Link"],
  ["bullet", "•", "Bulleted list"], ["number", "1.", "Numbered list"], ["task", "☑", "Checklist"], ["quote", "“", "Quote"], ["fence", "{ }", "Code block"],
];

/** What the editor hands a mention picker: the words and caret, how to write the picked words back, and how to say what the pick is (its address). `keys` is where the picker puts its key handler (true: it took the key). */
export type AssistProps = {
  text: string;
  caret: number;
  apply: (text: string, caret: number) => void;
  remember: (lead: "@" | "#", name: string, urn: string) => void;
  keys: MutableRefObject<((e: { key: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => boolean) | null>;
};

export function MarkdownEditor({ value, onChange, onSave, assist: Assist, onOpenRef }: { value: string; onChange: (t: string) => void; onSave?: () => void; assist?: ComponentType<AssistProps>; onOpenRef?: (urn: string) => void }) {
  const { color } = useUiTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [pane, setPane] = useState<"write" | "preview">("write");
  const sel = useRef({ start: 0, end: 0 });
  const input = useRef<TextInput>(null);
  const [pending, setPending] = useState<{ start: number; end: number } | undefined>();
  const [caret, setCaret] = useState(0);
  const keys = useRef<AssistProps["keys"]["current"]>(null);
  // The words as written (no addresses) and what was taken out to show them: the stored text is rebuilt from both on every change.
  const { text: shown, refs: stored } = useMemo(() => toEditable(value), [value]);
  const picks = useRef(new Map<string, string>());
  const change = (t: string) => onChange(fromEditable(t, new Map([...stored, ...picks.current])));
  const here = useMemo(() => {
    const seen = new Set<string>();
    return parseRefs(value).filter((r) => (seen.has(r.urn) ? false : (seen.add(r.urn), true)));
  }, [value]);
  const format = (f: Format) => {
    const r = applyFormat(shown, sel.current, f);
    change(r.text);
    sel.current = r.sel;
    setPending(r.sel);
    setTimeout(() => { setPending(undefined); input.current?.focus(); }, 0);
  };
  const onKey = (e: { nativeEvent: { key: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }; preventDefault?: () => void }) => {
    if (keys.current?.(e.nativeEvent)) { e.preventDefault?.(); return; }
    if (e.nativeEvent.key !== "Enter" || sel.current.start !== sel.current.end) return;
    const r = continueList(shown, sel.current.start);
    if (!r) return;
    e.preventDefault?.();
    change(r.text);
    sel.current = { start: r.at, end: r.at };
    setPending(sel.current);
    setTimeout(() => setPending(undefined), 0);
  };
  const editor = (
    <TextInput
      ref={input}
      multiline
      value={shown}
      onChangeText={change}
      onSelectionChange={(e) => { sel.current = e.nativeEvent.selection; setCaret(e.nativeEvent.selection.end); }}
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
      {here.length ? (
        <View accessibilityLabel="References in this document" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: color.edge }}>
          {here.map((r) => <RefChip key={r.urn} lead={r.lead} name={r.name} kind={r.kind} onOpen={onOpenRef ? () => onOpenRef(r.urn) : undefined} />)}
        </View>
      ) : null}
      {Assist ? <Assist text={shown} caret={caret} keys={keys} remember={(lead, name, urn) => { picks.current.set(lead + name, urn); }} apply={(t, c) => { change(t); sel.current = { start: c, end: c }; setCaret(c); setPending(sel.current); setTimeout(() => { setPending(undefined); input.current?.focus(); }, 0); }} /> : null}
      <View style={{ flex: 1, flexDirection: wide ? "row" : "column" }}>
        {wide || pane === "write" ? <View style={{ flex: 1, minWidth: 0 }}>{editor}</View> : null}
        {wide ? <View style={{ width: 1, backgroundColor: color.edge }} /> : null}
        {wide || pane === "preview" ? <View style={{ flex: 1, minWidth: 0 }}><MarkdownView text={value} onOpenRef={onOpenRef} /></View> : null}
      </View>
    </View>
  );
}
