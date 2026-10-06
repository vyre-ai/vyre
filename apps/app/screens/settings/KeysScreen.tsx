// All settings: every key the box lists, one control each, saved as you change it (the Deck's settings-keys.js, ported; account level).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Segmented, Select, Switch, Text, showToast } from "@vyre/ui";
import { Page, Sec } from "../places/Frame";
import { keys } from "./keys";
import { APPLY, canReset, choicesOf, controlOf, numberInput, refusal, sourceLine, valueLine, visible, type KeyDef, type KeyValue, type Schema } from "./keys-model.ts";

export function KeysScreen() {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [values, setValues] = useState<Map<string, KeyValue> | null>(null);
  const [err, setErr] = useState("");
  const [find, setFind] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const load = useCallback(() => { setErr(""); Promise.all([keys.schema(), keys.values()]).then(([s, v]) => { setSchema(s); setValues(v); }).catch((e) => setErr(refusal(e))); }, []);
  useEffect(load, [load]);
  const put = (v: KeyValue) => setValues((m) => new Map(m).set(v.key, v));
  const groups = schema ? visible(schema, find, advanced) : [];
  return (
    <Page title="All settings" back="/u/settings">
      <Banner>Every setting Vyre keeps for you. A change is saved at once and applies the way its line says.</Banner>
      <Field name="Find a setting" value={find} onChangeText={setFind} placeholder="Find a setting" />
      <View className="flex-row"><Button size="sm" kind="ghost" label={advanced ? "Hide advanced" : "Show advanced"} onPress={() => setAdvanced(!advanced)} /></View>
      {err ? <Card flush><ErrorState title="Settings did not load" reason={err} retry={load} /></Card> : null}
      {!schema && !err ? <LoadingState rows={4} /> : null}
      {schema && !groups.length ? <Card><EmptyState title={find ? `No setting matches "${find.trim()}"` : "No settings here"} body="" /></Card> : null}
      {groups.map(({ group, keys: ks }) => (
        <Sec key={group.id} title={group.label}>
          <Card flush>{ks.map((k, i) => <View key={k.key}>{i ? <Divider /> : null}<KeyRow def={k} value={values?.get(k.key)} onValue={put} /></View>)}</Card>
        </Sec>
      ))}
    </Page>
  );
}

function KeyRow({ def, value, onValue }: { def: KeyDef; value?: KeyValue; onValue: (v: KeyValue) => void }) {
  const [typed, setTyped] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ value: unknown } | null>(null);
  const kind = controlOf(def);
  const off = value?.available === false;
  const hint = APPLY[def.apply || "live"];
  const current = value && value.value !== undefined ? value.value : def.default;
  const save = (v: unknown) => {
    setBusy(true); setProblem("");
    keys.set(def.key, v).then((r) => { onValue(r && r.key === def.key ? r : { ...(value || { key: def.key }), value: v, account: v, source: "account" }); setTyped(null); }).catch((e) => setProblem(`Not saved. ${refusal(e)}`)).finally(() => setBusy(false));
  };
  const reset = () => {
    const before = value?.account;
    setBusy(true); setProblem("");
    keys.reset(def.key).then((r) => { onValue(r && r.key === def.key ? r : { key: def.key, value: def.default }); setTyped(null); setUndo({ value: before }); setTimeout(() => setUndo(null), 4000); showToast("Back to the default."); }).catch((e) => setProblem(`Not reset. ${refusal(e)}`)).finally(() => setBusy(false));
  };
  const typedSave = () => {
    if (kind === "number") { const n = numberInput(def, typed ?? ""); if ("problem" in n) { setProblem(n.problem); return; } save(n.value); } else save((typed ?? "").trim());
  };
  const sub = [def.help, hint, value?.problem, off ? "Its module is off." : ""].filter(Boolean).join(" ");
  const chip = sourceLine(value);
  return (
    <View className="gap-s2 p-s3">
      {kind === "switch" ? (
        <Row title={def.label} sub={sub} end={<Switch label={def.label} on={current === true} disabled={off || busy} onChange={save} />} />
      ) : (
        <>
          <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{def.label}</Text>{chip ? <Chip>{chip}</Chip> : null}</View>
          {sub ? <Text size="caption" tone="label">{sub}</Text> : null}
          {kind === "segment" ? <Segmented label={def.label} value={String(current ?? "")} options={choicesOf(def)} onChange={(v) => save(def.type === "enum" ? v : Number(v))} /> : null}
          {kind === "select" ? <Select label={def.label} value={String(current ?? "")} options={choicesOf(def)} onChange={save} disabled={off || busy} /> : null}
          {kind === "number" || kind === "text" ? (
            <View className="gap-s2">
              <Field name={def.label} kind={kind === "number" ? "number" : "text"} value={typed ?? (current == null ? "" : String(current))} onChangeText={setTyped} disabled={off || busy} />
              {typed !== null ? <View className="flex-row"><Button size="sm" label="Save" disabled={busy} onPress={typedSave} /></View> : null}
            </View>
          ) : null}
          {kind === "readonly" ? <Text tone="muted">{valueLine(def, current)}</Text> : null}
        </>
      )}
      {def.type === "bool" && chip ? <Chip>{chip}</Chip> : null}
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
      <View className="flex-row gap-s2">
        {canReset(value) && !off ? <Button size="sm" kind="ghost" label="Reset to default" disabled={busy} onPress={reset} /> : null}
        {undo && undo.value !== undefined ? <Button size="sm" kind="ghost" label="Undo" onPress={() => { const v = undo.value; setUndo(null); save(v); }} /> : null}
      </View>
    </View>
  );
}
