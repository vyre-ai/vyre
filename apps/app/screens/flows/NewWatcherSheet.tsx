import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Field, Row, Select, Sheet, Text } from "@vyre/ui";
import { cardRows, presetInput, PRESETS, testLines } from "./watchers-model.js";
import { watchersSource } from "./watchers-source";

const say = (e: unknown) => (e instanceof Error && e.message ? e.message : "That did not go through.");

/**
 * A new watcher in four steps, each one a button: pick where it watches and fill in a few fields (watchers.preset writes it, off), Test it (watchers.test, nothing is filed), read its card, then Turn on
 * (watchers.create with the card's hash). "A webhook" is not a watcher source: it opens the route page instead (`onWebhook`). Used by the Watchers tab and by the Flow editor's watcher picker.
 */
export function NewWatcherSheet({ open, onClose, onCreated, onWebhook }: { open: boolean; onClose: () => void; onCreated: (name: string) => void; onWebhook?: () => void }) {
  const [kind, setKind] = useState("");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<[string, string][]>([]);
  const [v, setV] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [tested, setTested] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [card, setCard] = useState<{ hash: string; rows: { label: string; text: string }[] } | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => { if (open) { setKind(""); setProject(""); setV({}); setName(""); setTested(null); setCard(null); setProblem(""); void watchersSource.projects().then((p) => { setProjects(p); if (p.length === 1) setProject(p[0][0]); }).catch(() => setProjects([])); } }, [open]);
  const preset = PRESETS.find((p) => p.kind === kind);
  const work = async (what: string, f: () => Promise<void>) => { setBusy(what); setProblem(""); try { await f(); } catch (e) { setProblem(say(e)); } finally { setBusy(""); } };
  const make = () => work("make", async () => {
    const r = presetInput(kind, project, v);
    if ("missing" in r) { setProblem(r.missing); return; }
    const made = await watchersSource.preset(r.input);
    const n = String(made?.name ?? "");
    if (!n) throw new Error("The watcher was written but Vyre did not say its name.");
    setName(n); setCard({ hash: String(made.hash ?? ""), rows: cardRows(made) });
    const t = testLines(await watchersSource.test(n));
    setTested(t);
    if (t.ok) { const c = await watchersSource.card(n); setCard({ hash: String(c.hash ?? ""), rows: cardRows(c) }); }
  });
  const turnOn = () => work("on", async () => { if (!card?.hash) throw new Error("There is no card to turn on yet. Test it first."); await watchersSource.create(name, card.hash); onCreated(name); onClose(); });
  return (
    <Sheet open={open} onClose={onClose} title="New watcher">
      <View className="gap-s3">
        <Text size="caption" tone="label">A watcher looks somewhere on a schedule and files what is new. It starts off: you test it, read its card, then turn it on.</Text>
        {!name ? (
          <>
            <Select label="Where should it look?" value={kind} options={[...PRESETS.map((p) => [p.kind, `${p.label}: ${p.hint}`] as [string, string]), ["webhook", "A webhook: something calls a web address"]]} placeholder="Choose" onChange={(k) => { if (k === "webhook" && onWebhook) { onClose(); onWebhook(); return; } setKind(k); setV({}); setProblem(""); }} />
            {preset ? (
              <>
                <Select label="Project" value={project} options={projects} placeholder="Choose a project" onChange={setProject} />
                {preset.fields.map((f) => f.choices
                  ? <Select key={f.key} label={f.label} value={v[f.key] ?? f.choices[0][0]} options={f.choices} onChange={(x) => setV({ ...v, [f.key]: x })} />
                  : <Field key={f.key} label={`${f.label}${f.optional ? " (optional)" : ""}`} value={v[f.key] ?? ""} onChangeText={(x) => setV({ ...v, [f.key]: x })} help={f.help} />)}
                <Button kind="primary" label={busy === "make" ? "Writing and testing" : "Write it and test it"} disabled={!!busy} onPress={make} />
              </>
            ) : null}
          </>
        ) : null}
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        {tested ? (
          <View className="gap-s1">
            <Text strong>{tested.ok ? "The test ran. Nothing was filed." : "The test did not pass"}</Text>
            {tested.lines.map((l, i) => <Text key={i} size="secondary" tone={tested.ok ? "muted" : "warn"}>{l}</Text>)}
          </View>
        ) : null}
        {tested?.ok && card ? (
          <>
            <View className="gap-s1">{card.rows.map((r) => <Row key={r.label} dense title={r.label} sub={r.text} />)}</View>
            <Button kind="primary" label={busy === "on" ? "Turning on" : "Turn on"} disabled={!!busy} onPress={turnOn} />
            <Text size="caption" tone="label">Turning on takes the card as read: if the watcher changes after this, it stops until you turn it on again.</Text>
          </>
        ) : null}
        {name && !tested?.ok ? <Text size="caption" tone="label">It is saved as a draft named {name}. Change the fields in chat with @Engineer, or delete it from the Watchers tab.</Text> : null}
      </View>
    </Sheet>
  );
}
