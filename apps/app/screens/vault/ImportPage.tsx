// Bring passwords and keys into the Vault: from another password manager or browser (the person picks where, chooses the export, sees what would come in, and says yes once), and from the .env files
// in their projects (found by the box, moved in and swapped for references under one yes). The export's bytes go to the box once; this page keeps names and counts only.
import { useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, IconTile, Row, SectionLabel, Segmented, Switch, Text, showToast } from "@vyre/ui";
import { vaultImport } from "./import";
import { pickFile } from "./pick-file";
import type { importSource } from "./import-source";
import type { Picked } from "./import-source";
import { SOURCES, fileName, importLabel, importRefusal, plural, previewView, resultLine, scanGroups, scanTotals, type Imported, type Preview, type Scan, type Source } from "./import-model";

const say = (e: unknown) => importRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

/** What the page calls: the box (default), or a fake in the sample world and in tests. */
export type Io = { source: ReturnType<typeof importSource>; pick: (accept: string) => Promise<Picked | null> };
const REAL: Io = { source: vaultImport, pick: pickFile };

export default function ImportPage({ reload, io = REAL }: { reload: () => void; io?: Io }) {
  return (
    <View className="w-full gap-s4 self-start" style={{ maxWidth: 720 }}>
      <FromApp reload={reload} io={io} />
      <FromProjects reload={reload} io={io} />
    </View>
  );
}

// ---- from another app --------------------------------------------------------------------

type Step = { at: "pick" } | { at: "how"; source: Source } | { at: "preview"; source: Source; file: Picked; preview: Preview } | { at: "done"; result: Imported };

