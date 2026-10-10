// The phone's cards for "Approve on your phone": what a web session asked, shown as given, with Approve (Face ID signs it) and No. Read when Now opens, when the app comes to the front
// and once a minute while it is open; never faster. A phone build without the key module says so and offers no Approve.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { Button, Card, Divider, Icon, Row, Text, showToast } from "@vyre/ui";
import { call } from "../../src/api/box";
import { phoneSigner } from "../../src/real/phone-signer";
import { shellSigner } from "../../src/real/shell-signer";
import { shellIdentity } from "../../src/shell/shell";
import { proofHeader } from "../../src/real/approvals.js";
import { howWord } from "../../src/real/on-phone.js";
import { answerRefusal, approveCard, askedLine, cardsFrom, factLines, refuseCard, type Pending } from "../../src/real/phone-approve.js";
import { singlesFrom } from "../../src/real/group-approve.js";
import { answerFromNotice, wantKey } from "../../src/real/notice-act.js";
import { GroupApprovals } from "./GroupApprovals";

const ask = async (tool: string, input: Record<string, unknown>, o?: { kernelProof?: string }) => {
  const r = await call<any>(tool, input, o);
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return r.data;
};

/** The key that says yes on this device: the phone's, or on a Mac or Windows app the computer's hardware key (Touch ID, Windows Hello). */
const signer = async () => (await phoneSigner()) ?? (await shellSigner());

/** What a notice's button left: the answer in words, kept on Now until the person has read it. */
export function NoticeAnswered({ say, kind, onClose }: { say: string; kind: "approved" | "denied" | "gone" | "failed"; onClose: () => void }) {
  const more = kind === "approved" ? "It went out as you read it on the notice." : kind === "denied" ? "Nothing was sent." : kind === "gone" ? "Someone may have answered it already." : "The request is still waiting below.";
  return (
    <View className="px-s4 pb-s3">
      <Card>
        <View className="gap-s2">
          <View className="flex-row items-center gap-s2"><Icon name={kind === "approved" ? "check" : kind === "failed" ? "warning" : "x"} tone={kind === "approved" ? "accent" : "label"} /><Text strong>{say}</Text></View>
          <Text tone="label">{more}</Text>
          <View className="self-start pt-s1"><Button kind="ghost" label="Got it" onPress={onClose} /></View>
        </View>
      </Card>
    </View>
  );
}

/** `want` is what a notice's button asked (Approve or Deny on a card): it is answered here, once, by the same code as the buttons on the card. */
export function PhoneApprovals({ want }: { want?: { act: "approve" | "deny"; card?: string; group?: string } | null } = {}) {
  const [cards, setCards] = useState<Pending[]>([]);
  const [ready, setReady] = useState(false);
  const [noticed, setNoticed] = useState<{ say: string; kind: "approved" | "denied" | "gone" | "failed" } | null>(null);
  const answered = useRef("");
  const [raw, setRaw] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  const [canSign, setCanSign] = useState<boolean | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => { ask("approvals.pending", {}).then((a) => { setRaw(a); setCards(singlesFrom(a) as Pending[]); setReady(true); }).catch(() => { setCards([]); setReady(true); }); }, []);
  useEffect(() => {
    if (Platform.OS === "web" && !shellIdentity()) return;
    load();
    void signer().then((s) => setCanSign(!!s));
    const t = setInterval(load, 60_000);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") load(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [load]);
  useEffect(() => {
    if (!want || !ready || canSign === null || answered.current === wantKey(want)) return;
    answered.current = wantKey(want);
    void (async () => {
      const me = await ask("records.me", {}).catch(() => null);
      const person = typeof me?.person === "string" ? me.person : me?.person?.id ?? "";
      const r = await answerFromNotice(want, raw, { signer: await signer(), call: ask, header: proofHeader, person, how: howWord(Platform.OS) });
      setNoticed({ say: r.say, kind: r.kind });
      load(); setRound((n) => n + 1);
    })();
  }, [want, ready, canSign, raw, load]);
  if (Platform.OS === "web" && !shellIdentity()) return null;
  const said = noticed ? <NoticeAnswered say={noticed.say} kind={noticed.kind} onClose={() => setNoticed(null)} /> : null;
  if (!cards.length) return <>{said}<GroupApprovals key={round} /></>;
  const approve = async (c: Pending) => {
    setBusy(c.id);
    try {
      const me = await ask("records.me", {}).catch(() => null);
      const person = typeof me?.person === "string" ? me.person : me?.person?.id ?? "";
      await approveCard(c, await signer(), ask, proofHeader, person);
      showToast("Approved.");
    }
    catch (e) { showToast(answerRefusal((e as { code?: string }).code, howWord(Platform.OS))); }
    finally { setBusy(""); load(); }
  };
  const no = async (c: Pending) => { setBusy(c.id); await refuseCard(c, ask).catch(() => {}); setBusy(""); load(); };
  return (
    <View>
      {said}
      <GroupApprovals key={round} />
    <View className="gap-s2 px-s4 pb-s3">
      <Text size="caption" strong tone="label">Waiting for your approval</Text>
      <Card flush>
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
    </View>
  );
}
