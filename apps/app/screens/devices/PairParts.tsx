import { useEffect, useMemo, useState } from "react";
import { Platform, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Field, Text } from "@vyre/ui";
import { ScanCamera, canScanLive, requestCamera, scanProps, type ScannedCode, type ScanSupport } from "../../src/native/scan";
import { parseWinkCode, type WinkCode } from "../../src/api/wink-code";
import { openPairing, type PairingSession } from "../../src/api/pairing-session";
import { COPY } from "./wink.js";

/** A scanned code as the text the parser reads. */
const textOf = (c: ScannedCode) => (c.kind === "wink" ? `vyre://wink/2?t=${c.ticket}&r=${encodeURIComponent(c.relay)}${c.for === "phone" ? "&k=phone" : ""}` : c.kind === "pair" ? c.offer : c.text);

export type LongCode = Extract<WinkCode, { ok: true }>;

/** Scan the code with the camera, or paste the long one. Both go through parseWinkCode; a short typed code is refused in plain words. */
export function PairEntry({ onCode, sample }: { onCode: (c: LongCode) => void; sample?: string }) {
  const [text, setText] = useState("");
  const [say, setSay] = useState("");
  const [cam, setCam] = useState<ScanSupport | null>(null);
  useEffect(() => { if (canScanLive) requestCamera().then(setCam).catch(() => {}); }, []);

  const take = (raw: string) => {
    const r = parseWinkCode(raw);
    if (r.ok) { setSay(""); onCode(r); } else setSay(r.say);
  };
  const scan = useMemo(() => scanProps((c) => take(textOf(c))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  []);
  const photo = () => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const i = document.createElement("input");
    i.type = "file"; i.accept = "image/*";
    i.onchange = async () => {
      const f = i.files?.[0];
      const web = (await import("../../src/native/scan.web")) as { readPhoto: (f: Blob, h: (c: ScannedCode) => void) => Promise<boolean> };
      const found = f ? await web.readPhoto(f, (c) => take(textOf(c))).catch(() => false) : false;
      if (!found) setSay(COPY.noCodeInPicture);
    };
    i.click();
  };

  return (
    <View className="w-full gap-s3">
      {canScanLive && ScanCamera && cam?.state === "granted" ? (
        <View className="h-48 w-full overflow-hidden rounded-card"><ScanCamera style={{ flex: 1 }} {...scan} /></View>
      ) : cam && cam.state !== "granted" ? <Text size="caption" tone="muted">{cam.say}</Text> : null}
      <Field label="Or paste the long code" name="Long code" value={text} onChangeText={(v) => { setText(v); if (say) setSay(""); }} placeholder="vyre://wink/2?..." mono error={say || undefined} />
      <View className="flex-row flex-wrap gap-s2">
        <Button kind="primary" size="sm" label="Continue" onPress={() => take(text)} />
        <Button size="sm" label="Paste" onPress={() => { Clipboard.getStringAsync().then((t) => { setText(t); take(t); }).catch(() => setSay(COPY.noClipboard)); }} />
        {Platform.OS === "web" ? <Button size="sm" label="Choose a picture" onPress={photo} /> : null}
        {sample ? <Button kind="ghost" size="sm" label="Use the sample code" onPress={() => { setText(sample); take(sample); }} /> : null}
      </View>
    </View>
  );
}

/** The three words. Confirm only if the other screen shows the same ones. */
export function PairWords({ session, who, onConfirmed, onRejected }: { session: PairingSession; who: string; onConfirmed: () => void; onRejected: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const words = session.words();
  return (
    <Card className="w-full items-center gap-s3">
      <Text strong className="text-center">{COPY.askLine(who)}</Text>
      <View className="flex-row flex-wrap justify-center gap-s2">
        {words.map((w) => <Text key={w} mono size="title" strong>{w}</Text>)}
      </View>
      <Text tone="muted" className="text-center">{COPY.compare}</Text>
      {err ? <Banner tone="warn">{err}</Banner> : null}
      <View className="w-full flex-row flex-wrap justify-center gap-s2">
        <Button kind="primary" size="sm" icon="check" label="Confirm" loading={busy} onPress={() => { setBusy(true); session.confirm().then(onConfirmed).catch(() => { setBusy(false); setErr(COPY.ended); }); }} />
        <Button kind="ghost" size="sm" label="These are not the same" onPress={() => { session.reject(); onRejected(); }} />
      </View>
    </Card>
  );
}

export { openPairing };
