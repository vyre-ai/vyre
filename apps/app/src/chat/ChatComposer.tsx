// The composer (design idea 5). Never disabled: while a turn is on, Send says Queue and the message
// waits above the composer until it is picked up. `@` people and assistants, `#` records (a record
// with sealed fields carries a chip that says so), `/` commands. Attachments and photos are
// callbacks (voice capture has no control until it exists: team/BACKLOG.md). A model switcher with the fit score, and a "runs on" chip. On a phone it grows to a
// sheet with 44 px targets when it is focused or holds text; on a desktop it is the prototype's
// card with the bar under the input.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, TextInput, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from "react-native";
import { Chip, Icon, Text, useUiTheme, type IconName } from "@vyre/ui";
import { Face } from "./Face";
import { Thumb } from "./Thumb";
import { COMMANDS } from "./core/commands.js";
import { readDraft, writeDraft } from "./drafts";
import { busyState } from "./frames.js";
import { mentionsIn, pick, rankByName, rankCommands, runsOnLabel, sealedChip, sendIntent, sendTargets, triggerAt } from "./composer-model.js";

export type Person = { name: string; family: "person" | "assistant"; doing?: string };
/** A record the # picker offers: its urn goes to the box beside the words; `sealed` is how many of its fields are sealed (the assistant sees those only as placeholders). */
export type RecordPick = { name: string; type: string; sealed: number; urn?: string; kind?: string };
export type PickedMention = { kind: string; id: string; name: string };
export type ModelChoice = { id: string; label: string; fit: number | null };
export type ComposerProps = {
  state: string;
  people?: readonly Person[];
  records?: readonly RecordPick[];
  models?: readonly ModelChoice[];
  model?: string;
  onModel?: (id: string, slot?: string) => void;
  /** The slots in a chat with several assistants or models: each gets its own chip to switch that one's model. Fewer than two: the one model chip. */
  slots?: readonly { id: string; label: string; provider?: string | null }[];
  runsOn?: "mac" | "server";
  onRunsOn?: () => void;
  /** `o` says who it goes to: the @mentioned assistants, or all of them with "Ask all"; two or more make a fan-out. */
  onSend: (text: string, o?: { to: string[]; fanout: boolean; mentions?: PickedMention[]; mode?: "steer" | "queue" }) => void;
  /** Called while the person types (at most once every 3 seconds): the chat tells the others. */
  onTyping?: () => void;
  /** Edit and retry: the words to put in the box, once per `id`. Sending then replaces that message. */
  editing?: { id: number; text: string } | null;
  onCancelEdit?: () => void;
  onAttachFile?: () => void;
  onAttachPhoto?: () => void;
  /** The files added to the next message, as chips (name, a line under it, and where it is), and how to take one off. Sending with files and no words is allowed. */
  attachments?: readonly { key: string; name: string; line: string; state: "uploading" | "ready" | "failed"; thumb?: string }[];
  onRemoveAttachment?: (key: string) => void;
  /** Why the last file was not added, in words. */
  attachProblem?: string | null;
  phone: boolean;
  autoFocus?: boolean;
  /** Called on every keystroke with performance.now(); the perf script reads it. */
  onKey?: (t: number) => void;
  /** The thread this composer writes to: what is typed and not sent is kept under it. */
  draftKey?: string;
};

const T = 44;

