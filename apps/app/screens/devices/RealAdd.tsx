import { useEffect, useMemo, useRef, useState } from "react";
import { serverSay } from "../install/flow.js";
import { pairSayHere } from "../../src/real/pair-say";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Text } from "@vyre/ui";
import { Page } from "../places/Frame";
import { said, tool } from "../../src/real/box";
import { phoneAnswerSession, serverSession, type Target } from "../../src/real/pairing";
import type { PairingSession } from "../../src/api/pairing-session";
import { PairEntry, PairWatch, PairWords, type LongCode } from "./PairParts";
import { phoneAsk, targetsOf } from "./real.js";
import { COPY, stepWords, type DeviceKind } from "./wink.js";
import { useDevices } from "./state";
import { WinkCode } from "../../src/ui/WinkCode";
import { AckCode } from "./TypeCode";
import { leftOf } from "./typed-model.js";

type Opened = { qr: string | null; code?: string | null; code_expires?: number | null; code_offer?: string | null; link?: string; art?: string; expires?: number };
type Ask = { name: string; line: string; words: [string, string, string] };

/**
 * Adding a device against the real box: only the side this device is. A server: scan or paste what it printed, see the three words, say yes
 * at the server. A phone or computer: show the code, type the three words the new device shows. Nothing is added until the box says so.
 */
export function RealAdd({ kind, onBack, onDone, first }: { kind: DeviceKind; onBack: () => void; onDone: () => void; first?: { title: string; sub: string; skipLabel: string; onSkip: () => void } }) {
  const load = useDevices((s) => s.load);
  const [said1, setSaid] = useState("");
  const [session, setSession] = useState<PairingSession | null>(null);
  const [done, setDone] = useState(false);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const answerer = useMemo(() => (ask ? phoneAnswerSession(ask.words) : null), [ask]);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  // A server pairs to you or to a space you administer.
  useEffect(() => {
    if (kind !== "server") return;
    tool("wink.pair.targets").then((d) => { const t = targetsOf(d); setTargets(t); setTarget(t[0] ?? null); }).catch((e) => setSaid(said(e)));
  }, [kind]);

  // A phone or computer: poll for the new device asking, every 2 s while the code is up.
  useEffect(() => {
    if (kind === "server" || !opened || done || ask) return;
    const t = setInterval(() => {
      tool("wink.phone.pairing").then((r) => { const a = phoneAsk(r); if (a.asking && live.current) setAsk({ name: a.name, line: a.line, words: a.words }); }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [kind, opened, done, ask]);

  // First run: the code is up as soon as the screen is, with Skip in place of Back.
  const auto = useRef(false);
  useEffect(() => { if (first && kind !== "server" && !auto.current) { auto.current = true; showCode(); } });
  const reset = (say = "") => { setSession(null); setAsk(null); setOpened(null); setSaid(say); };
  const finish = () => { setDone(true); void load(); };

  const gotServerCode = (c: LongCode) => {
    if (!target) { setSaid("There is nothing here to pair the server to."); return; }
    const s = serverSession(c, target);
    setSaid("");
    setBusy(true);
    s.ready!().then(() => { if (live.current) setSession(s); }).catch((e: Error) => reset((e as { code?: string }).code ? pairSayHere(serverSay(e)) : e.message || COPY.ended)).finally(() => setBusy(false));
  };
  const showCode = () => {
    setBusy(true);
    tool<Opened>("wink.phone.open", {}).then((o) => { setOpened(o); setSaid(""); }).catch((e) => setSaid(said(e))).finally(() => setBusy(false));
  };

  const noun = kind === "phone" ? "phone" : kind === "server" ? "server" : "computer";
  let body: React.ReactNode;
  if (done) {
    body = <Card className="items-center gap-s3"><Chip tone="ok" icon="check">Done</Chip><Text strong>{`The ${noun} is added`}</Text><Button size="sm" label="Done" onPress={onDone} /></Card>;
  } else if (kind === "server") {
    body = session
      ? <PairWatch session={session} who={`A ${noun}`} onConfirmed={finish} onRejected={(say) => reset(say)} />
      : <Card className="gap-s3">
          <Text strong>Scan it, or paste the long code</Text>
          <Text tone="muted">It shows a code when it is ready. Scan it, or paste the long code.</Text>
          {targets.length > 1 ? <View className="flex-row flex-wrap gap-s2">{targets.map((t) => <Button key={t.id} size="sm" kind={target?.id === t.id ? "primary" : "secondary"} label={t.kind === "identity" ? "You" : t.label} onPress={() => setTarget(t)} />)}</View> : null}
          {busy ? <Text tone="muted">Asking your Vyre.</Text> : <PairEntry onCode={gotServerCode} />}
        </Card>;
  } else if (ask) {
    body = <PairWords session={answerer!} who={ask.name} onConfirmed={finish} onRejected={() => reset(COPY.rejected)} />;
  } else if (opened) {
    body = (
      <Card className="items-center gap-s3">
        <Text strong>{`Open Vyre on the ${noun}, then scan this or paste the long code.`}</Text>
        {opened.qr ? <WinkCode text={opened.qr} kind="device" typed={opened.code ?? null} expires={opened.code_expires ?? null} /> : null}
        {opened.qr ? <Text mono size="caption" selectable className="w-full text-center" style={{ wordBreak: "break-all" } as never}>{opened.qr}</Text> : <Text tone="warn">The relay could not take the code. Try again.</Text>}
        {opened.code && opened.code_offer ? <AckCode offer={opened.code_offer} onDone={() => setDone(true)} /> : null}
        <Text tone="muted">{(() => { const l = leftOf(opened.code_expires ?? opened.expires ?? null, Date.now()); return l ? `Waiting for the new device. Good for ${l}.` : "Waiting for the new device."; })()}</Text>
      </Card>
    );
  } else {
    body = <Card className="items-center gap-s3"><Text tone="muted" className="text-center">{stepWords(kind, 0)}</Text><Button kind="primary" icon="plus" label={`Show the code for a ${noun}`} loading={busy} onPress={showCode} /></Card>;
  }
  if (first) {
    return (
      <View className="gap-s4">
        <View className="gap-s1"><Text size="page" strong>{first.title}</Text><Text tone="muted">{first.sub}</Text></View>
        {said1 ? <Banner tone="warn">{said1}</Banner> : null}
        {body}
        {done ? null : <Button kind="ghost" label={first.skipLabel} onPress={first.onSkip} />}
      </View>
    );
  }
  return (
    <Page title={`Add a ${noun}`} sub={kind === "server" ? "Scan or paste, then say yes at the server" : "Scan or paste on the new device, then type its three words"}>
      {said1 ? <Banner tone="warn">{said1}</Banner> : null}
      {body}
      <View className="flex-row justify-center"><Button kind="ghost" size="sm" icon="chevron-left" label="Back" onPress={onBack} /></View>
    </Page>
  );
}
