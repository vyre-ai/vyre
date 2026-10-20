// The watcher card (chat components, section 16): the in-chat view of a Routine or a Watcher. For one an agent set up when the person asked, it is the card in
// the chat where they asked: what it does, its state, and Pause, Resume and Delete (the same acts as the agent's panel and page). A Vault item it names that is not
// lent to the agent shows as "Needs access to <item>" with a button for the person. For an older watcher waiting to be turned on, Turn on carries the card's own hash,
// and a changed hash is refused: the card offers the new one and never turns on code the person did not read.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Divider, LoadingState, SectionLabel, Text } from "@vyre/ui";
import { moreTools } from "./instance";
import type { WatcherCard as Model } from "./more-model.ts";

type Act = "on" | "pause" | "resume" | "delete";
const Line = ({ k, v }: { k: string; v: string }) => (v ? <View className="flex-row gap-s3"><View className="w-16"><Text size="caption" tone="label">{k}</Text></View><View className="min-w-0 flex-1"><Text>{v}</Text></View></View> : null);

/** The card drawn from its model; no tool is called here. */
export function WatcherCardView({ card, readOnly, busy, problem, onAct, onNotNow, onLend }: { card: Model; readOnly?: boolean; busy?: boolean; problem?: string; onAct?: (a: Act) => void; onNotNow?: () => void; onLend?: (item: string) => void }) {
  const f = card.facts;
  const hasFacts = f.readsText || f.reads.length || f.credentials.length || f.acts || f.cost || f.schedule;
  const on = card.state === "on", paused = card.state === "paused";
  const own = !!card.agent;
  const word = card.waiting ? "Testing" : on ? "On" : paused ? "Paused" : "Off";
  return (
    <Card>
      <View className="flex-row items-center gap-s2">
        <View className="min-w-0 flex-1"><Text strong>{own ? `${card.routine ? "Routine" : "Watcher"}: ${card.name}` : card.name}</Text>{card.owner ? <Text size="caption" tone="muted">{card.owner}</Text> : null}</View>
        <Chip tone={on ? "ok" : "plain"}>{word}</Chip>
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
      {card.waiting ? <Text size="caption" tone="label">{`${card.agent} is testing it. It turns on when its first test passes.`}</Text> : null}
      {card.needs.map((n) => (
        <Banner key={n.item} tone="warn">
          <View className="gap-s2">
            <Text>{`Needs access to ${n.item}${n.host ? ` (for ${n.host})` : ""}. ${card.agent} can use it without seeing it once you let it.`}</Text>
            {onLend && !readOnly ? <View className="flex-row"><Button size="sm" kind="secondary" label={`Let ${card.agent} use ${n.item}`} onPress={() => onLend(n.item)} /></View> : null}
          </View>
        </Banner>
      ))}
      {!own ? <Text size="caption" tone="muted">{card.described === "by its author" ? "These three sentences are the author's words. The facts above are what Vyre found in the code." : "Described by Vyre from its code."}</Text> : null}
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {readOnly || !onAct ? null : (
        <View className="flex-row flex-wrap gap-s2 pt-s2">
          {on ? <Button size="sm" label="Pause" disabled={busy} onPress={() => onAct("pause")} />
            : paused && !card.waiting ? <Button kind="primary" size="sm" label="Resume" disabled={busy} onPress={() => onAct("resume")} />
            : !own && !paused ? <><Button kind="primary" size="sm" label={busy ? "Turning on" : "Turn on"} disabled={busy} onPress={() => onAct("on")} /><Button kind="ghost" size="sm" label="Not now" onPress={() => onNotNow?.()} /></> : null}
          {own ? <Button kind="ghost" size="sm" label="Delete" disabled={busy} onPress={() => onAct("delete")} /> : null}
        </View>
      )}
    </Card>
  );
}

export function WatcherCard({ name, readOnly, onDone }: { name: string; readOnly?: boolean; onDone?: () => void }) {
  const router = useRouter();
  const [card, setCard] = useState<Model | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none" | "changed" | "deleted">("loading");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => {
    setState("loading"); setProblem("");
    moreTools.watcherCard(name).then((c) => { setCard(c); setState(c ? "ready" : "none"); }).catch((e) => { setProblem(e instanceof Error ? e.message : "The card could not be read."); setState("none"); });
  }, [name]);
  useEffect(load, [load]);
  const act = async (a: Act) => {
    if (!card || busy) return;
    setBusy(true); setProblem("");
    const r = await moreTools.watcher(a, card);
    setBusy(false);
    if (r.ok) { if (a === "delete") setState("deleted"); else setCard({ ...card, state: a === "pause" ? "paused" : "on", waiting: false }); onDone?.(); } else if (r.changed) setState("changed"); else setProblem(r.reason);
  };
  if (state === "loading") return <Card><Text tone="muted">Reading what it will do…</Text><LoadingState rows={2} /></Card>;
  if (state === "deleted") return <Card><Text tone="muted">{`${name} is deleted. What it found stays.`}</Text></Card>;
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
  return <WatcherCardView card={card} readOnly={readOnly} busy={busy} problem={problem} onAct={(a) => void act(a)} onNotNow={() => onDone?.()} onLend={(item) => router.push(`/u/vault?item=${encodeURIComponent(item)}` as never)} />;
}
