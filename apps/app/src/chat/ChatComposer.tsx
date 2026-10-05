// The composer (design idea 5). Never disabled: while a turn is on, Send says Queue and the message
// waits above the composer until it is picked up. `@` people and assistants, `#` records (a record
// with sealed fields carries a chip that says so), `/` commands. Attachments, photos and voice are
// callbacks. A model switcher with the fit score, and a "runs on" chip. On a phone it grows to a
// sheet with 44 px targets when it is focused or holds text; on a desktop it is the prototype's
// card with the bar under the input.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, TextInput, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from "react-native";
import { Chip, Icon, Text, useUiTheme } from "@vyre/ui";
import { Face } from "./Face";
import { COMMANDS } from "../../../../deck/chat/core/commands.js";
import { readDraft, writeDraft } from "./drafts";
import { pick, rankByName, rankCommands, runsOnLabel, sealedChip, sendIntent, sendTargets, triggerAt } from "./composer-model.js";

export type Person = { name: string; family: "person" | "assistant" };
export type RecordPick = { name: string; type: string; sealed: number };
export type ModelChoice = { id: string; label: string; fit: number | null };
export type ComposerProps = {
  state: string;
  people?: readonly Person[];
  records?: readonly RecordPick[];
  models?: readonly ModelChoice[];
  model?: string;
  onModel?: (id: string) => void;
  runsOn?: "mac" | "server";
  onRunsOn?: () => void;
  /** `o` says who it goes to: the @mentioned assistants, or all of them with "Ask all"; two or more make a fan-out. */
  onSend: (text: string, o?: { to: string[]; fanout: boolean }) => void;
  /** Edit and retry: the words to put in the box, once per `id`. Sending then replaces that message. */
  editing?: { id: number; text: string } | null;
  onCancelEdit?: () => void;
  onAttachFile?: () => void;
  onAttachPhoto?: () => void;
  onVoice?: () => void;
  phone: boolean;
  autoFocus?: boolean;
  /** Called on every keystroke with performance.now(); the perf script reads it. */
  onKey?: (t: number) => void;
  /** The thread this composer writes to: what is typed and not sent is kept under it. */
  draftKey?: string;
};

const T = 44;

function Tool({ icon, label, onPress, big }: { icon: any; label: string; onPress?: () => void; big: boolean }) {
  const s = big ? T : 36;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ width: s, height: s, alignItems: "center", justifyContent: "center", borderRadius: s / 2 }}>
      <Icon name={icon} size={20} />
    </Pressable>
  );
}

