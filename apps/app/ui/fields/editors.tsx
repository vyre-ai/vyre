import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Text } from "../components/Text";
import { Chip } from "../components/Chip";
import { DateTimeField } from "../components/DateTimeField";
import { Field } from "../components/Field";
import { Button } from "../components/Button";
import { Select } from "../components/Select";
import { actorIdOf, allowedStages, currencySymbol, isEmpty, isoDay, listOf, parseNum, urnOf } from "./logic.js";
import { TagRow } from "../components/TagRow";
import { tagsOf, withTag, withoutTag } from "../tags/model.js";
import type { EditProps } from "./types";

const NONE = "";
const str = (v: any) => String(v ?? "");

export function TextEdit({ p, emit }: EditProps) {
  const [t, setT] = useState(str(typeof p.value === "object" && p.value ? p.value.name ?? p.value.title : p.value));
  return <Field value={t} onChangeText={(s) => { setT(s); emit(s); }} name={p.definition.label} />;
}

export function RichTextEdit({ p, emit }: EditProps) {
  const [t, setT] = useState(str(p.value));
  return <Field multiline value={t} onChangeText={(s) => { setT(s); emit(s); }} help="Use **bold** and *italic*." name={p.definition.label} />;
}

export function NumberEdit({ p, emit }: EditProps) {
  const [t, setT] = useState(isEmpty(p.value) ? "" : str(p.value));
  return <Field kind="number" value={t} onChangeText={(s) => { setT(s); emit(parseNum(s)); }} name={p.definition.label} />;
}

/** The currency belongs to the field, not the screen: it is kept from the held value (USD when there is none). */
export function MoneyEdit({ p, emit }: EditProps) {
  const cur = p.value?.currency || "USD";
  const [t, setT] = useState(isEmpty(p.value) ? "" : str(p.value.amount));
  return (
    <View className="flex-row items-center gap-s2">
      <Text tone="muted">{currencySymbol(cur)}</Text>
      <Field className="flex-1" kind="number" value={t} onChangeText={(s) => { setT(s); const n = parseNum(s); emit(n === null ? null : { amount: n, currency: cur }); }} name={p.definition.label} />
    </View>
  );
}

export function BooleanEdit({ p, emit }: EditProps) {
  const [on, setOn] = useState(p.value === true);
  return (
    <View className="flex-row gap-s2">
      {[[true, "Yes"], [false, "No"]].map(([v, l]) => (
        <Pressable key={String(l)} accessibilityRole="radio" accessibilityState={{ selected: on === v }} onPress={() => { setOn(v as boolean); emit(v); }}>
          <Chip tone={on === v ? "selected" : "plain"}>{l as string}</Chip>
        </Pressable>
      ))}
    </View>
  );
}

/** A day, picked (the browser's calendar on the web) or typed as 2026-10-28: the value saves only when it is a real date. The one date input of the app (components/DateTimeField). */
export function DateEdit({ p, emit }: EditProps) {
  return <DateTimeField dateOnly name={p.definition.label} value={isoDay(p.value)} onChange={(day) => emit(day)} />;
}

/** A day and a time of day, in the viewer's zone, saved as the moment they name. */
export function DateTimeEdit({ p, emit }: EditProps) {
  return <DateTimeField name={p.definition.label} value={typeof p.value === "string" ? p.value : ""} onChange={(iso) => emit(iso)} />;
}

export function ChoiceEdit({ p, emit }: EditProps) {
  const [v, setV] = useState(str(p.value));
  const opts: [string, string][] = [[NONE, "None"], ...((p.definition.options || []).map((o) => [o, o]) as [string, string][])];
  return <Select label={p.definition.label} value={v} options={opts} placeholder="None" onChange={(x) => { setV(x); emit(x || null); }} />;
}

export function MultiChoiceEdit({ p, emit }: EditProps) {
  const [on, setOn] = useState<string[]>(listOf(p.value));
  const flip = (o: string) => { const next = on.includes(o) ? on.filter((x) => x !== o) : [...on, o]; setOn(next); emit(next); };
  return (
    <View accessibilityRole="menu" className="flex-row flex-wrap gap-s1">
      {(p.definition.options || []).map((o) => (
        <Pressable key={o} accessibilityRole="checkbox" accessibilityState={{ checked: on.includes(o) }} onPress={() => flip(o)}><Chip tone={on.includes(o) ? "selected" : "plain"}>{o}</Chip></Pressable>
      ))}
    </View>
  );
}

/** The menu offers the stage it is in and its neighbours; the gateway's rule for a move runs before the change (env.allowed replaces the default). */
export function StageEdit({ p, env, emit }: EditProps) {
  const cur = str(p.value);
  const allowed = allowedStages(p.definition, cur, env.allowed);
  const [v, setV] = useState(cur || allowed[0] || "");
  return <Select label={p.definition.label} value={v} options={allowed.map((s) => [s, s])} onChange={(x) => { setV(x); emit(x); }} />;
}

export function ActorEdit({ p, env, emit }: EditProps) {
  const actors = env.actors || [];
  const [v, setV] = useState(actorIdOf(p.value));
  const kernelKind = (f: string) => (f === "person" ? "person" : f === "service" ? "service" : "agent");
  const space = env.space || p.value?.actor?.space || "";
  const opts: [string, string][] = [[NONE, "None"], ...actors.map((a) => [a.id, a.name + (a.family === "person" ? "" : a.family === "service" ? " (service)" : " (agent)")] as [string, string])];
  return (
    <Select label={p.definition.label} value={v} options={opts} placeholder="None" onChange={(x) => {
      setV(x);
      const a = actors.find((y) => y.id === x);
      emit(a ? { actor: { kind: kernelKind(a.family), id: a.id, space } } : null);
    }} />
  );
}

