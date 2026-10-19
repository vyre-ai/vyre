import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Divider, EmptyState, ErrorState, IconTile, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { NewWatcherSheet } from "./NewWatcherSheet";
import { watcherRow, type WatcherRow } from "./watchers-model.js";
import { watchersSource } from "./watchers-source";

const say = (e: unknown) => (e instanceof Error && e.message ? e.message : "That did not go through.");

/** The Watchers tab of Flows: every watcher with its state, next and last run, and Run now, Pause or Resume, Turn on and Delete; "New watcher" starts one from a source. */
export function WatchersTab({ startNew, source = watchersSource }: { startNew?: boolean; /** The watchers to draw: the box's own, or fixtures for the screenshot pass. */ source?: typeof watchersSource }) {
  const router = useRouter();
  const [rows, setRows] = useState<WatcherRow[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [making, setMaking] = useState(!!startNew);
  const load = useCallback(() => { setErr(""); source.list().then(setRows).catch((e) => setErr(say(e))); }, []);
  useEffect(load, [load]);
  const act = async (name: string, what: string) => {
    setBusy(`${name}:${what}`);
    try {
      if (what === "run") { await source.run(name); showToast("Ran it. What it found is filed."); }
      else if (what === "pause") await source.pause(name);
      else if (what === "resume") await source.resume(name);
      else if (what === "delete") { await source.remove(name); showToast(`${name} is deleted. What it filed stays.`); }
      else if (what === "turn-on") { const c = await source.card(name); await source.create(name, String(c.hash ?? "")); showToast(`${name} is on.`); }
      load();
    } catch (e) { showToast(say(e)); } finally { setBusy(""); }
  };
  const LABEL = { run: "Run now", pause: "Pause", resume: "Resume", "turn-on": "Turn on", delete: "Delete" } as const;
  return (
    <View className="gap-s3">
      <View className="flex-row"><Button kind="primary" size="md" icon="plus" label="New watcher" onPress={() => setMaking(true)} /></View>
      {err ? <Card flush><ErrorState title="Watchers did not load" reason={err} retry={load} /></Card> : null}
      {!err && rows === null ? <Card flush><LoadingState rows={3} /></Card> : null}
      {!err && rows && !rows.length ? <Card flush><EmptyState title="No watchers yet" body="A watcher looks at mail, a calendar, a repo, Slack, a feed or a connection on a schedule and files what is new. A Flow can start from what it finds." action={{ label: "New watcher", onPress: () => setMaking(true) }} /></Card> : null}
      {rows && rows.length ? (
        <Card flush>
          {rows.map((w, i) => {
            const r = watcherRow(w);
            return (
              <View key={r.name}>{i ? <Divider inset={68} /> : null}
                <Row lead={<IconTile size={40} name="eye" />} title={r.title} sub={<View className="gap-s1"><Text size="secondary" tone="label" numberOfLines={2}>{[r.name, r.sub].filter(Boolean).join(" · ")}</Text>{r.problem ? <Text size="caption" tone="warn" numberOfLines={3}>{r.problem}</Text> : null}</View>}
                  end={<View className="flex-row flex-wrap items-center justify-end gap-s2"><Chip tone={r.tone}>{r.word}</Chip>{r.actions.map((a) => <Button key={a} size="sm" kind={a === "delete" ? "ghost" : "secondary"} label={LABEL[a]} disabled={!!busy} onPress={() => void act(r.name, a)} />)}</View>} />
              </View>
            );
          })}
        </Card>
      ) : null}
      <NewWatcherSheet source={source} open={making} onClose={() => setMaking(false)} onCreated={() => { showToast("Turned on."); load(); }} onWebhook={() => router.push("/u/flows/new" as never)} />
    </View>
  );
}
