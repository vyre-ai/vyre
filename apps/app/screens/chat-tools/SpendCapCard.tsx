// The thread paused on a daily spend cap: say so, and offer to raise it (or take it off) right in the chat. The provider is the event's own field, checked as a name.
import { useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Field, Icon, Text } from "@vyre/ui";
import { moreTools } from "./instance";
import { capLine, providerOf, suggestedCap } from "./more-model.ts";

export function SpendCapCard({ data, onRaised }: { data: { provider?: string; cap?: number; line?: string; action?: { label?: string; input?: { to?: number } } }; onRaised?: (cap: number | null) => void }) {
  const provider = providerOf(data?.provider);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(suggestedCap(data)));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [raised, setRaised] = useState<number | null | undefined>(undefined);
  const go = async (raw: string | null) => {
    if (!provider) return;
    setBusy(true); setProblem("");
    const r = await moreTools.raiseCap(provider, raw);
    setBusy(false);
    if (r.ok) { setRaised(r.cap); setOpen(false); onRaised?.(r.cap); } else setProblem(r.reason);
  };
  const line = raised !== undefined ? capLine(provider, raised) : String(data?.line || "This thread is paused: the daily spend cap was reached.");
  return (
    <Card>
      <View className="flex-row items-center gap-s2">
        <Icon name={raised !== undefined ? "check" : "clock"} tone="text-2" />
        <View className="min-w-0 flex-1"><Text>{line}</Text></View>
        {raised === undefined && !open && provider ? <Button size="sm" label={String(data?.action?.label || "Raise it")} onPress={() => setOpen(true)} /> : null}
      </View>
      {open ? (
        <View className="gap-s2 pt-s2">
          <Field label="Daily cap, dollars" value={amount} onChangeText={setAmount} kind="number" />
          <View className="flex-row gap-s2">
            <Button kind="primary" size="sm" label={busy ? "Raising" : "Raise"} disabled={busy} onPress={() => go(amount)} />
            <Button size="sm" label="No cap" disabled={busy} onPress={() => go(null)} />
            <Button kind="ghost" size="sm" label="Cancel" onPress={() => { setOpen(false); setProblem(""); }} />
          </View>
        </View>
      ) : null}
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
    </Card>
  );
}
