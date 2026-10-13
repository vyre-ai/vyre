// A Flow's History and Try it, over tools that already exist: flows.runs and flows.timeline (what each run did), flows.diff between versions, flows.rollback (go back, with a confirm), and flows.simulate
// (a practice run that does nothing). Real boxes only.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, Field, Row, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { callT as call } from "../../src/real/call-tool";
import { dayTimeOf } from "../../src/time/show.js";
import { sampleScope } from "../../ui/flows/preview.js";

type Diff = { summary?: string[]; same?: boolean };

/** What changed between versions, and a way back. `versions` is how many there are (1..n); `active` the one that runs. */
export function FlowHistory({ id, versions, active, onChanged }: { id: string; versions: number; active: number | null; onChanged: () => void }) {
  const [diffs, setDiffs] = useState<Record<number, Diff | null>>({});
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const nums = Array.from({ length: versions }, (_, i) => versions - i);
  useEffect(() => {
    let live = true;
    (async () => {
      const out: Record<number, Diff | null> = {};
      for (const n of nums) out[n] = n > 1 ? ((await call<Diff>("flows.diff", { id, from: n - 1, to: n })).data ?? null) : null;
      if (live) setDiffs(out);
    })();
    return () => { live = false; };
  }, [id, versions]);
  const back = async (n: number) => {
    setBusy(true);
    const r = await call<{ changes?: string[] }>("flows.rollback", { id, to: n });
    setBusy(false); setConfirm(null);
    if (r.error) { showToast(r.error.message); return; }
    showToast(`Went back to version ${n}. ${(r.data?.changes ?? []).join(" ")}`.trim());
    onChanged();
  };
  if (versions < 1) return null;
  return (
    <Sec title="Versions">
      <Card flush>
        {nums.map((n, i) => (
          <View key={n}>{i ? <Divider /> : null}
            <Row title={`Version ${n}${n === active ? " (running)" : ""}`} sub={n === 1 ? "The first version." : diffs[n] === undefined ? "Reading what changed..." : diffs[n]?.summary?.length ? diffs[n]!.summary!.join(" ") : diffs[n]?.same ? "Nothing changed from the one before." : "What changed is not available."}
              end={n === active ? <Chip tone="ok">Running</Chip> : confirm === n ? (
                <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Go back to this" loading={busy} onPress={() => back(n)} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setConfirm(null)} /></View>
              ) : <Button kind="ghost" size="sm" label="Go back to this" onPress={() => setConfirm(n)} />} />
          </View>
        ))}
      </Card>
      {confirm !== null ? <Text size="caption" tone="label">{`Going back approves version ${confirm} again in your name. Runs already going keep the version they started with.`}</Text> : null}
    </Sec>
  );
}

/** One run read back in a few lines (flows.timeline). */
export function RunLines({ run }: { run: string }) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => { let live = true; call<{ lines?: any[] }>("flows.timeline", { run }).then((r) => { if (live) setLines(r.error ? [r.error.message] : (r.data?.lines ?? []).map((l: any) => (typeof l === "string" ? l : String(l.text ?? l.line ?? JSON.stringify(l))))); }); return () => { live = false; }; }, [run]);
  if (!lines) return <Text tone="muted">Reading the run...</Text>;
  return <View className="gap-s1">{lines.map((l, i) => <Text key={i} size="secondary" tone="muted">{l}</Text>)}</View>;
}

/** Try it: a practice run that does nothing. A Flow started by a form or a person takes sample data you can change; a Flow started by a record or a clock is tried against the last week. */
export function TryIt({ id, flow, steps }: { id: string; flow: any; steps: { id: string; label: string }[] }) {
  const trig = flow?.trigger?.on;
  const sampled = trig === "web" || trig === "manual";
  const [text, setText] = useState(() => JSON.stringify(Object.fromEntries(Object.entries((sampleScope(JSON.stringify(flow?.steps ?? [])).trigger as any) ?? { name: "Pat Lopez", email: "pat@example.com" })), null, 1));
  const [out, setOut] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setErr(""); setBusy(true); setOut(null);
    let samples: any[] | undefined;
    if (sampled) { try { samples = [JSON.parse(text)]; } catch { setErr("The sample data is not valid JSON."); setBusy(false); return; } }
    const week = 7 * 86_400_000, now = Date.now();
    const r = await call<any>("flows.simulate", { id, ...(sampled ? { samples } : { since: now - week, until: now }) });
    setBusy(false);
    if (r.error) setErr(r.error.message); else if (r.data && r.data.ok === false) setErr((r.data.errors || []).map((e: any) => e.message).join(" ") || "That could not be tried."); else setOut(r.data);
  };
  const ran = new Set<string>(out?.runs?.[0]?.ran ?? []);
  return (
    <Sec title="Try it">
      <Card>
        <View className="gap-s3">
          <Text tone="muted">{sampled ? "A practice run with sample data. Nothing is sent, made or changed." : "Replays the last week through this Flow. Nothing is sent, made or changed."}</Text>
          {sampled ? <Field label="Sample data (JSON)" multiline lines={5} mono value={text} onChangeText={setText} /> : null}
          <View className="flex-row"><Button kind="secondary" icon="play" label={busy ? "Trying" : "Try it"} loading={busy} onPress={run} /></View>
          {err ? <Banner tone="warn" icon="warning"><Text>{err}</Text></Banner> : null}
          {out ? (
            <View className="gap-s2">
              <Banner><Text>{out.summary}</Text></Banner>
              {out.runs?.length ? steps.map((s) => <View key={s.id} className="flex-row items-center gap-s2"><Chip tone={ran.has(s.id) ? "ok" : "plain"}>{ran.has(s.id) ? "Would run" : "Would not run"}</Chip><Text numberOfLines={2} className="min-w-0 flex-1">{s.label}</Text></View>) : <Text tone="muted">Nothing in that window would have started it.</Text>}
              {out.runs?.[0]?.outcome && out.runs[0].outcome !== "completed" ? <Text tone="warn">{`${out.runs[0].outcome}${out.runs[0].reason ? `: ${out.runs[0].reason}` : ""}`}</Text> : null}
            </View>
          ) : null}
        </View>
      </Card>
    </Sec>
  );
}

export const when = (ms: number | null) => (ms ? dayTimeOf(ms) : "");
