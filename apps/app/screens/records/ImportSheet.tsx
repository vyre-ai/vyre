import { useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { Button, Card, Field, ImportWizard, Select, Sheet, Text, guessMapping, importIssues, parseCsv, parseGrid, importableFields, runImport, showToast, useStore } from "@vyre/ui";
import type { DupeRule } from "@vyre/ui";
import { readWorkbook, type Sheet as WorkSheet } from "./workbook";

/** Import records of one type from a CSV or an Excel workbook: a file (web) or pasted text, columns matched to fields, a check of every row, then the rows added one by one through the same create a form uses, with how far it is. */
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
  // a workbook with more than one sheet waits here until the person picks which sheet to read
  const [book, setBook] = useState<{ file: string; sheets: WorkSheet[]; pick: string } | null>(null);
  const reset = () => { setText(""); setName(""); setParsed(null); setStep(0); setMapping({}); setProgress(undefined); setProblem(""); setFailures([]); setBook(null); };
  const close = () => { onClose(); if (!progress || progress.done >= progress.total) reset(); };
  const accept = (p: ReturnType<typeof parseCsv>, n: string) => {
    if (!p.headers.length || !p.rows.length) { setProblem("That has no rows. The first line should be the column names."); return; }
    setProblem(""); setBook(null); setParsed(p); setName(n || "pasted rows"); setMapping(guessMapping(p.headers, fields)); setStep(1);
  };
  const read = (t: string, n: string) => accept(parseCsv(t), n);
  const readSheet = (sheets: WorkSheet[], pick: string, file: string) => {
    const s = sheets.find((x) => x.name === pick) ?? sheets[0];
    accept(parseGrid(s.grid), sheets.length > 1 ? `${file}, ${s.name}` : file);
  };
  const pickFile = () => {
    if (typeof document === "undefined") return;
    const i = document.createElement("input");
    i.type = "file"; i.accept = ".csv,.xlsx,.xls,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";
    i.onchange = () => {
      const f = i.files?.[0]; if (!f) return;
      if (/\.xlsx?$/i.test(f.name)) {
        readWorkbook(f).then((sheets) => {
          if (!sheets.length) { setProblem("That workbook has no sheets."); return; }
          if (sheets.length === 1) readSheet(sheets, sheets[0].name, f.name);
          else { setProblem(""); setBook({ file: f.name, sheets, pick: sheets[0].name }); }
        }).catch(() => setProblem("That file could not be read as a spreadsheet. Save it as .xlsx or CSV and choose it again."));
        return;
      }
      const r = new FileReader(); r.onload = () => read(String(r.result ?? ""), f.name); r.readAsText(f);
    };
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
      {Platform.OS === "web" ? <View className="flex-row"><Button kind="secondary" icon="upload" label="Choose a CSV or Excel file" onPress={pickFile} /></View> : null}
      {book ? (
        <View className="gap-s2">
          <Select label={`Sheet in ${book.file}`} value={book.pick} options={book.sheets.map((x) => [x.name, x.name] as [string, string])} onChange={(v) => setBook({ ...book, pick: v })} />
          <View className="flex-row"><Button kind="primary" label="Read this sheet" onPress={() => readSheet(book.sheets, book.pick, book.file)} /></View>
        </View>
      ) : null}
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