/** A record picker over the targets the screen knows (env.links), narrowed to the field's target type. */
export function LinkEdit({ p, env, emit }: EditProps) {
  const cur = urnOf(p.value), to = p.definition.to;
  const [v, setV] = useState(cur);
  const known = Object.entries(env.links || {}).filter(([, t]) => !to || !t.type || t.type === to).map(([urn, t]) => [urn, t.title] as [string, string]);
  if (cur && !known.some(([u]) => u === cur)) known.push([cur, env.links?.[cur]?.title || cur.split("/").pop() || cur]);
  return <Select label={p.definition.label} value={v} options={[[NONE, "None"], ...known]} placeholder="None" onChange={(x) => { setV(x); emit(x ? { urn: x } : null); }} />;
}

/** Web opens the system file picker; the native build has no picker bundled yet, so it takes the file's name. */
export function FileEdit({ p, emit }: EditProps) {
  const [cur, setCur] = useState<any>(isEmpty(p.value) ? null : p.value);
  const [typed, setTyped] = useState("");
  const pick = () => {
    const doc: any = (globalThis as any).document;
    if (!doc) return;
    const input = doc.createElement("input");
    input.type = "file";
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) { const v = { file: `local:${f.name}`, name: f.name, bytes: f.size }; setCur(v); emit(v); }
    };
    input.click();
  };
  if (Platform.OS !== "web") {
    return <Field value={typed} placeholder="File name" onChangeText={(s) => { setTyped(s); emit(s.trim() ? { file: `local:${s.trim()}`, name: s.trim(), bytes: 0 } : null); }} name={p.definition.label} />;
  }
  return (
    <View className="flex-row flex-wrap items-center gap-s2">
      <Button size="sm" icon="file" label="Attach a file" onPress={pick} />
      <Text tone={cur ? "default" : "faint"}>{cur?.name || "No file"}</Text>
    </View>
  );
}

const PARTS: [string, string][] = [["line1", "Street"], ["line2", "Apartment or suite"], ["city", "City"], ["region", "State or region"], ["postal", "Postal code"], ["country", "Country"]];
export function AddressEdit({ p, emit }: EditProps) {
  const [a, setA] = useState<Record<string, string>>(p.value && typeof p.value === "object" ? { ...p.value } : {});
  const set = (k: string, s: string) => {
    const next = { ...a, [k]: s }; setA(next);
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(next)) if (val.trim()) out[key] = val.trim();
    emit(Object.keys(out).length ? out : null);
  };
  return <View className="gap-s2">{PARTS.map(([k, l]) => <Field key={k} label={l} value={a[k] ?? ""} onChangeText={(s) => set(k, s)} />)}</View>;
}

/** phones, emails, urls: a list of strings, one input each. */
function ListEdit({ p, emit, kind, noun }: EditProps & { kind: "phone" | "email" | "url"; noun: string }) {
  const [vals, setVals] = useState<string[]>(listOf(p.value).length ? listOf(p.value) : [""]);
  const set = (next: string[]) => { setVals(next); emit(next.map((s) => s.trim()).filter(Boolean)); };
  return (
    <View className="gap-s2">
      {vals.map((v, i) => <Field key={i} kind={kind} mono={kind === "phone"} label={vals.length > 1 ? `${p.definition.label} ${i + 1}` : undefined} value={v} onChangeText={(s) => set(vals.map((x, j) => (j === i ? s : x)))} name={`${p.definition.label} ${i + 1}`} />)}
      <Button size="sm" kind="ghost" icon="plus" label={`Add another ${noun}`} onPress={() => setVals([...vals, ""])} />
    </View>
  );
}
export const PhoneEdit = (props: EditProps) => <ListEdit {...props} kind="phone" noun="number" />;
export const EmailEdit = (props: EditProps) => <ListEdit {...props} kind="email" noun="address" />;
export const UrlEdit = (props: EditProps) => <ListEdit {...props} kind="url" noun="address" />;

/** Five marks; tapping the one that is on turns it off. */
export function RatingEdit({ p, emit }: EditProps) {
  const [n, setN] = useState(Number(p.value) || 0);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={p.definition.label} className="flex-row">
      {[1, 2, 3, 4, 5].map((i) => (
        <Pressable key={i} accessibilityRole="radio" accessibilityLabel={`${i} of 5`} accessibilityState={{ selected: i <= n }} hitSlop={4}
          onPress={() => { const next = n === i ? 0 : i; setN(next); emit(next || null); }} className="h-control-sm w-control-sm items-center justify-center">
          <Text size="title" tone={i <= n ? "default" : "faint"}>{"★"}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** The free tags of a record: chips to take off and a field to add one, offering the Space's tags. It emits the stored text, so the record page's Save writes what lib/tags.js writes. */
export function TagsEdit({ p, env, emit }: EditProps) {
  const [text, setText] = useState<string>(typeof p.value === "string" ? p.value : "");
  const set = (next: string) => { setText(next); emit(next); };
  return <TagRow tags={tagsOf(text)} known={env.tags} onAdd={(t) => set(withTag(text, t))} onRemove={(t) => set(withoutTag(text, t))} />;
}