function FromApp({ reload, io }: { reload: () => void; io: Io }) {
  const [step, setStep] = useState<Step>({ at: "pick" });
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [useFile, setUseFile] = useState(false);

  const choose = async (source: Source) => {
    setProblem("");
    const file = await io.pick(source.accept);
    if (!file) return;
    setBusy(true);
    try { setStep({ at: "preview", source, file, preview: await io.source.preview(file) }); setUseFile(false); }
    catch (e) { setProblem(say(e)); }
    finally { setBusy(false); }
  };
  const run = async (file: Picked, preview: Preview) => {
    setBusy(true); setProblem("");
    try { const result = await io.source.run(file, preview.token, useFile); setStep({ at: "done", result }); reload(); }
    catch (e) { setProblem(say(e)); }
    finally { setBusy(false); }
  };

  if (step.at === "done") {
    const r = step.result;
    return (
      <Card><View className="gap-s3">
        <View className="flex-row items-center gap-s3"><IconTile name="ok" tone="ok" /><Text strong size="title">Done</Text></View>
        <Text>{resultLine(r)}</Text>
        {r.skipped.length ? <Text size="caption" tone="label">{plural(r.skipped.length, "item was", "items were")} not imported: {r.skipped.slice(0, 3).join("; ")}{r.skipped.length > 3 ? "; and more" : ""}.</Text> : null}
        <Banner tone="warn" icon="warning"><Text>Delete the file you exported. It still holds every password in plain text, and Vyre does not need it again.</Text></Banner>
        <View className="self-start"><Button kind="primary" label="Done" onPress={() => setStep({ at: "pick" })} /></View>
      </View></Card>
    );
  }

  if (step.at === "preview") {
    const v = previewView(step.preview);
    return (
      <Card><View className="gap-s3">
        <View className="gap-s1"><Text strong size="title">{v.title}</Text>{v.kinds ? <Text tone="muted">{v.kinds}</Text> : null}</View>
        <View className="flex-row gap-s2">
          <Count n={v.fresh} word="new" tone="ok" />
          <Count n={v.here} word="already here" />
          <Count n={v.differ} word="differ" tone={v.differ ? "warn" : undefined} />
        </View>
        {v.names.length ? (
          <View className="gap-s1">
            <Text size="caption" tone="label">Coming in</Text>
            <Text numberOfLines={3}>{v.names.join(", ")}{v.more ? `, and ${v.more} more` : ""}</Text>
          </View>
        ) : null}
        {v.differ ? (
          <View className="gap-s2">
            <Text size="caption" tone="label">{plural(v.differ, "item has", "items have")} a different password in the file: {v.differs.slice(0, 3).join(", ")}{v.differ > 3 ? ", and more" : ""}.</Text>
            <Segmented label="Where a password differs" value={useFile ? "file" : "keep"} onChange={(x) => setUseFile(x === "file")} options={[["keep", "Keep the Vault's"], ["file", "Use the file's"]]} />
            {useFile ? <Text size="caption" tone="label">The old password stays in that item's history.</Text> : null}
          </View>
        ) : null}
        {v.renamed.map((x) => <Text key={x} size="caption" tone="label">{x}</Text>)}
        {v.skipped.length ? <Text size="caption" tone="label">{plural(v.skipped.length, "row", "rows")} cannot be imported: {v.skipped.slice(0, 2).join("; ")}{v.skipped.length > 2 ? "; and more" : ""}.</Text> : null}
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <View className="flex-row flex-wrap items-center gap-s2">
          <Button kind="primary" label={busy ? "Importing" : importLabel(v, useFile)} disabled={busy || (v.fresh + (useFile ? v.differ : 0)) === 0} onPress={() => run(step.file, step.preview)} />
          <Button kind="ghost" label="Choose another file" onPress={() => { setProblem(""); setStep({ at: "how", source: step.source }); }} />
        </View>
        <Text size="caption" tone="label">The Vault asks you to approve this. The passwords go from the file to the Vault; no assistant sees them.</Text>
      </View></Card>
    );
  }

  if (step.at === "how") {
    const s = step.source;
    return (
      <Card><View className="gap-s3">
        <View className="gap-s1"><Text strong size="title">{s.name}</Text><Text tone="muted">{s.how}</Text></View>
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <View className="flex-row flex-wrap items-center gap-s2">
          <Button kind="primary" icon="upload" label={busy ? "Reading" : "Choose the file"} disabled={busy} onPress={() => choose(s)} />
          <Button kind="ghost" label="Back" onPress={() => { setProblem(""); setStep({ at: "pick" }); }} />
        </View>
      </View></Card>
    );
  }

  const shown = all ? SOURCES : SOURCES.slice(0, 6);
  return (
    <View>
      <SectionLabel first>From another app</SectionLabel>
      <Text tone="muted" size="secondary" className="pb-s2">Pick where your passwords are now. You export a file from there, and Vyre reads it for you.</Text>
      <Card flush>
        {shown.map((s, i) => (
          <View key={s.id}>{i ? <Divider inset={60} /> : null}
            <Row dense chevron lead={<MarkTile source={s} index={i} />} title={s.name} onPress={() => { setProblem(""); setStep({ at: "how", source: s }); }} />
          </View>
        ))}
      </Card>
      {all ? null : <View className="self-start pt-s2"><Button kind="ghost" size="sm" label={`Show all ${SOURCES.length}`} onPress={() => setAll(true)} /></View>}
    </View>
  );
}

const TINTS = ["bg-accent-wash", "bg-ok-wash", "bg-warn-wash", "bg-hover"] as const;
const INKS = ["accent", "ok", "warn", "muted"] as const;
/** A letter-mark tile for a source: its initials on a calm tint, so the list can be scanned. No brand logos. */
function MarkTile({ source, index }: { source: Source; index: number }) {
  const k = index % TINTS.length;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 32, height: 32 }} className={`items-center justify-center rounded-card ${TINTS[k]}`}>
      <Text size="caption" strong tone={INKS[k]}>{source.mark}</Text>
    </View>
  );
}

function Count({ n, word, tone }: { n: number; word: string; tone?: "ok" | "warn" }) {
  return (
    <View className="min-w-0 flex-1 gap-s1 rounded-card border border-edge bg-surface-3 p-s3">
      <Text size="title" strong tone={tone === "ok" ? "ok" : tone === "warn" ? "warn" : "default"}>{String(n)}</Text>
      <Text size="caption" tone="label">{word}</Text>
    </View>
  );
}

// ---- from the projects on the box ----------------------------------------------------------

