// Memory on a real vyred, the parts beside the facts: Ask (memory.ask), the map of what Memory holds with Pin and Mute (memory.graph, memory.pin,
// memory.mute), and what the person corrected with Undo (memory.corrections, memory.uncorrect). Nothing here is composed: an empty box says so.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Composer, Divider, EmptyState, IconButton, Menu, Row, Text, showToast } from "@vyre/ui";
import { Footnote } from "../places/Frame";
import { askReal, correctionsReal, graphReal, steerReal, uncorrectReal } from "./extras";
import { asked, correctionLine, roomsOf, standing, wordsOf, type Asked, type CorrectionRow, type GraphOut } from "./extras-model";

const say = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function RealAsk() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<ReturnType<typeof asked> | null>(null);
  const [err, setErr] = useState("");
  const go = () => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true); setErr(""); setOut(null);
    askReal(text).then((a: Asked) => setOut(asked(a))).catch((e) => setErr(say(e, "Memory did not answer."))).finally(() => setBusy(false));
  };
  return (
    <View className="gap-s3 pt-s2">
      <Composer label="Ask Memory" placeholder="Ask about a person, a project or a decision" value={q} onChangeText={setQ} onSend={go} />
      {busy ? <Text tone="muted">Asking Memory.</Text> : null}
      {err ? <Footnote icon="shield">{err}</Footnote> : null}
      {out?.kind === "answer" ? (
        <View className="gap-s2 pt-s2">
          <Text size="read">{out.text}</Text>
          {out.sources.map((s, i) => <Text key={i} tone="label" size="caption">{`${s.name}${s.quote ? `: "${s.quote}"` : ""}`}</Text>)}
        </View>
      ) : null}
      {out?.kind === "none" ? <Text tone="muted">{out.text}</Text> : null}
    </View>
  );
}

/** The map and the corrections, below the facts. */
export function RealExtras() {
  const [graph, setGraph] = useState<GraphOut | null>(null);
  const [fixes, setFixes] = useState<CorrectionRow[] | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    graphReal().then(setGraph).catch((e) => setErr(say(e, "The map did not load.")));
    correctionsReal().then(setFixes).catch((e) => setErr(say(e, "Corrections did not load.")));
  }, []);
  useEffect(load, [load]);

  const steer = (mode: "pin" | "mute", id: string, off: boolean, label: string) =>
    steerReal(mode, id, off).then(() => { showToast(`${off ? (mode === "pin" ? "Unpinned" : "Unmuted") : mode === "pin" ? "Pinned" : "Muted"} ${label}.`); load(); }).catch((e) => showToast(say(e, "That did not work.")));
  const undo = (c: CorrectionRow) => uncorrectReal(c.id).then(() => { showToast("Undone."); load(); }).catch((e) => showToast(say(e, "That did not work.")));

  const rooms = graph ? roomsOf(graph) : [];
  const list = fixes ? standing(fixes) : [];
  return (
    <View className="gap-s2 pt-s6">
      {err ? <Banner><View className="flex-row flex-wrap items-center gap-s3"><Text className="min-w-0 flex-1">{err}</Text><Button size="sm" label="Try again" onPress={load} /></View></Banner> : null}
      <Text strong size="secondary">What Memory holds</Text>
      {graph && !rooms.length ? <Card><EmptyState title="Nothing mapped yet" body="People and projects appear here once Memory has read your chats." /></Card> : null}
      {rooms.map((r) => (
        <View key={r.id} className="gap-s1 pt-s2">
          <View className="flex-row items-baseline gap-s2"><Text strong>{r.name}</Text><Text size="caption" tone="faint">{r.counts}</Text></View>
          <Card flush>
            {r.nodes.map((n, i) => (
              <View key={n.id}>{i ? <Divider /> : null}
                <Row dense title={n.label} sub={[n.kind, n.pinned ? "pinned" : "", n.muted ? "muted, never offered" : ""].filter(Boolean).join(", ")}
                  end={<Menu trigger={<IconButton icon="more" label={`More about ${n.label}`} />} items={[
                    { label: n.pinned ? "Unpin" : "Pin first", onPress: () => steer("pin", n.id, n.pinned, n.label) },
                    { label: n.muted ? "Offer again" : "Never offer", onPress: () => steer("mute", n.id, n.muted, n.label) },
                  ]} />} />
              </View>
            ))}
          </Card>
        </View>
      ))}
      {graph?.truncated ? <Text size="caption" tone="faint">{`Showing ${graph.counts.drawn} of ${graph.counts.nodes}, the most seen first.`}</Text> : null}

      <View className="pt-s6"><Text strong size="secondary">What you corrected</Text></View>
      {fixes && !list.length ? <Card><EmptyState title="No corrections" body="When you edit or forget a fact, it is listed here and can be undone." /></Card> : null}
      {list.length ? (
        <Card flush>
          {list.map((c, i) => (
            <View key={c.id}>{i ? <Divider /> : null}
              <Row dense title={correctionLine(c)} sub={`${new Date(c.created).toLocaleDateString()}${c.scope && c.scope !== "*" ? `, in ${wordsOf(c.scope)}` : ""}`} end={<Button kind="ghost" size="sm" label="Undo" onPress={() => undo(c)} />} />
            </View>
          ))}
        </Card>
      ) : null}
    </View>
  );
}
