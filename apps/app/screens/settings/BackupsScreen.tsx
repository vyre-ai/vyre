// /u/settings/backups: which Spaces this box backs up, and which are not because their owner has not turned backups on. Each Space is backed up under its own owner's recovery code, given once;
// after that the Space bundle is written by itself every hour and every backup of the box carries it. Only a Space's owner can turn its backup on.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { callT } from "../../src/real/call-tool";
import { backupLine, whenLine, type SpaceBackup } from "./backups-model.js";

export default function BackupsScreen() {
  const [rows, setRows] = useState<SpaceBackup[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => {
    setErr("");
    void callT<{ spaces?: SpaceBackup[] }>("spaces.bundle.status", {}).then((r) => { if (r.error) setErr(r.error.message || "Backups could not be read."); else setRows(r.data?.spaces ?? []); });
  }, []);
  useEffect(load, [load]);
  const turnOn = async (space: string) => {
    setBusy(true); setProblem("");
    const r = await callT("spaces.bundle.enrol", { space, code: code.trim() });
    setBusy(false);
    if (r.error) { setProblem(r.error.code === "denied" ? "Only this Space's owner can turn its backup on." : r.error.code === "bad_code" ? "That is not a recovery code." : r.error.message || "That did not go through."); return; }
    setCode(""); setOpen(""); showToast("Backups are on for this Space."); load();
  };
  return (
    <Page title="Backups" sub="Each Space is backed up under its owner's recovery code." back="/u/settings">
      {err ? <Card flush><ErrorState title="Backups did not load" reason={err} retry={load} /></Card> : null}
      {!rows && !err ? <LoadingState rows={3} /> : null}
      {rows && !rows.length ? <Card><EmptyState title="No Spaces here" body="A box that holds Spaces lists each one here." /></Card> : null}
      {rows && rows.some((r) => !r.enrolled) ? <Banner tone="warn">{rows.filter((r) => !r.enrolled).map((r) => r.note || backupLine(r)).join(" ")}</Banner> : null}
      {rows && rows.length ? (
        <Card flush>
          {rows.map((r, i) => (
            <View key={r.space}>
              {i ? <Divider /> : null}
              <Row title={r.name} sub={backupLine(r)} end={r.enrolled ? <Chip>{whenLine(r.last)}</Chip> : <Button size="sm" kind="secondary" label="Turn on" onPress={() => { setOpen(open === r.space ? "" : r.space); setProblem(""); }} />} />
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
    </Page>
  );
}