/** A quiet choice under the box (the model, where it runs, send now or queue): words with a small arrow, not a chip, so it reads as a thing you can change and not as a setting that is on. */
function Quiet({ icon, label, onPress, name, T, active }: { icon?: IconName; label: string; onPress?: () => void; name: string; T: number; active?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} style={{ minHeight: T, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4 }}>
      {icon ? <Icon name={icon} tone={active ? "accent" : "label"} size={14} /> : null}
      <Text size="caption" tone={active ? "accent" : "label"} numberOfLines={1}>{`${label} \u25BE`}</Text>
    </Pressable>
  );
}

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
  const [slotSel, setSlotSel] = useState<string | undefined>(undefined);
  // While the assistant works, a message either steers it now or waits in the queue for the end of the turn.
  const [mode, setMode] = useState<"steer" | "queue">("steer");
  const lastTyping = useRef(0);
  const [askAll, setAskAll] = useState(false);
  // The # tags picked from the list, by the name typed into the words: only the ones still in the message are sent.
  const picked = useRef(new Map<string, PickedMention>());
  // "Ask all" is for the assistants and models IN this chat (its slots), not every agent the space has to @mention.
  const assistants = p.slots?.length ?? 0;
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
  const files = p.attachments?.filter((a) => a.state === "ready").length ?? 0;
  const intent = sendIntent({ text, attachments: files, state: p.state });
  const expanded = !p.phone || focused || text.length > 0 || !!trig || models;
  const big = p.phone;

  const options = useMemo(() => {
    if (!trig) return [];
    if (trig.kind === "command") return rankCommands(COMMANDS, trig.range.query).slice(0, 6).map((c) => ({ key: c.name, label: "/" + c.name, sub: c.description, pick: c.name }));
    if (trig.kind === "person") return rankByName(p.people ?? [], trig.range.query).slice(0, 6).map((x) => ({ key: x.name, label: x.name, sub: x.family === "assistant" ? (x.doing || "Assistant") : "Person", pick: x.name, avatar: x }));
    return rankByName(p.records ?? [], trig.range.query).slice(0, 6).map((r) => ({ key: r.urn ?? r.name, label: r.name, sub: r.type, pick: r.name, chip: sealedChip(r), urn: r.urn, kind: r.kind }));
  }, [trig, p.people, p.records]);

  const choose = (o: { pick: string; urn?: string; kind?: string }) => {
    if (!trig) return;
    if (trig.kind !== "command" && trig.kind !== "person" && o.urn) picked.current.set(o.pick, { kind: o.kind ?? "record", id: o.urn, name: o.pick });
    const r = pick(text, trig, o.pick);
    setText(r.text);
    setCaret(r.caret);
    input.current?.focus();
  };
  const send = useCallback((over?: "steer" | "queue") => {
    const t = text.trim();
    if (!t && !files) return;
    const to = sendTargets({ text: t, askAll, people: p.people ?? [] });
    const mentions = mentionsIn(t, picked.current) as PickedMention[];
    const working = busyState(p.state);
    if (to.to.length || mentions.length || working) p.onSend(t, { ...to, ...(mentions.length ? { mentions } : {}), ...(working ? { mode: over ?? mode } : {}) }); else p.onSend(t);
    picked.current.clear();
    setText("");
    setCaret(0);
    setAskAll(false);
  }, [text, p, askAll, mode, files]);
  const onSel = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => setCaret(e.nativeEvent.selection.end);
  const insert = (ch: string) => { const t = text.slice(0, caret) + ch + text.slice(caret); setText(t); setCaret(caret + 1); input.current?.focus(); };
  const current = (p.models ?? []).find((m) => m.id === p.model);
  const field = (
      <TextInput
        ref={input}
        value={text}
        onChangeText={(t) => { p.onKey?.(performance.now()); setText(t); if (t.trim() && p.onTyping && Date.now() - lastTyping.current > 3000) { lastTyping.current = Date.now(); p.onTyping(); } }}
        onSelectionChange={onSel}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus={p.autoFocus}
        multiline
        placeholder={askAll ? (p.phone ? "Ask everyone" : "Ask every assistant here at once") : intent.queue || p.state === "working" ? (p.phone ? "Say more (it queues)" : "Say more. It queues until the next step.") : (p.phone ? "Message" : "Message, or / for commands")}
        placeholderTextColor={color.label}
        accessibilityLabel="Message"
        onKeyPress={(e: any) => { if (!p.phone && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey && !trig) { e.preventDefault?.(); const ne = e.nativeEvent; send(ne.metaKey || ne.ctrlKey ? "steer" : undefined); } }}
        style={{ color: color.text, fontSize: 16, lineHeight: 24, minHeight: expanded && p.phone ? 72 : 24, maxHeight: 160, paddingLeft: expanded ? 6 : 0, paddingRight: expanded ? 6 : 0, paddingVertical: 4, flex: expanded ? undefined : 1, minWidth: 0, outlineStyle: "none" } as any}
      />
  );
  const chips = (
    <>
      {busyState(p.state) ? (
        <Quiet T={big ? T : 32} icon={mode === "steer" ? "bolt" : "clock"} label={mode === "steer" ? "Send now" : "Queue"}
          name={mode === "steer" ? "Sends now, steering the reply. Tap to queue instead" : "Waits for the reply to end. Tap to steer instead"} onPress={() => setMode((m) => (m === "steer" ? "queue" : "steer"))} />
      ) : null}
      {p.models?.length && (p.slots?.length ?? 0) > 1 ? p.slots!.map((sl) => (
        <Quiet key={sl.id} T={big ? T : 32} label={sl.label} name={`Switch the model for ${sl.label}`} onPress={() => { setSlotSel(sl.id); setModels((m) => (slotSel === sl.id ? !m : true)); }} />
      )) : p.models?.length ? (
        <Quiet T={big ? T : 32} label={current ? current.label : "Model"} name="Switch model" onPress={() => { setSlotSel(undefined); setModels((m) => !m); }} />
      ) : null}
      {assistants > 1 ? (
        <Quiet T={big ? T : 32} icon="agents" label={assistants === 2 ? "Ask both" : "Ask all"} active={askAll} name="Ask all assistants at once" onPress={() => setAskAll((a) => !a)} />
      ) : null}
      {p.runsOn ? (
        <Quiet T={big ? T : 32} icon={p.runsOn === "mac" ? "laptop" : "box"} label={p.runsOn === "mac" ? "This Mac" : "The server"} name={runsOnLabel(p.runsOn)} onPress={p.onRunsOn} />
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
            <Pressable key={m.id} accessibilityRole="button" accessibilityState={{ selected: m.id === p.model }} onPress={() => { p.onModel?.(m.id, slotSel); setModels(false); }} style={{ minHeight: big ? T : 36, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 }}>
              <Text strong style={{ flex: 1 }}>{m.label}</Text>
              {m.fit != null ? <Text size="caption" tone="label">{`${m.fit} percent match`}</Text> : null}
              {m.id === p.model ? <Icon name="check" /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={{ backgroundColor: color["surface-2"], borderWidth: 1, borderColor: color["edge-strong"], borderRadius: expanded && p.phone ? 22 : 18, padding: p.phone ? 6 : 10, gap: 4 }}>
        {p.attachments?.length ? (
          <View accessibilityLabel="Files for this message" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {p.attachments.map((a) => (a.thumb ? (
              <Thumb key={a.key} uri={a.thumb} name={a.name} state={a.state} onRemove={() => p.onRemoveAttachment?.(a.key)} />
            ) : (
              <Pressable key={a.key} accessibilityRole="button" accessibilityLabel={`${a.name}, ${a.line}. Remove`} onPress={() => p.onRemoveAttachment?.(a.key)} style={{ minHeight: big ? T : 32, justifyContent: "center" }}>
                <Chip tone={a.state === "failed" ? "err" : a.state === "ready" ? "plain" : "accent"} icon={a.state === "failed" ? "failed" : "file"}>{a.state === "failed" ? `${a.name} · not added` : `${a.name} · ${a.line}`}</Chip>
              </Pressable>
            )))}
          </View>
        ) : null}
        {p.attachProblem ? <Text size="caption" tone="warn">{p.attachProblem}</Text> : null}
        {!expanded ? (
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
            <Tool big={big} icon="plus" label="Attach" onPress={p.onAttachFile} />
            {field}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={intent.queue ? "Queue message" : "Send"}
              onPress={() => send()}
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
              <Tool big={big} icon="chat" label="Mention a person or assistant" onPress={() => insert("@")} />
              <Tool big={big} icon="todo" label="Tag a record" onPress={() => insert("#")} />
            </>
          ) : null}
          <View style={{ flex: 1, minWidth: 8 }} />
          {!p.phone ? chips : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={intent.queue ? "Queue message" : "Send"}
            onPress={() => send()}
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
