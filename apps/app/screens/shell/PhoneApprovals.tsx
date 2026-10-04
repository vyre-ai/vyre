// The phone's cards for "Approve on your phone": what a web session asked, shown as given, with Approve (Face ID signs it) and No. Read when Now opens, when the app comes to the front
// and once a minute while it is open; never faster. A phone build without the key module says so and offers no Approve.
import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { Button, Card, Divider, Row, Text, showToast } from "@vyre/ui";
import { call } from "../../src/api/box";
import { phoneSigner } from "../../src/real/phone-signer";
import { proofHeader } from "../../src/real/approvals.js";
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
  const load = useCallback(() => { ask("approvals.pending", {}).then((a) => setCards(cardsFrom(a))).catch(() => setCards([])); }, []);
  useEffect(() => {
    if (Platform.OS === "web") return;
    load();
    void phoneSigner().then((s) => setCanSign(!!s));
    const t = setInterval(load, 60_000);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") load(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [load]);
  if (Platform.OS === "web" || !cards.length) return null;
  const approve = async (c: Pending) => {
    setBusy(c.id);
    try { await approveCard(c, await phoneSigner(), ask, proofHeader); showToast("Approved."); }
    catch (e) { showToast(answerRefusal((e as { code?: string }).code)); }
    finally { setBusy(""); load(); }
  };
  const no = async (c: Pending) => { setBusy(c.id); await refuseCard(c, ask).catch(() => {}); setBusy(""); load(); };
  return (
    <View className="gap-s2 px-s4 pb-s3">
      <Text size="caption" strong tone="label">Waiting for your approval</Text>
      <Card flush>
        {cards.map((c, i) => (
          <View key={c.id}>{i ? <Divider /> : null}
            <Row title={c.title} sub={askedLine(c)} />
            <View className="gap-s1 px-s4 pb-s2">
              {factLines(c).map((l) => <Text key={l} size="caption" tone="label" mono>{l}</Text>)}
              <View className="flex-row gap-s2 pt-s2">
                {canSign ? <Button kind="primary" size="sm" icon="faceid" label={busy === c.id ? "Waiting" : "Approve"} onPress={busy ? () => {} : () => void approve(c)} /> : <Text size="caption" tone="label">This phone cannot approve yet. Update Vyre.</Text>}
                <Button kind="ghost" size="sm" label="No" onPress={busy ? () => {} : () => void no(c)} />
              </View>
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}
