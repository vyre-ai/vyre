// "Why do I know this": the turns behind a fact and the modules that taught it (memory.why). Quoted as said; with none left in the index it says so.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Sheet, Text, LoadingState } from "@vyre/ui";
import { whyReal } from "./extras";
import { whyOf, type WhyOut } from "./why-model";

export default function WhySheet({ fact, onClose }: { fact: { id: string; text: string } | null; onClose: () => void }) {
  const [out, setOut] = useState<WhyOut | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setOut(null); setErr("");
    if (!fact) return;
    let live = true;
    whyReal(fact.id).then((w) => { if (live) setOut(whyOf(w)); }).catch((e) => { if (live) setErr(e instanceof Error ? e.message : "The sources are not available."); });
    return () => { live = false; };
  }, [fact?.id]);
  return (
    <Sheet open={!!fact} onClose={onClose} title="Where this came from">
      {fact ? <Text size="read">{fact.text}</Text> : null}
      {err ? <Text tone="muted">{err}</Text> : !out ? <LoadingState rows={2} /> : (
        <View className="gap-s3">
          {out.threads.map((t) => (
            <View key={t.session} className="gap-s1">
              <Text strong size="secondary">{t.name}</Text>
              {t.turns.map((x, i) => <Text key={i} size="secondary">{`“${x.text}”`}<Text size="caption" tone="faint">{` ${x.who}${x.age ? `, ${x.age}` : ""}${x.seq != null ? `, turn ${x.seq}` : ""}`}</Text></Text>)}
            </View>
          ))}
          {out.taught.map((t, i) => <View key={i} className="gap-s1"><Text strong size="secondary">{`Taught by ${t.module}`}</Text>{t.text ? <Text size="secondary">{`“${t.text}”`}</Text> : null}</View>)}
          {out.empty ? <Text tone="muted">No turn behind this is still in the index.</Text> : null}
          {out.gone ? <Text size="caption" tone="faint">{out.gone}</Text> : null}
        </View>
      )}
    </Sheet>
  );
}
