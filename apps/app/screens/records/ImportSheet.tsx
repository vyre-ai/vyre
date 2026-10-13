import { useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { Button, Card, Field, ImportWizard, Sheet, Text, guessMapping, importIssues, parseCsv, importableFields, runImport, showToast, useStore } from "@vyre/ui";
import type { DupeRule } from "@vyre/ui";

/** Import records of one type from a CSV: a file (web) or pasted text, columns matched to fields, a check of every row, then the rows added one by one through the same create a form uses, with how far it is. */
export function ImportSheet({ open, onClose, def, noun, onDone }: { open: boolean; onClose: () => void; def: any; noun: string; onDone: () => void }) {
  const store = useStore();
  const fields = useMemo(() => importableFields(def.fields), [def]);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [parsed, setParsed] = useState<ReturnType<typeof parseCsv> | null>(null);
  const [step, setStep] = useState(0);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [dupe, setDupe] = useState<DupeRule>("skip");
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined);
  const [result, setResult] = useState({ created: 0, updated: 0, skipped: 0, flagged: 0 });
  const [failures, setFailures] = useState<{ row: number; why: string }[]>([]);
  const [problem, setProblem] = useState("");
  const reset = () => { setText(""); setName(""); setParsed(null); setStep(0); setMapping({}); setProgress(undefined); setProblem(""); setFailures([]); };
  const close = () => { onClose(); if (!progress || progress.done >= progress.total) reset(); };
  const read = (t: string, n: string) => {
    const p = parseCsv(t);
    if (!p.headers.length || !p.rows.length) { setProblem("That has no rows. The first line should be the column names."); return; }
    setProblem(""); setParsed(p); setName(n || "pasted rows"); setMapping(guessMapping(p.headers, fields)); setStep(1);
  };
  const pickFile = () => {
    if (typeof document === "undefined") return;
    const i = document.createElement("input");
    i.type = "file"; i.accept = ".csv,text/csv,text/plain";
    i.onchange = () => { const f = i.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => read(String(r.result ?? ""), f.name); r.readAsText(f); };
    i.click();
  };
  const issues = parsed ? importIssues(parsed.rows, mapping, fields) : [];
  const go = async () => {
    if (!parsed) return;
    const skip = new Set(issues.map((x) => x.row));
    setStep(3); setProgress({ done: 0, total: parsed.rows.length - skip.size });
    const r = await runImport({ rows: parsed.rows, mapping, fields, skip, type: def.name, create: (t, d) => store.create(t, d as any), skipRepeats: dupe === "skip", onProgress: (done, total) => setProgress({ done, total }) });
    setProgress({ done: r.created + r.refused + (r.skipped - skip.size), total: r.created + r.refused + (r.skipped - skip.size) });
    setResult({ created: r.created, updated: 0, skipped: r.skipped, flagged: r.refused });
    setFailures(r.failures);
    showToast(`${r.created} ${noun} added.`);
    onDone();
  };
  const uploader = (
    <Card className="gap-s3">
      {Platform.OS === "web" ? <View className="flex-row"><Button kind="secondary" icon="upload" label="Choose a CSV file" onPress={pickFile} /></View> : null}
      <Field label="Or paste the rows" value={text} onChangeText={setText} multiline lines={5} placeholder={"Name,Kind,Estimated value\nFamily home,Real estate,640000"} mono />
      {problem ? <Text size="caption" tone="err">{problem}</Text> : <Text size="caption" tone="label">The first line is the column names. Nothing is added until you approve the check.</Text>}
      <View className="flex-row"><Button kind="primary" label="Read it" disabled={!text.trim()} onPress={() => read(text, "")} /></View>
    </Card>
  );
  return (
    <Sheet open={open} onClose={close} title={`Import ${noun}`}>
      <ImportWizard step={step} noun={noun} source="" fileName={name} headers={parsed?.headers ?? []} sample={parsed?.rows[0] ?? {}} mapping={mapping} onMap={(h, f) => setMapping({ ...mapping, [h]: f })}
        fields={fields} issues={issues} total={parsed?.rows.length ?? 0} dupe={dupe} onDupe={setDupe} result={result} onNext={() => (step === 2 ? void go() : setStep(step + 1))} onBack={() => setStep(Math.max(0, step - 1))}
        uploader={uploader} sources={false} noUpdate progress={progress} failures={failures} />
    </Sheet>
  );
}
