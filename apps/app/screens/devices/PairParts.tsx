import { useEffect, useMemo, useState } from "react";
import { Platform, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Field, Text } from "@vyre/ui";
import { ScanCamera, canScanLive, requestCamera, scanProps, type ScannedCode, type ScanSupport } from "../../src/native/scan";
import { parseWinkCode, type WinkCode } from "../../src/api/wink-code";
import { openPairing, wordsLine, type PairingSession } from "../../src/api/pairing-session";
import { COPY } from "./wink.js";
import { serverSay } from "../install/flow.js";
import { pairSayHere } from "../../src/real/pair-say";

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

/** The other screen shows three words. Pick the set it shows, or type all three. A wrong answer pairs nothing. */
export function PairWords({ session, who, onConfirmed, onRejected }: { session: PairingSession; who: string; onConfirmed: () => void; onRejected: () => void }) {
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(() => session.choices().length === 0);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState("");
  const choices = useMemo(() => session.choices(), [session]);
  const send = (given: readonly string[]) => {
    setBusy(true);
    session.answer(given).then((ok) => { if (ok) onConfirmed(); else onRejected(); }).catch(() => { setBusy(false); setErr(COPY.ended); });
  };
  return (
    <Card className="w-full items-center gap-s3">
      <Text strong className="text-center">{COPY.askLine(who)}</Text>
      <Text tone="muted" className="text-center">{COPY.pick}</Text>
      {err ? <Banner tone="warn">{err}</Banner> : null}
      {typing ? (
        <View className="w-full gap-s2">
          <Field label="The three words" name="Three words" value={typed} onChangeText={setTyped} placeholder="three words, a space between" mono />
          <Button kind="primary" size="sm" icon="check" label="Confirm" loading={busy} disabled={typed.trim().split(/\s+/).length !== 3} onPress={() => send(typed.trim().split(/\s+/))} />
        </View>
      ) : (
        <View className="w-full gap-s2">
          {choices.map((c) => <Button key={c.join(" ")} size="md" label={wordsLine(c)} loading={busy} onPress={() => send(c)} />)}
        </View>
      )}
      <View className="w-full flex-row flex-wrap justify-center gap-s2">
        {choices.length ? <Button kind="ghost" size="sm" label={typing ? "Pick from three sets" : "Type the three words"} onPress={() => setTyping(!typing)} /> : null}
        <Button kind="ghost" size="sm" label="Not the same" onPress={() => { session.reject(); onRejected(); }} />
      </View>
    </Card>
  );
}

export { openPairing };

/** A server asks its own person: this app shows the same three words and waits for the yes at the server. */
export function PairWatch({ session, who, onConfirmed, onRejected }: { session: PairingSession; who: string; onConfirmed: () => void; onRejected: (say: string) => void }) {
  useEffect(() => {
    let live = true;
    session.confirm().then(() => { if (live) onConfirmed(); }).catch((e: Error) => { if (live) onRejected(e.message === "rejected" ? COPY.rejected : (e as { code?: string }).code ? pairSayHere(serverSay(e)) : e.message || COPY.ended); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  return (
    <Card className="w-full items-center gap-s3">
      <Text strong className="text-center">{`${who} is asking to pair.`}</Text>
      <Text mono size="title" strong className="text-center">{wordsLine(session.words())}</Text>
      <Text tone="muted" className="text-center">Say yes at the server only if it shows the same three words.</Text>
      <Button kind="ghost" size="sm" label="Not the same" onPress={() => { session.reject(); onRejected(COPY.rejected); }} />
    </Card>
  );
}

/**
 * The words step for a SERVER: a "watch" session (the real one) is started here and shows the three words once the server has answered, then waits for the yes at the server;
 * any other session (the mock) asks the person to pick or type the words as before.
 */
export function PairServer({ session, who, onConfirmed, onRejected }: { session: PairingSession; who: string; onConfirmed: () => void; onRejected: (say?: string) => void }) {
  const [ready, setReady] = useState(session.kind !== "watch" || !session.ready);
  useEffect(() => {
    if (ready) return;
    let live = true;
    session.ready!().then(() => { if (live) setReady(true); }).catch((e: Error) => { if (live) onRejected(pairSayHere(serverSay(e))); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  if (session.kind !== "watch") return <PairWords session={session} who={who} onConfirmed={onConfirmed} onRejected={() => onRejected()} />;
  if (!ready) return <Card className="w-full items-center gap-s3"><Text tone="muted" className="text-center">Pairing with your server. This takes a few seconds.</Text></Card>;
  return <PairWatch session={session} who={who} onConfirmed={onConfirmed} onRejected={(say) => onRejected(say)} />;
}
