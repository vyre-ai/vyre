import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Field, Text } from "@vyre/ui";
import { joinWithCode, redeemInviteCode } from "@vyre/relay-client/join.js";
import { about, presenceKey, relayCrypto, relayKeyStore } from "../../src/api/relay";
import { afterPaired, serverPairInputs } from "../../src/real/pairing";
import { tool } from "../../src/real/box";
import { relayUrl } from "../../src/api/relay-url";
import { parseWinkCode } from "../../src/api/wink-code";
import { avatarBytesToCode } from "@vyre/relay-client/avatarcode.js";
import { DRAWN_CODE_SCAN } from "../install/first-run.js";
import { WinkScan, canReadDrawnCode } from "../../src/native/WinkScan";
import { SCAN_SAY, type WinkScanEvent } from "../../src/native/wink-scan-model";
import { TYPED, inviteReasonSay, leftOf, redeemSay } from "./typed-model.js";
import { RC } from "../shell/rc";

/** What a finished typing gives back: an invitation's link, to accept as a pasted one is. */
export type Typed = { invite?: { link: string; space?: string } };

/** A typed invite code redeemed over the relay by the client library (relay/client/join.js): a device with no box of its own can do it. Rejects with the words to show. */
export async function redeemInvite(code: string, onAck: (ack: string, expires?: number) => void): Promise<Typed> {
  const r = await redeemInviteCode({ relay: relayUrl(), input: code, onAck });
  if (!r.ok) throw new Error(inviteReasonSay(r.reason));
  return { invite: { link: r.link, ...(r.space ? { space: r.space } : {}) } };
}

/**
 * A browser or phone with no box pairs to the person's server by the code the phone's Devices, Add a device screen shows (relay/client/join.js joinWithCode). The ack typed back on the phone is the
 * yes; the pairing is kept so this device reaches that server.
 */
export async function redeemPairing(code: string, onAck: (ack: string, expires?: number) => void): Promise<Typed> {
  // A server's typed code ends in the server's own adopt (who will own it, and the proof); a device that holds a name sends it, or the server stays unowned and lets the device go.
  const inputs = await serverPairInputs();
  const r = await joinWithCode({ relay: relayUrl(), input: code, name: about.kind === "web" ? "Vyre in a browser" : "Vyre on this phone", onState: (s: { state: string; code?: string; expires?: number }) => { if (s.state === "ack" && s.code) onAck(s.code, typeof s.expires === "number" ? s.expires : undefined); },
    pairOptions: { crypto: relayCrypto(), keyStore: relayKeyStore(), about, presenceKey: inputs?.presenceKey ?? await presenceKey(), deviceKind: inputs?.deviceKind ?? (about.kind === "web" ? "web" : "phone"), keyStorage: inputs?.keyStorage ?? "software" },
    ...(inputs ? { server: { owner: inputs.owner, signIdentity: inputs.signIdentity, deviceKind: inputs.deviceKind, keyStorage: inputs.keyStorage, crypto: relayCrypto(), keyStore: relayKeyStore() } } : {}) });
  if (!r.ok) throw new Error(("message" in r && r.message) || inviteReasonSay(r.reason === "closed" ? "refused" : r.reason === "needs_identity" ? "refused" : r.reason));
  await afterPaired(r.paired);
  return {};
}

/**
 * "Type the code" on the second device: the code the first device shows (WINK-NNPP-PPPP), then the ack code to type back on that device, then it carries on. `redeem` does the work and calls
 * `onAck` with the code to show; nothing is joined until it resolves.
 */
type TypeCodeProps = { redeem: (code: string, onAck: (ack: string, expires?: number) => void) => Promise<Typed>; initial?: string; onDone: (t: Typed) => void };
/** The short two-sided typed code, and nothing at all while it is switched off (RC.typedCode): a release build shows no field, no scan and no ack box. */
export function TypeCode(p: TypeCodeProps) { return RC.typedCode ? <TypeCodeOn {...p} /> : null; }

