// Any app with an API. The person picks a key already saved in the Vault, says where the app lives and how it wants the key, adds a check request, and saves: Vyre checks it and shows a light.
// The key is never typed here and never shown; the form only names the Vault item that holds it. A connection that works can be used by agents, Flows (Call a service) and watchers.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Segmented, Sheet, Text, showToast } from "@vyre/ui";
import { connections } from "./source-real";
import { words } from "./model";
import { emptyForm, formProblem, lightWords, SEND_HOWS, type FormInput, type MadeConnection } from "./any-app";
import { ItemPick } from "./shared";

const dot = (light: MadeConnection["light"]) => (light === "green" ? "Green" : light === "red" ? "Red" : light === "out_of_step" ? "Amber" : "Grey");

export default function RealAnyApp() {
  const [list, setList] = useState<MadeConnection[] | null>(null);
  const [problem, setProblem] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => { connections.madeList().then((x) => { setList(x); setProblem(""); }).catch((e) => setProblem(words(e))); }, []);
  useEffect(load, [load]);
  if (problem && !list) return <ErrorState title="Your connections did not load" reason={problem} retry={load} />;
  if (!list) return <LoadingState rows={2} />;
  const check = (id: string) => { setBusy(id); connections.madeCheck(id).then(load).catch((e) => showToast(words(e))).finally(() => setBusy("")); };
  return (
    <View className="gap-s3 pt-s2">
      <Text tone="muted" size="secondary">Connect any app that has an API, from a key you already saved in the Vault. Agents, Flows and watchers can then use it.</Text>
      {list.length ? (
        <Card flush>
          {list.map((c, i) => (
            <View key={c.id}>{i ? <Divider /> : null}
              <Row title={<View className="flex-row items-center gap-s2"><Text strong>{c.label}</Text><Text tone="muted" mono size="caption">{c.host}</Text></View>}
                sub={confirm === c.id ? (
                  <View className="gap-s2 pt-s1">
                    <Text size="secondary">{`Remove ${c.label}? This removes Vyre's connection. The key in the Vault stays.`}</Text>
                    <View className="flex-row gap-s2">
                      <Button size="sm" label="Remove" onPress={() => connections.madeDelete(c.id).then(() => { setConfirm(""); load(); }).catch((e) => showToast(words(e)))} />
                      <Button size="sm" kind="ghost" label="Keep" onPress={() => setConfirm("")} />
                    </View>
                  </View>
                ) : (
                  <View className="gap-s1 pt-s1">
                    <Text size="secondary" tone={c.light === "green" ? undefined : "muted"}>{`${dot(c.light)}: ${lightWords(c)}`}</Text>
                    {c.operations.length ? <Text size="caption" tone="muted">{c.operations.map((o) => o.name).join(", ")}</Text> : null}
                    <View className="flex-row gap-s2">
                      <Button size="sm" kind="ghost" label={busy === c.id ? "Checking" : "Check now"} disabled={busy === c.id} onPress={() => check(c.id)} />
                      <Button size="sm" kind="ghost" label="Remove" onPress={() => setConfirm(c.id)} />
                    </View>
                  </View>
                )} />
            </View>
          ))}
        </Card>
      ) : <Card><EmptyState title="No app connected yet" body="Save the app's key in the Vault first, then connect it here." /></Card>}
      <View className="self-start"><Button kind={list.length ? "ghost" : "primary"} size="sm" icon="plus" label="Connect an app" onPress={() => setAdding(true)} /></View>
      <AddApp open={adding} onClose={() => setAdding(false)} onDone={load} />
    </View>
  );
}

