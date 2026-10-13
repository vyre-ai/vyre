import { View } from "react-native";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { SectionLabel } from "../components/SectionLabel";
import { Meter } from "../components/Meter";
import { Segmented } from "../components/Segmented";
import { Select } from "../components/Select";
import { StageSteps } from "../components/StageSteps";
import { Text } from "../components/Text";
import { importSummary } from "./logic.js";

export const IMPORT_STEPS = ["Upload", "Match columns", "Check", "Done"];
export type ImportIssue = { row: number; field: string; problem: string };
export type DupeRule = "skip" | "update" | "create";

/** Import records from a file, four steps and nothing is written until the third is approved: pick a file or a source, match each column to a field, see what would be refused and choose what to do with repeats, then the result. */
export function ImportWizard({ step, noun, source, fileName, headers, sample, mapping, onMap, fields, issues, total, dupe, onDupe, result, onNext, onBack, uploader, sources = true, noUpdate, progress, failures }: {
  step: number; noun: string; source: string; fileName: string; headers: string[]; sample: Record<string, string>; mapping: Record<string, string>; onMap: (header: string, field: string) => void;
  fields: { name: string; label: string }[]; issues: ImportIssue[]; total: number; dupe: DupeRule; onDupe: (d: DupeRule) => void; result: { created: number; updated: number; skipped: number; flagged: number }; onNext: () => void; onBack: () => void;
  /** The real upload (a file button and a paste box) in place of the sample drop area. */ uploader?: React.ReactNode; /** Source chips (other systems): shown only where they work. */ sources?: boolean; /** No "Update it" where nothing can update a record. */ noUpdate?: boolean; /** While rows are being added: how far. */ progress?: { done: number; total: number }; /** The rows the box refused, with its words. */ failures?: { row: number; why: string }[];
}) {
  const sum = importSummary(total, issues, mapping);
  const label = (n: string) => fields.find((f) => f.name === n)?.label ?? n;
  return (
    <View className="gap-s4">
      <StageSteps stages={IMPORT_STEPS} current={step} />
      {step === 0 ? (
        <View className="gap-s3">
          {uploader ?? <Card className="items-center gap-s2 py-s6"><Icon name="upload" size={24} tone="label" /><Text strong>{fileName || `Drop a CSV of ${noun} here`}</Text><Text size="caption" tone="label">Or choose a file. A header row is expected.</Text><Button kind="secondary" label="Choose a file" onPress={onNext} /></Card>}
          {sources ? <><SectionLabel first>Or bring them from</SectionLabel>
          <View className="flex-row flex-wrap gap-s2">{["Clio", "Lawmatics", "HubSpot", "Google Contacts"].map((s) => <Chip key={s} icon="download" selected={source === s}>{s}</Chip>)}</View></> : null}
          <Text size="caption" tone="label">Nothing is written until you approve the check in step 3.</Text>
        </View>
      ) : null}
      {step === 1 ? (
        <View className="gap-s3">
          <Text tone="muted">{`${fileName}: ${total} rows. Match each column to a field of ${noun}. Columns left on Skip are not imported.`}</Text>
          <Card flush>
            {headers.map((h, i) => (
              <View key={h}>
                {i ? <Divider /> : null}
                <View className="gap-s2 p-s3">
                  <Row dense title={h} sub={sample[h] ? `For example ${sample[h]}` : "Empty in the first row"} />
                  <Select label={`${h} goes to`} value={mapping[h] ?? ""} options={[["", "Skip this column"], ...fields.map((f) => [f.name, f.label] as [string, string])]} onChange={(v) => onMap(h, v)} />
                </View>
              </View>
            ))}
          </Card>
        </View>
      ) : null}
      {step === 2 ? (
        <View className="gap-s3">
          <Banner tone={sum.flagged ? "warn" : "plain"}><Text strong>{`${sum.ready} of ${sum.total} rows are ready. ${sum.flagged} need a look.`}</Text><Text size="caption" tone="muted">{sum.unmapped ? `${sum.unmapped} ${sum.unmapped === 1 ? "column is" : "columns are"} skipped.` : "Every column is matched."}</Text></Banner>
          <Segmented<DupeRule> label="When a row matches a record that is already here" value={dupe} onChange={onDupe} options={(noUpdate ? [["skip", "Skip it"], ["create", "Add anyway"]] : [["skip", "Skip it"], ["update", "Update it"], ["create", "Add anyway"]]) as [DupeRule, string][]} />
          {issues.length ? (
            <Card flush title="Rows to fix or skip">
              {issues.map((x, i) => <View key={i}>{i ? <Divider /> : null}<Row dense title={`Row ${x.row}, ${label(x.field)}`} sub={x.problem === "duplicate" ? "Repeats an earlier row" : x.problem === "empty" ? "Required and empty" : `Value is ${x.problem}`} end={<Chip tone="warn">Skipped</Chip>} /></View>)}
            </Card>
          ) : null}
        </View>
      ) : null}
      {step === 3 ? (
        progress && progress.done < progress.total ? (
          <Card className="gap-s2"><Text size="title" strong>{`Adding ${noun}...`}</Text><Text tone="muted">{`${progress.done} of ${progress.total}`}</Text><Meter value={progress.done / Math.max(progress.total, 1)} label="Import progress" /><Text size="caption" tone="label">You can leave this page; it keeps going.</Text></Card>
        ) : (
          <Card className="gap-s2"><Text size="title" strong>{`${result.created} ${noun} added`}</Text><Text tone="muted">{`${result.updated} updated, ${result.skipped} skipped, ${result.flagged} refused or left out because of a problem.`}</Text>
            {failures?.length ? failures.slice(0, 8).map((f) => <Text key={f.row} size="caption" tone="label">{`Row ${f.row}: ${f.why}`}</Text>) : null}
            {failures && failures.length > 8 ? <Text size="caption" tone="label">{`And ${failures.length - 8} more.`}</Text> : null}
            {progress ? null : <Text size="caption" tone="label">An undo for this import stays for 7 days.</Text>}</Card>
        )
      ) : null}
      <View className="flex-row gap-s2">
        {step > 0 && step < 3 ? <Button kind="ghost" label="Back" onPress={onBack} /> : null}
        {step === 1 ? <Button kind="primary" label="Check the rows" onPress={onNext} /> : null}
        {step === 2 ? <Button kind="primary" label={`Import ${sum.ready} ${noun}`} onPress={onNext} /> : null}
      </View>
    </View>
  );
}
