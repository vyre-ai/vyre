// Two-factor codes into the Vault (R031-75): scan the QR in Google Authenticator's export or a site's setup page with the camera, or paste the otpauth:// addresses; see what would be added by name,
// then say yes once. The camera reads the code on this device and the address goes to the box, never through an assistant; only names come back.
import { useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Field, Text, showToast } from "@vyre/ui";
import { ScanCamera, canScanLive, requestCamera, scanProps } from "../../src/native/scan";
import { vaultMore } from "./more";
import { codesLine, otpAddresses, refusalWord, type CodesPlan } from "./more-model";

export function TwoFactorCard({ reload }: { reload: () => void }) {
  const [text, setText] = useState("");
  const [scanned, setScanned] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [plan, setPlan] = useState<CodesPlan | null>(null);
  const [done, setDone] = useState<CodesPlan | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const found = otpAddresses([text, ...scanned].join("\n"));
  const startScan = async () => {
    setProblem("");
    const s = await requestCamera();
    if (s.state !== "granted") { setProblem(s.say); return; }
    setScanning(true);
  };
  const onCode = (c: { kind: string; text?: string }) => {
    if (c.kind !== "other" || !c.text || !/^otpauth/i.test(c.text)) return;
    setScanned((l) => (l.includes(c.text as string) ? l : [...l, c.text as string]));
    setPlan(null); setDone(null);
    showToast("Read one. Scan the next, or stop.");
  };
  const see = async () => {
    setBusy(true); setProblem(""); setDone(null);
    try { setPlan(await vaultMore.codesPreview(found.uris)); } catch (e) { setProblem(refusalWord(e as { code?: string; message?: string }, "read")); } finally { setBusy(false); }
  };
  const add = async () => {
    setBusy(true); setProblem("");
    try { const r = await vaultMore.codesImport(found.uris); setDone(r); setPlan(null); setText(""); setScanned([]); setScanning(false); reload(); } catch (e) { setProblem(refusalWord(e as { code?: string; message?: string }, "added")); } finally { setBusy(false); }
  };
  return (
    <Card>
      <View className="gap-s3">
        <Text strong>Two-factor codes</Text>
        <Text size="secondary" tone="muted">Scan the QR from Google Authenticator's export or a site's setup page, or paste the otpauth:// addresses. Vyre then makes the six-digit codes for you.</Text>
        {canScanLive && ScanCamera ? (
          scanning ? <View style={{ height: 240, borderRadius: 12, overflow: "hidden" }}><ScanCamera style={{ flex: 1 }} {...(scanProps(onCode as never) as object)} /></View>
            : <View className="self-start"><Button icon="scan" label={scanned.length ? "Scan another" : "Scan with the camera"} onPress={() => void startScan()} /></View>
        ) : null}
        {scanning ? <View className="self-start"><Button kind="ghost" label="Stop scanning" onPress={() => setScanning(false)} /></View> : null}
        <Field label="Or paste addresses" value={text} onChangeText={(t) => { setText(t); setPlan(null); setDone(null); }} multiline placeholder="otpauth://totp/..." />
        <Text size="caption" tone="label">{found.uris.length ? `${found.uris.length} ${found.uris.length === 1 ? "code" : "codes"} ready${found.ignored ? `, ${found.ignored} ${found.ignored === 1 ? "line" : "lines"} left out` : ""}.` : "Nothing read yet."}</Text>
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        {plan ? <View className="gap-s2"><Text>{codesLine(plan, true)}</Text>{plan.add.map((n) => <Text key={n} size="secondary" tone="label">{n}</Text>)}<View className="self-start"><Button kind="primary" label={busy ? "Adding" : "Add them"} disabled={busy || !plan.add.length} onPress={() => void add()} /></View></View> : null}
        {done ? <Text>{codesLine(done, false)}</Text> : null}
        {!plan ? <View className="self-start"><Button label={busy ? "Looking" : "See what would be added"} disabled={busy || !found.uris.length} onPress={() => void see()} /></View> : null}
      </View>
    </Card>
  );
}
