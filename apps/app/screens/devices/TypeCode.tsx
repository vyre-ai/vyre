import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Field, Text } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { parseWinkCode } from "../../src/api/wink-code";
import { TYPED, leftOf, phaseOf, redeemSay } from "./typed-model.js";

/** What a finished typing gives back: an invitation's link, to accept as a pasted one is. */
export type Typed = { invite?: { link: string; space?: string } };

/**
 * "Type the code" on the second device: the code the first device shows (WINK-NNPP-PPPP), then the ack code to type back on that device, then the box says done.
 * `kind` is what the code is for: an invitation, or this device being added. Nothing is paired until wink.pair.status says done.
 */
export function TypeCode({ kind, initial = "", onDone }: { kind: "invite" | "phone"; initial?: string; onDone: (t: Typed) => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const [ack, setAck] = useState("");
  const [expires, setExpires] = useState<number | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const pairing = useRef<string | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => { if (!pairing.current) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [ack]);

  const poll = async (id: string) => {
    while (live.current && pairing.current === id) {
      await new Promise((r) => setTimeout(r, 2000));
      let p;
      try { p = phaseOf(await tool("wink.pair.status", { pairing: id })); } catch (e) { setSay(redeemSay((e as { code?: string }).code)); pairing.current = null; setAck(""); return; }
      if (!live.current || pairing.current !== id) return;
      if (p.phase === "done") { pairing.current = null; onDone({ ...(p.invite ? { invite: p.invite } : {}) }); return; }
      if (p.phase === "failed") { pairing.current = null; setAck(""); setWords([]); setSay(p.say ?? ""); return; }
      if (p.phase === "confirm") setWords(p.words ?? []);
      if (p.ack) setAck(p.ack);
    }
  };
  const go = async () => {
    const c = parseWinkCode(text);
    if (!c.ok || c.kind !== "typed") { setSay(redeemSay("bad_input")); return; }
    setBusy(true); setSay("");
    try {
      const r = await tool<{ pairing: string; ack?: string; expires?: number }>("wink.code.redeem", { code: c.code, for: kind });
      pairing.current = r.pairing; setAck(r.ack ?? ""); setExpires(typeof r.expires === "number" ? r.expires : null);
      void poll(r.pairing);
    } catch (e) { setSay(redeemSay((e as { code?: string }).code)); } finally { setBusy(false); }
  };

  if (pairing.current) {
    const left = leftOf(expires, now);
    return (
      <Card className="items-center gap-s3">
        {ack ? <><Text mono strong size="title" selectable className="text-center">{ack}</Text><Text tone="muted" className="text-center">{TYPED.ackLine}</Text></> : <Text tone="muted">{TYPED.waiting}</Text>}
        {words.length ? <Text mono strong className="text-center">{words.join(" ")}</Text> : null}
        {left ? <Text size="caption" tone="label">{`Good for ${left}`}</Text> : null}
      </Card>
    );
  }
  return (
    <View className="w-full gap-s2">
      {say ? <Banner tone="warn">{say}</Banner> : null}
      <Field label={TYPED.label} name="Typed code" value={text} onChangeText={(v) => { setText(v); if (say) setSay(""); }} placeholder="WINK-7K4Q-M2XD" mono help={TYPED.help} />
      <View className="flex-row"><Button kind="primary" size="sm" label={busy ? TYPED.busy : TYPED.go} disabled={busy || !text.trim()} onPress={() => void go()} /></View>
    </View>
  );
}

/** On the SHOWING device: the code the other device now shows, typed back to say it is the right one (wink.code.ack; a yes moment). */
export function AckCode({ offer, onDone }: { offer: string; onDone: () => void }) {
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
