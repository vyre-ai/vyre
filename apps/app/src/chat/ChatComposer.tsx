// The composer (design idea 5). Never disabled: while a turn is on, Send says Queue and the message
// waits above the composer until it is picked up. `@` people and assistants, `#` records (a record
// with sealed fields carries a chip that says so), `/` commands. Attachments and photos are
// callbacks (voice capture has no control until it exists: team/BACKLOG.md). One calm input; under it a "+" menu (attach, mention, tag, where it runs, send now or queue), ONE "Answering" control
// (stacked marks of the AIs that reply; pick one, several or all, and each one's model) and a quiet send. State that differs from the default shows as a chip. Every picker (/ @ # + Answering)
// is a combobox the box drives: type to filter, Up and Down, Enter or Tab, Esc, Backspace on an empty query (picker-model.js). On a phone it grows to a sheet with 44 px targets when it is
// focused or holds text; on a desktop it is the prototype's card with the bar under the input.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, TextInput, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from "react-native";
import { AiMark, AnsweringControl, Chip, ChipToken, Icon, PickerList, Text, Tip, optionId, useUiTheme, type IconName, type PickerItem } from "@vyre/ui";
import { answeringSummary, composerShortcut, deleteTokenBack, filterItems, moveActive, pickerKey, removeToken, toggleAnswering, tokensIn } from "@vyre/ui/lib/picker-model.js";
import { crumbsOf, nestHint, nestKey, nestRows, nestStep, type NestRow } from "@vyre/ui/lib/nest-model.js";
import { useMentionNodes } from "./useMentionNodes";
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
  /** A chat between people (set to "AI answers when mentioned", or with no AI in it): a message goes to the people and no AI answers, unless an AI is asked for that one message. The chip reads "People". */
  peopleOnly?: boolean;
  runsOn?: "mac" | "server";
  /** Where a chat runs unless the person moved it: the chip shows only when `runsOn` differs. */
  runsOnDefault?: "mac" | "server";
  onRunsOn?: () => void;
  /** `o` says who it goes to: the @mentioned assistants, or all of them with "Ask all"; two or more make a fan-out. */
  onSend: (text: string, o?: { to: string[]; fanout: boolean; mentions?: PickedMention[]; mode?: "steer" | "queue" }) => void;
  /** Called while the person types (at most once every 3 seconds): the chat tells the others. */
  onTyping?: () => void;
  /** Edit and retry: the words to put in the box, once per `id`. Sending then replaces that message. */
  editing?: { id: number; text: string } | null;
  onCancelEdit?: () => void;
  /** A command the screen answers itself (/move opens the chat panel on its project page): true when it did, and nothing is sent. */
  onLocalCommand?: (name: string) => boolean;
  onAttachFile?: () => void;
  /** Files in the Vyre space the person can attach by picking from a list (the structured Files layout); with `onAttachVyreFile` this makes "From Vyre Files". */
  vyreFiles?: readonly { id: string; name: string; path: string }[];
  onAttachVyreFile?: (id: string) => void;
  /** Kept so callers still compile; a photo is just a file now. */
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

function Tool({ icon, label, onPress, big }: { icon: any; label: string; onPress?: () => void; big: boolean }) {
  const s = big ? T : 36;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ width: s, height: s, alignItems: "center", justifyContent: "center", borderRadius: s / 2 }}>
      <Icon name={icon} size={20} />
    </Pressable>
  );
}

const POP_ID = "composer-pop";
/** The mark on a nested row: its kind (a project, an object, a file, a tag) or, for a top category, what it holds. */
function nestIcon(r: NestRow): IconName {
  if (r.trail.length === 1) return ({ projects: "projects", records: "records", files: "drive", tags: "hash", teams: "users", agents: "agents", people: "person" } as Record<string, IconName>)[r.trail[0]] ?? "hash";
  const k = (r.pick as { kind?: string } | undefined)?.kind;
  return k === "collection" ? "records" : k === "project" ? "projects" : k === "file" ? "file" : k === "tag" ? "hash" : r.drill ? "drive" : "hash";
}
/** What a token in the words shows: @ a person, # by what was picked. */
const tokenIcon = (lead: "@" | "#", kind?: string): IconName => (lead === "@" ? "mention" : kind === "collection" ? "records" : kind === "project" ? "projects" : kind === "file" ? "file" : "hash");
type Pop = null | "plus" | "files" | "vyrefiles" | "answering" | "model";
/** An icon for a file by its name: a picture, sound, film or document. Pictures with a thumbnail show the thumbnail instead. */
const fileIcon = (name: string): IconName => (/\.(png|jpe?g|gif|webp|heic|svg)$/i.test(name) ? "eye" : /\.(mp3|m4a|wav|ogg|flac)$/i.test(name) ? "mic" : /\.(mp4|mov|webm|mkv)$/i.test(name) ? "play" : "file");
type Row = PickerItem & { run: () => void };

