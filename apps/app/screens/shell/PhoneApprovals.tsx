// The phone's cards for "Approve on your phone": what a web session asked, shown as given, with Approve (Face ID signs it) and No. Read when Now opens, when the app comes to the front
// and once a minute while it is open; never faster. A phone build without the key module says so and offers no Approve.
import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { Button, Card, Divider, Row, Text, showToast } from "@vyre/ui";
import { call, listen } from "../../src/api/box";
import { phoneSigner } from "../../src/real/phone-signer";
import { proofHeader } from "../../src/real/approvals.js";
import { ASK_BODY, ALLOW, DONT_ALLOW, answerSession, askTitle, sessionRefusal, withAsk, withPending, type SessionAsk } from "../../src/real/session-asks.js";
import { answerRefusal, approveCard, askedLine, cardsFrom, factLines, refuseCard, type Pending } from "../../src/real/phone-approve.js";

const ask = async (tool: string, input: Record<string, unknown>, o?: { kernelProof?: string }) => {
  const r = await call<any>(tool, input, o);
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return r.data;
};

export function PhoneApprovals() {
  const [cards, setCards] = useState<Pending[]>([]);
  const [canSign, setCanSign] = useState<boolean | null>(null);
  const [busy, setBusy] = useState("");
  const [asks, setAsks] = useState<SessionAsk[]>([]);
  // A browser asking to sign in (presence.session-asked): kept for its five minutes, then dropped.
  useEffect(() => {
    if (Platform.OS === "web") return;
    const off = listen((e) => setAsks((l) => withAsk(l, e as { type?: string; payload?: unknown }, Date.now())));
    const t = setInterval(() => setAsks((l) => withAsk(l, {}, Date.now())), 30_000);
    return () => { off(); clearInterval(t); };
  }, []);
  const answer = async (a: SessionAsk, yes: boolean) => {
    setBusy(a.id);
    try { showToast(await answerSession(a, yes, ask)); setAsks((l) => l.filter((x) => x.id !== a.id)); }
    catch (e) { const code = (e as { code?: string }).code; showToast(sessionRefusal(code)); if (code === "expired" || code === "none" || code === "not_found") setAsks((l) => l.filter((x) => x.id !== a.id)); }
    finally { setBusy(""); }
  };
  const load = useCallback(() => {
    ask("approvals.pending", {}).then((a) => setCards(cardsFrom(a))).catch(() => setCards([]));
    // Browser sign-in asks made while the app was closed (presence.person.session-pending); a box without the tool gives nothing.
    ask("presence.person.session-pending", {}).then((a) => setAsks((l) => withPending(l, a, Date.now()))).catch(() => {});
  }, []);
  useEffect(() => {
    if (Platform.OS === "web") return;
    load();
    void phoneSigner().then((s) => setCanSign(!!s));
    const t = setInterval(load, 60_000);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") load(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [load]);
  if (Platform.OS === "web" || (!cards.length && !asks.length)) return null;
  const approve = async (c: Pending) => {
    setBusy(c.id);
    try {
      const me = await ask("records.me", {}).catch(() => null);
      const person = typeof me?.person === "string" ? me.person : me?.person?.id ?? "";
      await approveCard(c, await phoneSigner(), ask, proofHeader, person);
      showToast("Approved.");
    }
    catch (e) { showToast(answerRefusal((e as { code?: string }).code)); }
    finally { setBusy(""); load(); }
  };
  const no = async (c: Pending) => { setBusy(c.id); await refuseCard(c, ask).catch(() => {}); setBusy(""); load(); };
  return (
    <View className="gap-s2 px-s4 pb-s3">
      <Text size="caption" strong tone="label">Waiting for your approval</Text>
      <Card flush>
        {asks.map((a, i) => (
          <View key={a.id}>{i ? <Divider /> : null}
            <Row title={askTitle(a)} sub={ASK_BODY} />
            <View className="flex-row gap-s2 px-s4 pb-s3 pt-s1">
              <Button kind="primary" size="sm" icon="faceid" label={busy === a.id ? "Waiting" : ALLOW} disabled={!!busy} onPress={() => void answer(a, true)} />
              <Button kind="ghost" size="sm" label={DONT_ALLOW} disabled={!!busy} onPress={() => void answer(a, false)} />
            </View>
          </View>
        ))}
        {asks.length && cards.length ? <Divider /> : null}
        {cards.map((c, i) => (
          <View key={c.id}>{i ? <Divider /> : null}
            <Row title={c.title} sub={c.body || "Approving makes this change. Nothing changes until you do."} />
            <View className="gap-s1 px-s4 pb-s2">
              {askedLine(c) ? <Text size="caption" tone="label">{askedLine(c)}</Text> : null}
              {factLines(c).length ? <Text size="caption" strong tone="label">What you are signing</Text> : null}
              {factLines(c).map((l) => <Text key={l} size="caption" tone="label" mono>{l}</Text>)}
              <View className="flex-row gap-s2 pt-s2">
                {canSign ? <Button kind="primary" size="sm" icon="faceid" label={busy === c.id ? "Waiting" : "Approve"} disabled={!!busy} onPress={() => void approve(c)} /> : <Text size="caption" tone="label">This phone cannot approve yet. Update Vyre.</Text>}
                <Button kind="ghost" size="sm" label="Deny" disabled={!!busy} onPress={() => void no(c)} />
              </View>
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}