function TypeCodeOn({ redeem, initial = "", onDone }: { redeem: (code: string, onAck: (ack: string, expires?: number) => void) => Promise<Typed>; initial?: string; onDone: (t: Typed) => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const [ack, setAck] = useState("");
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => { if (!ack) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [ack]);

  const [reading, setReading] = useState(false);
  const [hint, setHint] = useState("");
  const canScan = DRAWN_CODE_SCAN && canReadDrawnCode;
  // The camera reads the drawn code, which carries the same eight symbols a person would type (relay/client/avatarcode.js): from here it is the typed code's own pairing.
  const onScan = (e: WinkScanEvent) => {
    if (e.type === "slow") { setHint(SCAN_SAY.slow); return; }
    setReading(false);
    if (e.type === "error") { setHint(SCAN_SAY[e.code]); return; }
    if (e.type !== "ticket") return;
    const code = avatarBytesToCode(e.ticket);
    if (!code) { setHint(""); setSay(SCAN_SAY.not_a_code); return; }
    setHint(""); setText(code); void go(code);
  };

  const go = async (given?: string) => {
    const c = parseWinkCode(given ?? text);
    if (!c.ok || c.kind !== "typed") { setSay(redeemSay("bad_input")); return; }
    setBusy(true); setSay("");
    try {
      // The code's own end is the server's to say (it travels with the ack); when it says none, no time is claimed.
      const t = await redeem(c.code, (a, expires) => { if (live.current) { setAck(a); setUntil(typeof expires === "number" ? expires : null); } });
      if (live.current) onDone(t);
    } catch (e) {
      if (!live.current) return;
      setAck(""); setSay((e as Error).message || redeemSay("refused"));
    } finally { if (live.current) setBusy(false); }
  };

  if (busy) {
    const left = leftOf(until, now);
    return (
      <Card className="items-center gap-s3">
        {ack ? <><Text mono strong size="title" selectable className="text-center">{ack}</Text><Text tone="muted" className="text-center">{TYPED.ackLine}</Text></> : <Text tone="muted">{TYPED.busy}</Text>}
        {ack ? <Text tone="muted">{TYPED.waiting}</Text> : null}
        {left ? <Text size="caption" tone="label">{`Good for ${left}`}</Text> : null}
      </Card>
    );
  }
  return (
    <View className="w-full gap-s2">
      {say ? <Banner tone="warn">{say}</Banner> : null}
      {canScan ? (reading
        ? <View className="w-full gap-s2"><View className="h-72 w-full overflow-hidden rounded-card"><WinkScan onEvent={onScan} /></View>{hint ? <Text size="caption" tone="muted">{hint}</Text> : null}<Button kind="ghost" size="sm" label="Stop scanning" onPress={() => { setReading(false); setHint(""); }} /></View>
        : <View className="w-full gap-s2"><Button kind="primary" label="Scan the code" onPress={() => { setHint(""); setSay(""); setReading(true); }} />{hint ? <Text size="caption" tone="muted">{hint}</Text> : null}</View>) : null}
      <Field label={TYPED.label} name="Typed code" value={text} onChangeText={(v) => { setText(v); if (say) setSay(""); }} placeholder="WINK-7K4Q-M2XD" mono help={TYPED.help} />
      <View className="flex-row"><Button kind="primary" size="sm" label={TYPED.go} disabled={!text.trim()} onPress={() => void go()} /></View>
    </View>
  );
}

/** On the SHOWING device: the code the other device now shows, typed back to say it is the right one (wink.code.ack; a yes moment). */
export function AckCode(p: { offer: string; onDone: () => void }) { return RC.typedCode ? <AckCodeOn {...p} /> : null; }

function AckCodeOn({ offer, onDone }: { offer: string; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const go = async () => {
    setBusy(true); setSay("");
    try { await tool("wink.code.ack", { offer, typed: typed.trim() }); onDone(); } catch (e) { setSay(redeemSay((e as { code?: string }).code)); } finally { setBusy(false); }
  };
  return (
    <View className="w-full gap-s2">
      {say ? <Banner tone="warn">{say}</Banner> : null}
      <Field label={TYPED.ackFieldLabel} name="Code on the other device" value={typed} onChangeText={setTyped} placeholder="WINK-7K4Q-M2XD" mono />
      <View className="flex-row"><Button kind="primary" size="sm" label={busy ? TYPED.busy : TYPED.ackGo} disabled={busy || !typed.trim()} onPress={() => void go()} /></View>
    </View>
  );
}