export function ChatComposer(p: ComposerProps) {
  const { color } = useUiTheme();
  const [text, setText] = useState(() => (p.draftKey ? readDraft(p.draftKey) : ""));
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // The menus the person opens (+ and Answering); the / @ # lists open from the words at the caret.
  const [pop, setPop] = useState<Pop>(null);
  const [menuQ, setMenuQ] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [slotSel, setSlotSel] = useState<string | undefined>(undefined);
  // Which AIs answer the next message; empty is the chat's default. One message only: it resets after a send.
  const [answering, setAnswering] = useState<string[]>([]);
  // While the assistant works, a message either steers it now or waits in the queue for the end of the turn.
  const [mode, setMode] = useState<"steer" | "queue">("steer");
  const lastTyping = useRef(0);
  // The # tags picked from the list, by the name typed into the words: only the ones still in the message are sent.
  const picked = useRef(new Map<string, PickedMention>());
  const slots = p.slots ?? [];
  const input = useRef<TextInput>(null);
  const trigRaw = useMemo(() => triggerAt(text, caret), [text, caret]);
  const trig = trigRaw && trigRaw.range.start !== dismissed ? trigRaw : null;
  useEffect(() => { if (!trigRaw) setDismissed(null); }, [trigRaw]);
  // The @ and # lists nest: the keys of the branches opened so far (empty is the top). It starts over whenever a different trigger opens.
  const [nestPath, setNestPath] = useState<string[]>([]);
  const wantActive = useRef<number | null>(null);
  const trigId = trig && trig.kind !== "command" ? `${trig.kind}:${trig.range.start}` : null;
  useEffect(() => { setNestPath([]); }, [trigId]);
  const [nestSeen, setNestSeen] = useState(false);
  useEffect(() => { if (trigId) setNestSeen(true); }, [trigId]);
  const nodes = useMentionNodes({ wanted: nestSeen, people: p.people ?? [], records: p.records ?? [], files: p.vyreFiles ?? [], ais: useMemo(() => (p.slots ?? []).map((s) => s.label), [p.slots]) });
  const nestRoot = trig?.kind === "person" ? nodes.at : trig?.kind === "record" ? nodes.hash : null;
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
  const working = busyState(p.state);
  const expanded = !p.phone || focused || text.length > 0 || !!trig || !!pop;
  const big = p.phone;
  const ctl = big ? T : 36;
  const web = Platform.OS === "web";

  const allIds = useMemo(() => slots.map((s) => s.id), [slots]);
  const dflt = slots[0]?.id;
  const pm = !!p.peopleOnly;
  const effective = answering.length ? answering : dflt && !pm ? [dflt] : [];
  const ais = effective.map((id) => slots.find((s) => s.id === id)).filter(Boolean) as { id: string; label: string; provider?: string | null }[];
  const current = (p.models ?? []).find((m) => m.id === p.model);
  const summary = pm && !answering.length ? "People" : slots.length ? answeringSummary(answering, slots, pm ? undefined : dflt) : current ? current.label : "Model";

  const insert = (ch: string) => { const t = text.slice(0, caret) + ch + text.slice(caret); setText(t); setCaret(caret + 1); input.current?.focus(); };
  const closePop = () => { setPop(null); setMenuQ(""); setActive(0); input.current?.focus(); };
  const openPop = (k: Exclude<Pop, null>) => { setPop((cur) => (cur === k ? null : k)); setMenuQ(""); setActive(0); input.current?.focus(); };
  const toggleAi = (id: string) => { const r = toggleAnswering(effective, id, allIds); setAnswering(!pm && r.length === 1 && r[0] === dflt ? [] : r); };
  const askEveryone = () => setAnswering(effective.length === allIds.length ? [] : [...allIds]);

  const menuRows = useMemo((): Row[] => {
    if (pop === "plus") {
      const rows: Row[] = [
        { key: "at", group: "Insert", label: "Mention a person or agent", leading: <Icon name="mention" size={18} />, hint: "@", run: () => { setPop(null); setMenuQ(""); insert("@"); } },
        { key: "hash", group: "Insert", label: "Tag a record", leading: <Icon name="hash" size={18} />, hint: "#", run: () => { setPop(null); setMenuQ(""); insert("#"); } },
      ];
      if (p.runsOn) {
        rows.push({ key: "mac", group: "Runs on", label: "This Mac", leading: <Icon name="laptop" size={18} />, checked: p.runsOn === "mac", run: () => { if (p.runsOn !== "mac") p.onRunsOn?.(); closePop(); } });
        rows.push({ key: "server", group: "Runs on", label: "The server", leading: <Icon name="box" size={18} />, checked: p.runsOn === "server", run: () => { if (p.runsOn !== "server") p.onRunsOn?.(); closePop(); } });
      }
      if (working) {
        rows.push({ key: "steer", group: "While it works", label: "Send now, steering the reply", leading: <Icon name="bolt" size={18} />, checked: mode === "steer", hint: "Enter", run: () => { setMode("steer"); closePop(); } });
        rows.push({ key: "queue", group: "While it works", label: "Queue for the end of the turn", leading: <Icon name="clock" size={18} />, checked: mode === "queue", hint: "Alt Enter", run: () => { setMode("queue"); closePop(); } });
      }
      return rows;
    }
    if (pop === "files") {
      const rows: Row[] = [];
      if (p.vyreFiles && p.onAttachVyreFile) rows.push({ key: "vyre", label: "From Vyre Files", sub: "Pick from this space's files", leading: <Icon name="drive" size={18} />, hint: "Right", run: () => { setPop("vyrefiles"); setMenuQ(""); setActive(0); } });
      rows.push({ key: "computer", label: "From your computer", sub: "Any file: picture, document, video, audio", leading: <Icon name="upload" size={18} />, hint: "Cmd U", run: () => { closePop(); p.onAttachFile?.(); } });
      return rows;
    }
    if (pop === "vyrefiles") return (p.vyreFiles ?? []).map((f) => ({ key: f.id, label: f.name, sub: f.path, leading: <Icon name={fileIcon(f.name)} size={18} />, run: () => { closePop(); p.onAttachVyreFile?.(f.id); } }));
    if (pop === "answering") {
      const rows: Row[] = [];
      if (pm) rows.push({ key: "people", group: "Who answers", label: "Just the people", sub: "No AI answers this message", leading: <Icon name="users" size={18} />, checked: !answering.length, run: () => { setAnswering([]); closePop(); } });
      const ask = pm ? "Ask an AI for this message" : "Who answers";
      if (slots.length) {
        if (slots.length > 1) rows.push({ key: "all", group: ask, label: "Everyone", sub: pm ? "Every AI here answers this message" : "Every AI in this chat replies", leading: <Icon name="agents" size={18} />, checked: effective.length === allIds.length, hint: "Alt 0", run: askEveryone });
        slots.forEach((sl, i) => rows.push({ key: sl.id, group: ask, label: sl.label, sub: sl.id === dflt && !pm ? "Answers by default" : undefined, leading: <AiMark ai={sl} size={22} />, checked: effective.includes(sl.id), hint: i < 9 ? `Alt ${i + 1}` : undefined, run: () => toggleAi(sl.id) }));
      }
      // In a chat between people the model rows wait until an AI is picked.
      if (p.models?.length && !(pm && !answering.length)) {
        (slots.length > 1 ? (pm ? slots.filter((sl) => answering.includes(sl.id)) : slots) : [{ id: "", label: "This chat", provider: null }]).forEach((sl) => rows.push({ key: `m-${sl.id}`, group: "Model", label: slots.length > 1 ? `Model for ${sl.label}` : "Switch model", sub: slots.length > 1 ? undefined : current?.label, leading: <Icon name="spark" size={18} />, hint: "Right", run: () => { setSlotSel(sl.id || undefined); setPop("model"); setMenuQ(""); setActive(0); } }));
      }
      return rows;
    }
    if (pop === "model") {
      return (p.models ?? []).map((m) => ({ key: m.id, label: m.label, checked: m.id === p.model, trailing: m.fit != null ? <Text size="caption" tone="label">{`${m.fit}% match`}</Text> : undefined, run: () => { p.onModel?.(m.id, slotSel); closePop(); } }));
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pop, p.runsOn, p.models, p.model, slots, working, mode, answering, slotSel, text, caret]);

  const nestList = useMemo((): NestRow[] => (nestRoot && trig ? nestRows(nestRoot, nestPath, trig.range.query) : []), [nestRoot, nestPath, trig]);
  const drillRow = (i: number) => {
    const r = nestList[i];
    if (!r?.drill || !trig) return;
    // What was typed was a search for this row: it is spent once the row is open.
    const t = text.slice(0, trig.range.start + 1) + text.slice(trig.range.end);
    setText(t);
    setCaret(trig.range.start + 1);
    setNestPath(nestStep(nestPath, "drill", r));
    input.current?.focus();
  };
  const goBack = () => {
    const key = nestPath[nestPath.length - 1];
    const parent = nestPath.slice(0, -1);
    wantActive.current = nestRoot ? Math.max(0, nestRows(nestRoot, parent, "").findIndex((r) => r.trail[r.trail.length - 1] === key)) : 0;
    setNestPath(parent);
    input.current?.focus();
  };
  const trigRows = useMemo((): (PickerItem & { pick: string; urn?: string; kind?: string })[] => {
    if (!trig) return [];
    const q = trig.range.query;
    if (trig.kind === "command") return rankCommands(COMMANDS, q).slice(0, 30).map((c) => ({ key: c.name, label: "/" + c.name, sub: c.description, pick: c.name }));
    return nestList.map((r, i): PickerItem & { pick: string; urn?: string; kind?: string } => {
      const sealed = typeof r.sealed === "number" ? sealedChip({ sealed: r.sealed }) : null;
      const family = typeof r.family === "string" ? r.family : "";
      const above = r.path && r.path.includes(" › ") ? r.path.slice(0, r.path.lastIndexOf(" › ")) : undefined;
      return {
        key: r.key, label: r.label, group: r.group, sub: above ?? (typeof r.sub === "string" ? r.sub : undefined),
        leading: family ? <Face name={r.label} family={family as "person" | "assistant"} size={24} /> : <Icon name={nestIcon(r)} size={18} />,
        trailing: <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>{sealed ? <Chip tone="sealed" icon="shield">{sealed}</Chip> : null}{r.drill ? <Pressable accessibilityRole="button" accessibilityLabel={`Open ${r.label}`} onPress={() => drillRow(i)} {...(web ? ({ onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() } as object) : {})} style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}><Icon name="chev-r" size={16} tone="label" /></Pressable> : null}</View>,
        pick: r.pick?.pick ?? r.label, urn: r.pick?.urn, kind: r.pick?.kind,
      };
    });
  }, [trig, nestList]);

  const shownMenu = useMemo(() => (pop ? (filterItems(menuRows, menuQ) as Row[]) : []), [pop, menuRows, menuQ]);
  const rows: PickerItem[] = pop ? shownMenu : trigRows;
  const query = pop ? menuQ : trig?.range.query ?? "";
  const open = rows.length > 0 || !!pop || (!!nestRoot && nestPath.length > 0);
  useEffect(() => { const a = wantActive.current; wantActive.current = null; setActive(a ?? 0); }, [trig?.kind, trig?.range.query, menuQ, pop, nestPath]);

  const choose = (o: { pick: string; urn?: string; kind?: string }) => {
    if (!trig) return;
    if (trig.kind === "command" && p.onLocalCommand?.(o.pick)) { setText(""); setCaret(0); input.current?.focus(); return; }
    if (trig.kind !== "command" && trig.kind !== "person" && o.urn) picked.current.set(o.pick, { kind: o.kind ?? "record", id: o.urn, name: o.pick });
    const r = pick(text, trig, o.pick);
    setText(r.text);
    setCaret(r.caret);
    input.current?.focus();
  };
  const pickRow = (i: number) => {
    if (pop) { shownMenu[i]?.run(); return; }
    const r = nestList[i];
    // A level with nothing to choose (Projects, Records) opens; everything else writes its token.
    if (nestRoot) { if (r?.pick) choose(trigRows[i]); else drillRow(i); return; }
    if (trigRows[i]) choose(trigRows[i]);
  };

  const send = useCallback((over?: "steer" | "queue") => {
    const t = text.trim();
    if (!t && !files) return;
    const typed = /^\/(\w+)\s*$/.exec(t);
    if (typed && !files && p.onLocalCommand?.(typed[1])) { setText(""); setCaret(0); return; }
    const people = p.people ?? [];
    // A chosen set of AIs goes by name; Everyone is all the chat's assistants. Anything @mentioned still adds its own.
    const chosen = answering.length ? slots.filter((s) => answering.includes(s.id)).map((s) => people.find((x) => x.family === "assistant" && x.name.toLowerCase() === s.label.toLowerCase())?.name ?? s.label) : [];
    const everyone = answering.length > 1 && answering.length === allIds.length;
    const base = sendTargets({ text: t, askAll: everyone, people });
    const to = answering.length && !everyone ? [...new Set([...chosen, ...base.to])] : base.to;
    const target = { to, fanout: to.length > 1 };
    const mentions = mentionsIn(t, picked.current) as PickedMention[];
    if (target.to.length || mentions.length || working) p.onSend(t, { ...target, ...(mentions.length ? { mentions } : {}), ...(working ? { mode: over ?? mode } : {}) }); else p.onSend(t);
    picked.current.clear();
    setText("");
    setCaret(0);
    setAnswering([]);
  }, [text, p, answering, allIds, slots, mode, files, working]);

  const onSel = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => setCaret(e.nativeEvent.selection.end);
  // The words that count as a token: the people, and what was picked from a list (a whole object, a file, a tag). Typed names that were never picked tag nothing.
  const names = useMemo(() => [...(p.people ?? []).map((x) => x.name), ...picked.current.keys()], [p.people, text]); // eslint-disable-line react-hooks/exhaustive-deps
  const toks = useMemo(() => tokensIn(text, names), [text, names]);

  const onKey = (e: any) => {
    if (p.phone) return;
    const ev = e.nativeEvent as KeyboardEvent & { key: string };
    const stop = () => { e.preventDefault?.(); e.stopPropagation?.(); };
    const sc = composerShortcut(ev);
    if (sc === "answering") { stop(); openPop("answering"); return; }
    if (sc === "attach") { stop(); if (p.vyreFiles && p.onAttachVyreFile) openPop("files"); else p.onAttachFile?.(); return; }
    if (sc && sc.startsWith("ai:") && slots.length) {
      stop();
      if (sc === "ai:all") askEveryone(); else { const sl = slots[Number(sc.slice(3))]; if (sl) toggleAi(sl.id); }
      return;
    }
    if (open && !pop && nestRoot) {
      // The @ and # lists nest: Right or Tab opens, Left or Backspace on nothing typed goes back, Enter picks.
      const act = nestKey(ev, { query, count: rows.length, depth: nestPath.length, row: nestList[active] });
      if (act === "next" || act === "prev") { stop(); setActive((a) => moveActive(a, act === "next" ? 1 : -1, rows.length)); return; }
      if (act === "pick") { stop(); pickRow(active); return; }
      if (act === "drill") { stop(); drillRow(active); return; }
      if (act === "back") { stop(); goBack(); return; }
      if (act === "close") {
        if (ev.key === "Escape" && trig) { stop(); setDismissed(trig.range.start); }
        return; // Backspace at the top on an empty query goes on to delete the trigger character.
      }
    } else if (open) {
      const act = pickerKey(ev, { query, count: rows.length });
      if (act === "next" || act === "prev") { stop(); setActive((a) => moveActive(a, act === "next" ? 1 : -1, rows.length)); return; }
      if (act === "pick") { stop(); pickRow(active); return; }
      if (act === "close") {
        if (pop) { stop(); if (pop === "model") { setPop("answering"); setActive(0); } else if (pop === "vyrefiles") { setPop("files"); setMenuQ(""); setActive(0); } else closePop(); return; }
        if (ev.key === "Escape" && trig) { stop(); setDismissed(trig.range.start); }
        return; // Backspace on an empty query goes on to delete the trigger character.
      }
      if (pop) {
        if (ev.key === "ArrowRight" && pop === "answering") { const r = shownMenu[active]; if (r?.group === "Model") { stop(); r.run(); } return; }
        if (ev.key === "ArrowRight" && pop === "files") { const r = shownMenu[active]; if (r?.key === "vyre") { stop(); r.run(); } return; }
        if (ev.key === "ArrowLeft" && pop === "model") { stop(); setPop("answering"); setActive(0); return; }
        if (ev.key === "ArrowLeft" && pop === "vyrefiles") { stop(); setPop("files"); setActive(0); return; }
        if (ev.key === "Backspace") { stop(); setMenuQ((q) => q.slice(0, -1)); return; }
        if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey && !ev.altKey) { stop(); setMenuQ((q) => q + ev.key); return; }
        return;
      }
    }
    if (ev.key === "Backspace" && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      const el = (e.target ?? null) as HTMLTextAreaElement | null;
      if (el && el.selectionStart === el.selectionEnd) {
        const r = deleteTokenBack(text, el.selectionStart ?? caret, names);
        if (r) { stop(); setText(r.text); setCaret(r.caret); return; }
      }
    }
    if (ev.key === "Enter" && !ev.shiftKey && !rows.length) { stop(); send(ev.altKey ? "queue" : ev.metaKey || ev.ctrlKey ? "steer" : undefined); }
  };

  const activeId = open && rows.length ? optionId(POP_ID, active) : undefined;
  const aria = web ? ({ role: "combobox", "aria-haspopup": "listbox", "aria-expanded": open, "aria-controls": open ? POP_ID : undefined, "aria-activedescendant": activeId, "aria-autocomplete": "list" } as object) : {};
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
        {...aria}
        placeholder={answering.length > 1 ? (p.phone ? "Ask everyone chosen" : "Ask the AIs you chose at once") : intent.queue || p.state === "working" ? (p.phone ? "Say more (it queues)" : "Say more. It queues until the next step.") : (p.phone ? "Message" : "Message, or / for commands")}
        placeholderTextColor={color.label}
        accessibilityLabel="Message"
        onKeyPress={onKey}
        style={{ color: color.text, fontSize: 16, lineHeight: 24, minHeight: expanded && p.phone ? 72 : !expanded && p.phone ? T : 24, ...(!expanded && p.phone ? { height: T } : {}), maxHeight: 160, paddingLeft: expanded ? 6 : 0, paddingRight: expanded ? 6 : 0, paddingVertical: expanded ? 4 : 10, flex: expanded ? undefined : 1, minWidth: 0, outlineStyle: "none" } as any}
      />
  );

  const sendBtn = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={intent.queue ? "Queue message" : "Send"}
      onPress={() => send()}
      style={{ width: ctl, height: ctl, borderRadius: ctl / 2, backgroundColor: intent.send ? color.primary : "transparent", alignItems: "center", justifyContent: "center" }}
    >
      <Icon name="send" size={20} tone={intent.send ? "primary-ink" : "label"} />
    </Pressable>
  );

  // State that differs from the default, as chips that can be taken off: where it runs, queued, a file's problem is its own line.
  const stateChips = (
    <>
      {working && mode === "queue" ? <ChipToken icon="clock" label="Queued for the end of the turn" onRemove={() => setMode("steer")} removeLabel="Send now instead" /> : null}
      {p.runsOn && p.runsOn !== (p.runsOnDefault ?? "server") ? <ChipToken icon={p.runsOn === "mac" ? "laptop" : "box"} label={p.runsOn === "mac" ? "Runs on this Mac" : "Runs on the server"} onPress={p.onRunsOn} /> : null}
    </>
  );
  const hasState = (working && mode === "queue") || (!!p.runsOn && p.runsOn !== (p.runsOnDefault ?? "server"));

  // A nested list says where it is: "Tag › Records › Clients". The footer names only the keys that work on the row under the cursor.
  const nested = !pop && !!nestRoot;
  const crumbs = nested && nestPath.length ? [trig?.kind === "person" ? "Mention" : "Tag", ...crumbsOf(nestRoot, nestPath)] : undefined;
  const nestFooter = nested ? nestHint(nestPath.length, nestList[active]) : null;
  const footer = pop === "files" ? "Right opens Vyre Files. Drop or paste works too" : pop === "vyrefiles" ? "Type to search. Left goes back" : pop === "plus" ? "Type to filter. Up and Down, Enter, Esc" : pop === "answering" ? (pm ? "AI answers only when you @mention it. Change it in chat settings." : "Applies to the next message. Right opens a model") : pop === "model" ? "Left goes back" : nestFooter ?? (trig?.kind === "command" ? "@ who · # what · Up and Down, Enter, Esc" : "@ people and AIs · # records · / commands · Esc");
  const header = pop === "files" || pop === "vyrefiles" ? "Files" : pop === "answering" ? "Answering" : pop === "model" ? "Model" : trig?.kind === "command" ? "Commands" : trig?.kind === "person" ? "Mention" : trig?.kind === "record" ? "Tag" : undefined;
  const aiMenu = pm || slots.length > 1 || !!p.models?.length;

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
      {open ? (
        <View style={{ marginBottom: 6 }}>
          <PickerList id={POP_ID} label={header ?? "Suggestions"} header={header} crumbs={crumbs} onCrumb={(i) => { if (i < nestPath.length) setNestPath(nestPath.slice(0, i)); }} items={rows} active={active} onActive={setActive} onPick={pickRow} footer={footer} maxRows={pop ? 9 : 6} />
        </View>
      ) : null}
      <View style={{ backgroundColor: color["surface-2"], borderWidth: 1, borderColor: focused ? color["edge-strong"] : color.edge, borderRadius: expanded && p.phone ? 22 : 18, padding: p.phone ? 6 : 10, gap: 4 }}>
        {p.attachments?.length || toks.length || hasState ? (
          <View accessibilityLabel="Files and tags for this message" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            {p.attachments?.map((a) => (a.thumb ? (
              <Thumb key={a.key} uri={a.thumb} name={a.name} state={a.state} onRemove={() => p.onRemoveAttachment?.(a.key)} />
            ) : (
              <Pressable key={a.key} accessibilityRole="button" accessibilityLabel={`${a.name}, ${a.line}. Remove`} onPress={() => p.onRemoveAttachment?.(a.key)} style={{ minHeight: big ? T : 32, justifyContent: "center" }}>
                <Chip tone={a.state === "failed" ? "err" : "plain"} icon={a.state === "failed" ? "failed" : fileIcon(a.name)}>{a.state === "failed" ? `${a.name} · not added` : `${a.name} · ${a.line}`}</Chip>
              </Pressable>
            )))}
            {toks.map((t) => <ChipToken key={t.lead + t.name} icon={tokenIcon(t.lead, picked.current.get(t.name)?.kind)} label={t.name} tone="plain" onRemove={() => { setText(removeToken(text, t.lead, t.name)); input.current?.focus(); }} />)}
            {stateChips}
          </View>
        ) : null}
        {p.attachProblem ? <Text size="caption" tone="warn">{p.attachProblem}</Text> : null}
        {!expanded ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Tool big={big} icon="clip" label="Files" onPress={() => (p.vyreFiles && p.onAttachVyreFile ? openPop("files") : p.onAttachFile?.())} />
            {field}
            {sendBtn}
          </View>
        ) : field}
        {expanded ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Tip label="Files" hint="Cmd U" side="top"><Tool big={big} icon="clip" label="Files: from Vyre Files or your computer" onPress={() => (p.vyreFiles && p.onAttachVyreFile ? openPop("files") : p.onAttachFile?.())} /></Tip>
            <Tip label="Mention, tag, where it runs" hint="@ # /" side="top"><Tool big={big} icon="plus" label="More: mention, tag, where it runs" onPress={() => openPop("plus")} /></Tip>
            {aiMenu ? <Tip label="Who answers" hint="Cmd /" side="top"><AnsweringControl people={pm && !ais.length} ais={pm && !ais.length ? [] : ais.length ? ais : [{ id: "m", label: summary }]} summary={summary} open={pop === "answering" || pop === "model"} hint="Cmd /" onPress={() => openPop("answering")} /></Tip> : null}
            <View style={{ flex: 1, minWidth: 8 }} />
            {sendBtn}
          </View>
        ) : null}
      </View>
    </View>
  );
}
