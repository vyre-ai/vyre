// The current one-time code for a Vault item that has one. The person asks; vault.totp answers; the digits stay up and the count runs down from that answer. A new answer is asked only when the period ends. The secret is never read here.
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Button, Text } from "@vyre/ui";
import { groupDigits, secondsLeft } from "./live-code.js";

type Snap = { code: string; period: number; remaining: number; at: number };

export function LiveCode({ load }: { load: () => Promise<{ code: string; period: number; remaining: number }> }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const snapRef = useRef<Snap | null>(null);
  const busyRef = useRef(false);
  snapRef.current = snap;

  const pull = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr("");
    try {
      const r = await load();
      const at = Date.now();
      const next = { code: String(r.code ?? ""), period: r.period, remaining: r.remaining, at };
      snapRef.current = next;
      setSnap(next);
      setLeft(secondsLeft(next, at));
    } catch (e) {
      setErr(String((e as Error)?.message || "The code did not load."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!snap) return undefined;
    const t = setInterval(() => {
      const s = snapRef.current;
      if (!s) return;
      const n = secondsLeft(s, Date.now());
      setLeft(n);
      if (n === 0) void pull();
    }, 1000);
    return () => clearInterval(t);
  }, [snap?.at]);

  return (
    <View className="gap-s2 pt-s2">
      {snap?.code ? (
        <View className="gap-s1">
          <Text size="caption" tone="label">Current code</Text>
          <Text mono size="headline" selectable>{groupDigits(snap.code)}</Text>
          <Text size="caption" tone="label">{left === 1 ? "1 second left" : `${left} seconds left`}</Text>
        </View>
      ) : null}
      {err ? <Text size="caption" tone="label">{err}</Text> : null}
      <View className="self-start">
        <Button kind="secondary" size="sm" label={busy ? "Getting the code" : snap ? "Refresh" : "Show the code"} disabled={busy} onPress={() => void pull()} />
      </View>
    </View>
  );
}
