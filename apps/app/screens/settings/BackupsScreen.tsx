// Backups (drawn on Updates and backups; the old /u/settings/backups route goes there): which Spaces this box backs up, and which are not because their owner has not turned backups on. Each Space is backed up under its own owner's recovery code, given once;
// after that the Space bundle is written by itself every hour and every backup of the box carries it. Only a Space's owner can turn its backup on.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { callT } from "../../src/real/call-tool";
import { errorNote } from "../../src/real/error-note.js";
import { spaceWords, backupLine, whenLine, vaultBackupLines, type SpaceBackup } from "./backups-model.js";

/** The backups page on its own (its route now opens Updates and backups, which draws BackupsSection: archived.js). */
export default function BackupsScreen() {
  return <Page title="Backups" sub="Each Space is backed up under its owner's recovery code." back="/u/settings"><BackupsSection /></Page>;
}

/** Which Spaces are backed up, with a Turn on for each that is not, and the Vault's own backup. Drawn under Updates on Updates and backups. */
export function BackupsSection() {
  const [rows, setRows] = useState<SpaceBackup[] | null>(null);
  const [vb, setVb] = useState<Parameters<typeof vaultBackupLines>[0]>(null);
  const [err, setErr] = useState("");
  const [errNote, setErrNote] = useState<{ code: string; recourse: string } | null>(null);
  const [open, setOpen] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [vOpen, setVOpen] = useState(false);
  const [vCode, setVCode] = useState("");
  const [vBusy, setVBusy] = useState(false);
  const [vProblem, setVProblem] = useState("");
  const load = useCallback(() => {
    setErr(""); setErrNote(null);
    void callT<{ spaces?: SpaceBackup[] }>("spaces.bundle.status", {}).then((r) => { if (r.error) { const n = errorNote(r.error, "Backups could not be read."); setErr(n.reason); setErrNote({ code: n.code, recourse: n.recourse }); } else setRows(r.data?.spaces ?? []); });
    void callT<NonNullable<Parameters<typeof vaultBackupLines>[0]>>("vault.autobackup.status", {}).then((r) => { if (!r.error) setVb(r.data ?? null); });
  }, []);
  useEffect(load, [load]);
  const turnOn = async (space: string) => {
    setBusy(true); setProblem("");
    const r = await callT("spaces.bundle.enrol", { space, code: code.trim() });
    setBusy(false);
    if (r.error) { setProblem(r.error.code === "denied" ? "Only this Space's owner can turn its backup on." : r.error.code === "bad_code" ? "That is not a recovery code." : r.error.message || "That did not go through."); return; }
    setCode(""); setOpen(""); showToast("Backups are on for this Space."); load();
  };
  const turnOnVault = async () => {
    setVBusy(true); setVProblem("");
    const r = await callT("vault.autobackup.enrol", { code: vCode.trim() });
    setVBusy(false);
    if (r.error) { setVProblem(r.error.code === "bad_code" ? "That is not a recovery code." : r.error.message || "That did not go through."); return; }
    setVCode(""); setVOpen(false); showToast("The vault backs itself up every day now."); load();
  };
  return (
    <View className="gap-s3">
      <Text tone="muted">Each Space is backed up under its owner's recovery code.</Text>
      {err ? <Card flush><ErrorState title="Backups did not load" reason={err} retry={load} recourse={errNote?.recourse} code={errNote?.code} /></Card> : null}
      {!rows && !err ? <LoadingState rows={3} /> : null}
      {rows && !rows.length ? <Card><EmptyState title="No Spaces here" body="A server that holds Spaces lists each one here." /></Card> : null}
      {rows && rows.length ? (
        <Card flush>
          {rows.map((r, i) => (
            <View key={r.space}>
              {i ? <Divider /> : null}
              <Row title={spaceWords(r.name)} sub={backupLine(r)} end={r.enrolled ? <Chip>{whenLine(r.last)}</Chip> : <Button size="sm" kind="secondary" label="Turn on" onPress={() => { setOpen(open === r.space ? "" : r.space); setProblem(""); }} />} />
              {open === r.space ? (
                <View className="gap-s2 px-s4 pb-s3">
                  <Text tone="muted">Give the owner's recovery code once. It only wraps a key the Space keeps sealed; it is never stored.</Text>
                  <Field label="Recovery code" value={code} onChangeText={setCode} placeholder="26 letters and digits" />
                  {problem ? <Banner tone="warn">{problem}</Banner> : null}
                  <View className="flex-row"><Button kind="primary" size="sm" label={busy ? "Turning on" : "Turn on backups"} disabled={busy || code.trim().length < 26} onPress={() => void turnOn(r.space)} /></View>
                </View>
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}
      {vb ? (() => { const v = vaultBackupLines(vb); return (
        <Card flush>
          <Row title={v.title} sub={v.backup} end={vb.enrolled ? <Chip>On</Chip> : <Button size="sm" kind="secondary" label="Turn on" onPress={() => { setVOpen(!vOpen); setVProblem(""); }} />} />
          {!vb.enrolled && vOpen ? (
            <View className="gap-s2 px-s4 pb-s3">
              <Text tone="muted">Give your recovery code once. Every backup opens with that code alone; it is never stored.</Text>
              <Field label="Recovery code" value={vCode} onChangeText={setVCode} placeholder="26 letters and digits" />
              {vProblem ? <Banner tone="warn">{vProblem}</Banner> : null}
              <View className="flex-row"><Button kind="primary" size="sm" label={vBusy ? "Turning on" : "Turn on vault backup"} disabled={vBusy || vCode.trim().length < 26} onPress={() => void turnOnVault()} /></View>
            </View>
          ) : null}
          {v.drill ? <><Divider /><Row title="Restore drill" sub={v.drill} end={vb.drill ? <Chip>{vb.drill.ok ? "Passed" : "Failed"}</Chip> : undefined} /></> : null}
        </Card>
      ); })() : null}
    </View>
  );
}
