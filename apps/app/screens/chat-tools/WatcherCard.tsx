// The watcher card (chat components, section 16): before a watcher runs on its own, the person reads what it will do and turns it on.
// When, Check, Then say it; the facts underneath are the runtime's own claims, drawn as given. Turn on carries the card's own hash, and a
// changed hash is refused: the card offers the new one and never turns on code the person did not read.
// Built for app-wire's transcript: render <WatcherCard name={...} /> where a watcher block lands.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, LoadingState, SectionLabel, Text } from "@vyre/ui";
import { moreTools } from "./instance";
import type { WatcherCard as Model } from "./more-model.ts";

const Line = ({ k, v }: { k: string; v: string }) => (v ? <View className="flex-row gap-s3"><View className="w-16"><Text size="caption" tone="label">{k}</Text></View><View className="min-w-0 flex-1"><Text>{v}</Text></View></View> : null);

export function WatcherCard({ name, readOnly, onDone }: { name: string; readOnly?: boolean; onDone?: () => void }) {
  const [card, setCard] = useState<Model | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none" | "changed">("loading");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => {
    setState("loading"); setProblem("");
    moreTools.watcherCard(name).then((c) => { setCard(c); setState(c ? "ready" : "none"); }).catch((e) => { setProblem(e instanceof Error ? e.message : "The card could not be read."); setState("none"); });
  }, [name]);
  useEffect(load, [load]);
  const act = async (a: "on" | "pause" | "resume") => {
    if (!card || busy) return;
    setBusy(true); setProblem("");
    const r = await moreTools.watcher(a, card);
    setBusy(false);
    if (r.ok) { setCard({ ...card, state: a === "pause" ? "paused" : "on" }); onDone?.(); } else if (r.changed) setState("changed"); else setProblem(r.reason);
  };
  if (state === "loading") return <Card><Text tone="muted">Reading what it will do…</Text><LoadingState rows={2} /></Card>;
  if (state === "changed") {
    return (
      <Card>
        <Text strong>{`${name} changed`}</Text>
        <Text tone="muted">The watcher's code changed since you read it, so it was not turned on. Read the new card and turn it on again.</Text>
        <View className="self-start pt-s2"><Button kind="primary" size="sm" label="Show the new card" onPress={load} /></View>
      </Card>
    );
  }
  if (!card) return <Card><Text strong>{name}</Text><Text tone="muted">{problem || "There is no card for that watcher."}</Text></Card>;
  const f = card.facts;
  const hasFacts = f.readsText || f.reads.length || f.credentials.length || f.acts || f.cost || f.schedule;
  const on = card.state === "on", paused = card.state === "paused";
  return (
    <Card>
      <View className="flex-row items-center gap-s2">
        <View className="min-w-0 flex-1"><Text strong>{card.name}</Text>{card.owner ? <Text size="caption" tone="muted">{card.owner}</Text> : null}</View>
        <Chip tone={on ? "ok" : "plain"}>{on ? "On" : paused ? "Paused" : "Off"}</Chip>
      </View>
      <View className="gap-s1 pt-s2">
        <Line k="When" v={card.lines.when} />
        <Line k="Check" v={card.lines.check} />
        <Line k={card.lines.check ? "Then" : "Do"} v={card.lines.do} />
      </View>
      {hasFacts ? (
        <View className="gap-s1">
          <Divider />
          <SectionLabel>What it will do, as Vyre reads its code</SectionLabel>
          <Line k="Reads" v={[f.readsText, f.reads.join(", ")].filter(Boolean).join(" · ")} />
          {f.credentials.length ? <View className="flex-row flex-wrap items-center gap-s1"><View className="w-16"><Text size="caption" tone="label">Uses</Text></View>{f.credentials.map((c, i) => <Chip key={i} icon="key">{[c.host, c.item].filter(Boolean).join(" · ")}</Chip>)}</View> : null}
          <Line k="Acts" v={f.acts} />
          <Line k="Cost" v={f.cost} />
          <Line k="Runs" v={f.schedule} />
        </View>
      ) : null}
      <Text size="caption" tone="muted">{card.described === "by its author" ? "These three sentences are the author's words. The facts above are what Vyre found in the code." : "Described by Vyre from its code."}</Text>
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {readOnly ? null : (
        <View className="flex-row gap-s2 pt-s2">
          {on ? <Button size="sm" label="Turn off" disabled={busy} onPress={() => act("pause")} />
            : paused ? <Button kind="primary" size="sm" label="Turn back on" disabled={busy} onPress={() => act("resume")} />
            : <><Button kind="primary" size="sm" label={busy ? "Turning on" : "Turn on"} disabled={busy} onPress={() => act("on")} /><Button kind="ghost" size="sm" label="Not now" onPress={() => onDone?.()} /></>}
        </View>
      )}
    </Card>
  );
}
