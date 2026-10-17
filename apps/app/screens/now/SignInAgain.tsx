// "Sign in again" on Now (G26): one calm card for each website login that ran out, security check, missing browser or refused key. The box writes the cards (approvals.items, kind signin); the buttons are its own answers.
import { useCallback, useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Icon, Text } from "@vyre/ui";
import { call } from "../../src/api/box";
import { afterCheck, deviceCards, signinCards, type SignInCard } from "../../src/real/signin-again.js";
import { dayTimeOf } from "../../src/time/show.js";

/** One card, drawn from its words and buttons (the gallery draws it from a sample). */
export function SignInView({ card, busy, hint, onPress }: { card: SignInCard; busy: boolean; hint: string; onPress: (i: number) => void }) {
  return (
    <Card>
      <View className="gap-s2">
        <View className="flex-row items-center gap-s2"><Icon name="warning" tone="label" /><Text strong>{card.title}</Text></View>
        {card.detail ? <Text tone="label">{card.detail}</Text> : null}
        {card.id.startsWith("signins:") && card.at ? <Text tone="label">{dayTimeOf(card.at)}</Text> : null}
        {hint ? <Text tone="label">{hint}</Text> : null}
        <View className="flex-row flex-wrap gap-s2 pt-s1">
          {card.buttons.map((b, i) => <Button key={b.label} kind={i === 0 ? "primary" : "secondary"} label={busy && i === 0 ? (b.tool === "identity.signin.revoke" ? "Signing out" : "Checking") : b.label} disabled={busy} onPress={() => onPress(i)} />)}
        </View>
      </View>
    </Card>
  );
}

export function SignInAgain() {
  const router = useRouter();
  const [cards, setCards] = useState<SignInCard[]>([]);
  const [busy, setBusy] = useState("");
  const [hints, setHints] = useState<Record<string, string>>({});
  const load = useCallback(() => {
    // The box's own sign-in cards, and the person's own sign-ins on a new device (the box answers for whoever is asking, so each person sees theirs); either may be missing on an older box.
    void Promise.all([
      call<any>("approvals.items", {}).then((r) => (r.error ? [] : signinCards(r.data))).catch(() => [] as SignInCard[]),
      call<any>("identity.signins.pending", {}).then((r) => (r.error ? [] : deviceCards(r.data))).catch(() => [] as SignInCard[]),
    ]).then(([a, b]) => setCards([...a, ...b]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") load(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [load]);
  if (!cards.length) return null;
  const press = async (c: SignInCard, i: number) => {
    const b = c.buttons[i];
    if (b.open) { router.push(b.open as never); return; }
    if (!b.tool) return;
    setBusy(c.id);
    const r = await call<any>(b.tool, b.input ?? {}).catch(() => null);
    setHints((h) => ({ ...h, [c.id]: r && !r.error ? afterCheck(r.data) : "That did not go through. Try again." }));
    setBusy("");
    load();
  };
  return (
    <View className="gap-s2 px-s4 pb-s3">
      {cards.map((c) => <SignInView key={c.id} card={c} busy={busy === c.id} hint={hints[c.id] ?? ""} onPress={(i) => void press(c, i)} />)}
    </View>
  );
}