function FromProjects({ reload, io }: { reload: () => void; io: Io }) {
  const [scan, setScan] = useState<Scan | null | undefined>(undefined);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState<Imported | null>(null);

  const look = async () => {
    setBusy(true); setProblem(""); setDone(null);
    try { setScan(await io.source.scan()); setOff(new Set()); } catch (e) { setProblem(say(e)); } finally { setBusy(false); }
  };
  const groups = scan ? scanGroups(scan) : [];
  const chosen = scan ? scan.files.filter((f) => !off.has(f.file)) : [];
  const keys = chosen.reduce((a, f) => a + f.secrets, 0);
  const move = async () => {
    setBusy(true); setProblem("");
    try {
      const r = await io.source.moveEnv(chosen.map((f) => f.file));
      setDone(r); setScan(undefined); reload();
      showToast(`${plural(r.rewritten?.length ?? 0, "file", "files")} now point${(r.rewritten?.length ?? 0) === 1 ? "s" : ""} at the Vault.`);
    } catch (e) { setProblem(say(e)); } finally { setBusy(false); }
  };

  return (
    <View>
      <SectionLabel>Your projects</SectionLabel>
      {done ? (
        <Card><View className="gap-s3">
          <View className="flex-row items-center gap-s3"><IconTile name="ok" tone="ok" /><Text strong size="title">{plural(done.rewritten?.length ?? 0, "file", "files")} moved</Text></View>
          <Text>{plural(done.added.length, "set of keys is", "sets of keys are")} in your Vault. Each file now holds references, and its other settings are as they were. Run an app with vyre run in its folder and it reads the keys from the Vault.</Text>
          {done.unchanged?.length ? <Text size="caption" tone="label">{plural(done.unchanged.length, "file was", "files were")} left as it is.</Text> : null}
          {done.committed?.length ? <Banner tone="warn" icon="warning"><Text>{plural(done.committed.length, "file is", "files are")} committed to git, so the old values stay in its history. Change those keys at the provider.</Text></Banner> : null}
          <View className="self-start"><Button kind="ghost" label="Done" onPress={() => setDone(null)} /></View>
        </View></Card>
      ) : scan === undefined ? (
        <Card><View className="gap-s3">
          <Text tone="muted">Keys often sit in .env files next to the code. Vyre can find them, move them into the Vault and leave a reference in each file.</Text>
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <View className="self-start"><Button kind="secondary" icon="scan" label={busy ? "Looking" : "Look in my projects"} disabled={busy} onPress={look} /></View>
        </View></Card>
      ) : scan === null ? (
        <Card flush><EmptyState title="This server cannot look yet" body="It needs a newer Vyre to find .env files." /></Card>
      ) : !scan.files.length ? (
        <Card flush><EmptyState title="No keys found" body={scan.scanned ? "The .env files in your projects hold nothing that looks like a key." : "No .env files turned up in your projects."} action={{ label: "Look again", onPress: look }} /></Card>
      ) : (
        <View className="gap-s3">
          <Text tone="muted" size="secondary" >{plural(scanTotals(scan).secrets, "key", "keys")} in {plural(scanTotals(scan).files, "file", "files")}. Switch off any you want to leave alone.</Text>
          {groups.map((g) => (
            <View key={g.project}>
              <SectionLabel meta={plural(g.secrets, "key", "keys")}>{g.project}</SectionLabel>
              <Card flush>
                {g.files.map((f, i) => (
                  <View key={f.file}>{i ? <Divider /> : null}
                    <Row dense title={`${f.where ? f.where + "/" : ""}${fileName(f.file)}`} sub={f.warn ? `${f.line}. ${f.warn}` : f.line}
                      end={<View className="flex-row items-center gap-s2">{f.git?.tracked ? <Chip tone="warn">In git</Chip> : null}<Switch label={`Move ${fileName(f.file)}`} on={!off.has(f.file)} onChange={(on) => setOff((s) => { const n = new Set(s); if (on) n.delete(f.file); else n.add(f.file); return n; })} /></View>} />
                  </View>
                ))}
              </Card>
            </View>
          ))}
          {scan.truncated ? <Text size="caption" tone="label">There are more files than this list holds. Move these first, then look again.</Text> : null}
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <View className="flex-row flex-wrap items-center gap-s2">
            <Button kind="primary" label={busy ? "Moving" : keys ? `Move ${plural(keys, "key", "keys")} into the Vault` : "Nothing chosen"} disabled={busy || !keys} onPress={move} />
            <Button kind="ghost" label="Look again" onPress={look} />
          </View>
          <Text size="caption" tone="label">The Vault asks you to approve this once. Only the keys move; ports and other settings stay in the file.</Text>
        </View>
      )}
    </View>
  );
}
