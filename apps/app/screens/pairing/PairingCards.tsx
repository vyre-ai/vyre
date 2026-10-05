import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { AskCard, Banner, Field, Text } from "@vyre/ui";
import { listen } from "../../src/api/box";
import { callT } from "../../src/real/call-tool";
import { phoneAnswerSession } from "../../src/real/pairing";
import { PairWords } from "../devices/PairParts";
import { pairingSource } from "./source";
import { APPROVING, EXPIRED, PAIR_EVENTS, canApprove, deniedLine, leftLine, minutesLeft, pairSay, pairedLine, shape, visible, type PairRequest } from "./model";

const source = pairingSource(callT);

/** One request: which computer, the code field the person types, Approve, Deny. Approve asks for the person's passkey through the app's own door. */
function PairCard({ r, now, onGone }: { r: PairRequest; now: number; onGone: (id: string, line: string) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const gone = minutesLeft(r.expires, now) <= 0;
  const approve = () => {
    setBusy(true); setSay(APPROVING);
    source.approve(code.replace(/\D/g, "")).then(() => onGone(r.id, pairedLine(r.name))).catch((e: { code?: string; message?: string }) => { setBusy(false); setSay(pairSay(e)); });
  };
  const deny = () => {
    setBusy(true); setSay("");
    source.deny(r.id).then(() => onGone(r.id, deniedLine(r.name))).catch((e: { code?: string; message?: string }) => { setBusy(false); setSay(pairSay(e)); });
  };
  return (
    <AskCard
      title={`${r.name} wants to pair`}
      why={[r.sub, leftLine(r.expires, now)].filter(Boolean).join(" · ")}
      actions={[
        { label: "Approve", kind: "primary", loading: busy, disabled: gone || !canApprove(code), onPress: approve },
        { label: "Deny", kind: "ghost", disabled: busy, onPress: deny },
      ]}
    >
      <Field label="The code on that computer" name="Pairing code" value={code} onChangeText={(t: string) => setCode(shape(t))} placeholder="123-456" mono />
      {gone ? <Text tone="warn">{EXPIRED}</Text> : say ? <Text tone="muted">{say}</Text> : null}
    </AskCard>
  );
}

/**
 * Computers asking to pair, as cards on Now: the ones that ask the box (link.pending, the person types the code the computer shows) and a new
 * device asking over Wink (three words to confirm). Renders nothing when none is waiting or the box has no pairing. Nothing polls but the
 * once-a-minute redraw of the minutes left, and only while a request is on screen.
 */
export function PairingCards({ onPaired }: { onPaired?: (name: string) => void }) {
  const [rows, setRows] = useState<PairRequest[]>([]);
  const [wink, setWink] = useState<{ name: string; words: [string, string, string] } | null>(null);
  const [notes, setNotes] = useState<{ id: string; line: string }[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const done = useRef(new Set<string>());
  const live = useRef(true);
  const load = useCallback(async () => {
    const [p, w] = await Promise.all([source.pending(), source.winkAsk()]);
    if (!live.current) return;
    setRows(p); setWink(w);
  }, []);
  useEffect(() => { live.current = true; void load(); const off = listen((e: { type?: string }) => { if (PAIR_EVENTS.test(String(e?.type || ""))) void load(); }); return () => { live.current = false; off(); }; }, [load]);
  const shown = visible(rows, now, done.current);
  useEffect(() => {
    if (!shown.length) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [shown.length]);
  const answerer = useMemo(() => (wink ? phoneAnswerSession(wink.words) : null), [wink]);
  const gone = (id: string, line: string) => { done.current.add(id); setNotes((n) => [...n, { id, line }]); if (/is paired/.test(line)) onPaired?.(rows.find((x) => x.id === id)?.name ?? ""); void load(); };
  if (!shown.length && !wink && !notes.length) return null;
  return (
    <View className="gap-s3">
      {notes.map((n) => <Banner key={n.id}>{n.line}</Banner>)}
      {shown.map((r) => <PairCard key={r.id} r={r} now={now} onGone={gone} />)}
      {wink && answerer ? <PairWords session={answerer} who={wink.name} onConfirmed={() => { setWink(null); void load(); }} onRejected={() => { setWink(null); void load(); }} /> : null}
    </View>
  );
}