function AddApp({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<FormInput>(emptyForm());
  const [items, setItems] = useState<{ name: string }[] | null>(null);
  const [problem, setProblem] = useState("");
  const [result, setResult] = useState<{ light: string; words: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setF(emptyForm()); setProblem(""); setResult(null); setItems(null);
    connections.vaultItems().then((l) => setItems(l.filter((i) => i.kind !== "api-credential"))).catch(() => setItems([]));
  }, [open]);
  const set = <K extends keyof FormInput>(k: K, v: FormInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const row = (k: "headers" | "vars", i: number, part: "name" | "value", v: string) => setF((x) => ({ ...x, [k]: x[k].map((r, j) => (j === i ? { ...r, [part]: v } : r)) }));
  const save = () => {
    const p = formProblem(f);
    if (p) { setProblem(p); return; }
    setBusy(true); setProblem("");
    connections.madeCreate(f).then((r) => { setResult(r); onDone(); }).catch((e) => setProblem(words(e))).finally(() => setBusy(false));
  };
  const how = SEND_HOWS.find((h) => h.value === f.how);
  return (
    <Sheet open={open} onClose={onClose} title="Connect an app">
      {result ? (
        <View className="gap-s3">
          <Banner tone={result.light === "green" ? "ok" : "warn"}><Text>{result.light === "green" ? "Connected. The check worked." : `Saved, but the check says: ${result.words}.`}</Text></Banner>
          <Text size="secondary" tone="muted">{result.light === "green" ? "Agents, Flows and watchers can use it now." : "Fix the key or the details and connect again, or check later from the list."}</Text>
          <View className="self-start"><Button kind="primary" label="Done" onPress={onClose} /></View>
        </View>
      ) : (
        <View className="gap-s3">
          <Field label="Name" value={f.label} onChangeText={(v) => set("label", v)} placeholder="GoHighLevel Sales" />
          <Field label="App address" value={f.baseUrl} onChangeText={(v) => set("baseUrl", v)} placeholder="https://services.leadconnectorhq.com" help="The API's own address, no path." />
          <Text size="caption" strong tone="label">How the app wants the key</Text>
          <Segmented label="How the key is sent" value={f.how} onChange={(v) => set("how", v)} options={SEND_HOWS.map((h) => [h.value, h.label])} />
          <Text size="caption" tone="label">{how?.help}</Text>
          {f.how === "header" || f.how === "query" ? <Field label={f.how === "header" ? "Header name" : "Parameter name"} value={f.name} onChangeText={(v) => set("name", v)} /> : null}
          <Text size="caption" strong tone="label">The key in your Vault</Text>
          {items === null ? <LoadingState rows={1} /> : <ItemPick items={items} value={f.item} onChange={(v) => set("item", v)} empty="Nothing in the Vault yet. Save the app's key there first." />}
          <Text size="caption" strong tone="label">Fixed headers (optional)</Text>
          {f.headers.map((h, i) => (
            <View key={i} className="flex-row gap-s2"><View className="flex-1"><Field label="Name" value={h.name} onChangeText={(v) => row("headers", i, "name", v)} placeholder="Version" /></View><View className="flex-1"><Field label="Value" value={h.value} onChangeText={(v) => row("headers", i, "value", v)} placeholder="2021-07-28" /></View></View>
          ))}
          <View className="self-start"><Button size="sm" kind="ghost" label="Add a header" onPress={() => setF((x) => ({ ...x, headers: [...x.headers, { name: "", value: "" }] }))} /></View>
          <Text size="caption" strong tone="label">Fixed values (optional)</Text>
          {f.vars.map((v, i) => (
            <View key={i} className="flex-row gap-s2"><View className="flex-1"><Field label="Name" value={v.name} onChangeText={(x) => row("vars", i, "name", x)} placeholder="locationId" /></View><View className="flex-1"><Field label="Value" value={v.value} onChangeText={(x) => row("vars", i, "value", x)} /></View></View>
          ))}
          <View className="self-start"><Button size="sm" kind="ghost" label="Add a value" onPress={() => setF((x) => ({ ...x, vars: [...x.vars, { name: "", value: "" }] }))} /></View>
          <Field label="Check request" value={f.checkPath} onChangeText={(v) => set("checkPath", v)} placeholder="/locations/{locationId}" help="One GET that proves the key works. {name} is filled from Fixed values." />
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <Button kind="primary" label={busy ? "Connecting" : "Save and check"} disabled={busy} onPress={save} />
        </View>
      )}
    </Sheet>
  );
}