export function ChatComposer(p: ComposerProps) {
  const { color } = useUiTheme();
  const [text, setText] = useState(() => (p.draftKey ? readDraft(p.draftKey) : ""));
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [models, setModels] = useState(false);
  const [askAll, setAskAll] = useState(false);
  const assistants = (p.people ?? []).filter((x) => x.family === "assistant").length;
  const input = useRef<TextInput>(null);
  const trig = useMemo(() => triggerAt(text, caret), [text, caret]);
  const editId = p.editing?.id;
  useEffect(() => {
    if (!p.editing) return;
    setText(p.editing.text);
    setCaret(p.editing.text.length);
    input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);
  useEffect(() => { if (p.draftKey) writeDraft(p.draftKey, text); }, [p.draftKey, text]);
  const intent = sendIntent({ text, state: p.state });
  const expanded = !p.phone || focused || text.length > 0 || !!trig || models;
  const big = p.phone;

  const options = useMemo(() => {
    if (!trig) return [];
    if (trig.kind === "command") return rankCommands(COMMANDS, trig.range.query).slice(0, 6).map((c) => ({ key: c.name, label: "/" + c.name, sub: c.description, pick: c.name }));
    if (trig.kind === "person") return rankByName(p.people ?? [], trig.range.query).slice(0, 6).map((x) => ({ key: x.name, label: x.name, sub: x.family === "assistant" ? "Assistant" : "Person", pick: x.name, avatar: x }));
    return rankByName(p.records ?? [], trig.range.query).slice(0, 6).map((r) => ({ key: r.name, label: r.name, sub: r.type, pick: r.name, chip: sealedChip(r) }));
  }, [trig, p.people, p.records]);

  const choose = (o: { pick: string }) => {
    if (!trig) return;
    const r = pick(text, trig, o.pick);
    setText(r.text);
    setCaret(r.caret);
    input.current?.focus();
  };
  const send = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    const to = sendTargets({ text: t, askAll, people: p.people ?? [] });
    if (to.to.length) p.onSend(t, to); else p.onSend(t);
    setText("");
    setCaret(0);
    setAskAll(false);
  }, [text, p, askAll]);
  const onSel = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => setCaret(e.nativeEvent.selection.end);
  const insert = (ch: string) => { const t = text.slice(0, caret) + ch + text.slice(caret); setText(t); setCaret(caret + 1); input.current?.focus(); };
  const current = (p.models ?? []).find((m) => m.id === p.model);
  const field = (
      <TextInput
        ref={input}
        value={text}
        onChangeText={(t) => { p.onKey?.(performance.now()); setText(t); }}
        onSelectionChange={onSel}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus={p.autoFocus}
        multiline
        placeholder={askAll ? "Ask every assistant here at once" : intent.queue || p.state === "working" ? "Say more. It queues until the next step." : "Message, or / for commands"}
        placeholderTextColor={color.label}
        accessibilityLabel="Message"
        onKeyPress={(e: any) => { if (!p.phone && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey && !trig) { e.preventDefault?.(); send(); } }}
        style={{ color: color.text, fontSize: 16, lineHeight: 24, minHeight: expanded && p.phone ? 72 : 24, maxHeight: 160, paddingLeft: expanded ? 6 : 0, paddingRight: expanded ? 6 : 0, paddingVertical: 4, flex: expanded ? undefined : 1, minWidth: 0, outlineStyle: "none" } as any}
      />
  );
  const chips = (
    <>
      {p.models?.length ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Switch model" onPress={() => setModels((m) => !m)} style={{ minHeight: big ? T : 32, justifyContent: "center" }}>
          <Chip>{current ? `${current.label}${current.fit != null ? `, fit ${current.fit}` : ""}` : "Model"}</Chip>
        </Pressable>
      ) : null}
      {assistants > 1 ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Ask all assistants at once" accessibilityState={{ selected: askAll }} onPress={() => setAskAll((a) => !a)} style={{ minHeight: big ? T : 32, justifyContent: "center" }}>
          <Chip tone={askAll ? "accent" : "plain"} icon="agents">Ask all</Chip>
        </Pressable>
      ) : null}
      {p.runsOn ? (
        <Pressable accessibilityRole="button" accessibilityLabel={runsOnLabel(p.runsOn)} onPress={p.onRunsOn} style={{ minHeight: big ? T : 32, justifyContent: "center" }}>
          <Chip icon={p.runsOn === "mac" ? "laptop" : "box"}>{p.runsOn === "mac" ? "This Mac" : "The server"}</Chip>
        </Pressable>
      ) : null}
    </>
  );
  const chipsRow = <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", paddingHorizontal: 4 }}>{chips}</View>;

  return (
    <View style={{ width: "100%", maxWidth: 860, alignSelf: "center", paddingHorizontal: p.phone ? 8 : 20, paddingBottom: p.phone ? 8 : 16, paddingTop: 6 }}>
      {p.editing ? (
        <View accessibilityLabel="Editing a message" style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: big ? T : 36, paddingHorizontal: 12, marginBottom: 6, borderRadius: 12, borderWidth: 1, borderColor: color["edge-strong"], backgroundColor: color["accent-wash"] }}>
          <Icon name="refresh" />
          <Text size="caption" style={{ flex: 1 }}>Editing a message. Sending goes back to before it and runs this instead.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel edit" onPress={() => { setText(""); setCaret(0); p.onCancelEdit?.(); }} style={{ minHeight: big ? T : 32, justifyContent: "center", paddingHorizontal: 8 }}>
            <Text strong size="caption">Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      {options.length ? (
        <View accessibilityLabel="Suggestions" style={{ backgroundColor: color["surface-3"], borderWidth: 1, borderColor: color["edge-strong"], borderRadius: 14, padding: 4, marginBottom: 6 }}>
          {options.map((o: any) => (
            <Pressable key={o.key} accessibilityRole="button" onPress={() => choose(o)} style={{ minHeight: big ? T : 36, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderRadius: 8 }}>
              {o.avatar ? <Face name={o.avatar.name} family={o.avatar.family} size={24} /> : null}
              <Text strong>{o.label}</Text>
              <Text size="caption" tone="label" numberOfLines={1} style={{ flex: 1 }}>{o.sub}</Text>
              {o.chip ? <Chip tone="sealed" icon="shield">{o.chip}</Chip> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
      {models ? (
        <View style={{ backgroundColor: color["surface-3"], borderWidth: 1, borderColor: color["edge-strong"], borderRadius: 14, padding: 4, marginBottom: 6 }}>
          {(p.models ?? []).map((m) => (
            <Pressable key={m.id} accessibilityRole="button" accessibilityState={{ selected: m.id === p.model }} onPress={() => { p.onModel?.(m.id); setModels(false); }} style={{ minHeight: big ? T : 36, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 }}>
              <Text strong style={{ flex: 1 }}>{m.label}</Text>
              {m.fit != null ? <Text size="caption" tone="label">{`fit ${m.fit}`}</Text> : null}
              {m.id === p.model ? <Icon name="check" /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={{ backgroundColor: color["surface-2"], borderWidth: 1, borderColor: color["edge-strong"], borderRadius: expanded && p.phone ? 22 : 18, padding: 10, gap: 6 }}>
        {!expanded ? (
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
            <Tool big={big} icon="plus" label="Attach" onPress={p.onAttachFile} />
            {field}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={intent.queue ? "Queue message" : "Send"}
              onPress={send}
              style={{ width: T, height: T, borderRadius: T / 2, backgroundColor: intent.send ? color.primary : color.hover, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="send" size={20} tone={intent.send ? "primary-ink" : "label"} />
            </Pressable>
          </View>
        ) : field}
        {expanded && p.phone ? chipsRow : null}
        {expanded ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
          {expanded ? (
            <>
              <Tool big={big} icon="file" label="Attach a file" onPress={p.onAttachFile} />
              <Tool big={big} icon="eye" label="Attach a photo" onPress={p.onAttachPhoto} />
              <Tool big={big} icon="mic" label="Dictate" onPress={p.onVoice} />
              <Tool big={big} icon="chat" label="Mention a person or assistant" onPress={() => insert("@")} />
              <Tool big={big} icon="todo" label="Tag a record" onPress={() => insert("#")} />
            </>
          ) : null}
          <View style={{ flex: 1, minWidth: 8 }} />
          {!p.phone ? chips : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={intent.queue ? "Queue message" : "Send"}
            onPress={send}
            style={{ width: T, height: T, borderRadius: T / 2, backgroundColor: intent.send ? color.primary : color.hover, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="send" size={20} tone={intent.send ? "primary-ink" : "label"} />
          </Pressable>
        </View>
        ) : null}
      </View>
    </View>
  );
}
