// One Flow from the real vyred: its canvas, the version waiting for approval (with the kernel's card and a real Face ID or fingerprint), and its runs painted over the canvas.
import { dayTimeOf } from "../../src/time/show.js";
import { useEffect, useState } from "react";
import { useMembers } from "../spaces/state";
import { useSpaces } from "../shell/state";
import { tool } from "../../src/real/box";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AskCard, Banner, Button, Card, Chip, Divider, EmptyState, FlowCanvas, Field, Row, Segmented, Switch, Tabs, Text, haptic, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { Block } from "../places/Page";
import { StoredFlowEditor } from "./BuilderScreens";
import { sentenceParts } from "./sentence.js";
import { usePhone } from "../places/Page";
import { FlowHistory, RunLines, TryIt } from "./FlowHistory";
import { FlowTests } from "./FlowTests";
import { FlowLimits } from "./FlowLimits";
import { FlowAiAccounts } from "./FlowAiAccounts";
import { hasAiStep } from "./runs-on-model.js";
import { openEngineer } from "../engineer/openEngineer";
import { Frame, Sec } from "../places/Frame";
import { FlowCode } from "./FlowCode";
import { effectLines } from "./engineer-model";
import { cancelReal, retryFromReal, retryReal, startReal } from "./run";
import { ExplainCard } from "./ExplainCard";
import { canRetry, canStop, retryLimits, startRefusal } from "./run-model";
import { RunSteps } from "./RunSteps";
import { within, saidError } from "../../src/state/kept-model.js";
import { rowReal, setPausedReal, approveReal, proposeReal, cardReal, getReal, graphReal, explainReal, healthReal, runReal, runsReal, type Card as FlowCard, type Graph, type RunRow, type RealFlow as RealFlowRow } from "./real";
import { filterRuns, retryFromRefusal, APPROVE_LABEL, PROPOSE_LABEL, approvalPath, explainText, healthBanner, shownWarnings, shrunkNote, stageLine, titleOf, versionWaits } from "./real-model.js";

const when = (ms: number | null) => (ms ? dayTimeOf(ms) : "");
const STATE: Record<string, { note: string; tone: "accent" | "ok" | "warn" | "plain" }> = {
  waiting: { note: "Waiting on someone", tone: "accent" }, running: { note: "Running", tone: "accent" }, done: { note: "Done", tone: "ok" }, failed: { note: "Failed", tone: "warn" },
};

/** This visit's last answer per Space and Flow, so a Flow opened again draws in its first frame and the fresh answer replaces it in place. */
const seen = new Map<string, { g: Graph; def: unknown; meta: any; runs: RunRow[]; health: { level: string; line: string } | null; row: RealFlowRow | null }>();

export function RealFlow({ id }: { id: string }) {
  const router = useRouter();
  // a Flow-run line on a timeline opens this page with that run showing (?run=<id>)
  const { run: wanted } = useLocalSearchParams<{ run?: string }>();
  const spaceNow = useSpaces((s) => s.space);
  const kept = seen.get(`${spaceNow}.${id}`);
  const [g, setG] = useState<Graph | null>(kept?.g ?? null);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [def, setDef] = useState<unknown>(kept?.def ?? null);
  const [nver, setNver] = useState<{ versions: number; active: number | null }>({ versions: 0, active: null });
  const [meta, setMeta] = useState<{ version: number; hash: string; status: string; approver: unknown; by?: unknown; title: string } | null>(kept?.meta ?? null);
  const showing = useSpaces((s) => s.space);
  const role = useMembers((s) => s.spaces.find((x) => x.id === showing)?.role);
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => { tool<{ person?: string; me?: string; id?: string }>("records.me", {}).then((m) => setMe(m?.person ?? m?.me ?? m?.id ?? null)).catch(() => {}); }, []);
  const [card, setCard] = useState<FlowCard | null>(null);
  const [runs, setRuns] = useState<RunRow[]>(kept?.runs ?? []);
  const [runId, setRunId] = useState<string | undefined>(wanted ? String(wanted) : undefined);
  const [painted, setPainted] = useState<any[] | null>(null);
  const [shrunk, setShrunk] = useState<string | null>(null);
  const [ledger, setLedger] = useState<Record<string, any> | undefined>(undefined);
  const [explain, setExplain] = useState("");
  const [health, setHealth] = useState<{ level: string; line: string } | null>(kept?.health ?? null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  const [mapOn, setMapOn] = useState(false);
  const [tryOpen, setTryOpen] = useState(false);
  const phone = usePhone();
  const [runFilter, setRunFilter] = useState<"all" | "failed" | "waiting">("all");
  const [runQuery, setRunQuery] = useState("");
  const [tab, setTab] = useState<"steps" | "runs" | "settings" | "ai">("steps");
  const [row, setRow] = useState<RealFlowRow | null>(kept?.row ?? null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // the approval card is asked as soon as the version is known, beside the other reads, not after them
        const got = getReal(id);
        const cardP = got.then((v) => (versionWaits(v) ? cardReal(id, v.version) : null)).catch(() => null);
        const [graph, m, rs, hl, r] = await within(Promise.all([graphReal(id), got, runsReal(id), healthReal(id).catch(() => null), rowReal(id).catch(() => null)]));
        if (!live) return;
        setHealth(hl);
        setG(graph); setDef(m.flow ?? null); if (r) { setRow(r); setNver({ versions: r.versions, active: r.active ? (m as any).version ?? null : null }); } setMeta({ version: m.version, hash: m.hash, status: m.status, approver: m.approver, by: m.by, title: titleOf(m.flow, id) }); setRuns(rs.filter((x) => !x.parent));
        seen.set(`${showing}.${id}`, { g: graph, def: m.flow ?? null, meta: { version: m.version, hash: m.hash, status: m.status, approver: m.approver, by: m.by, title: titleOf(m.flow, id) }, runs: rs.filter((x) => !x.parent), health: hl, row: r });
        const c = await cardP;
        if (c && live) setCard(c);
      } catch (e) { if (live && !seen.has(`${showing}.${id}`)) setErr(saidError(e, "Flows did not answer.")); }
    })();
    return () => { live = false; };
  }, [id, n]);

  useEffect(() => {
    if (!runId) { setPainted(null); setShrunk(null); setLedger(undefined); setExplain(""); return; }
    explainReal(runId).then((d) => setExplain(explainText(d))).catch(() => setExplain(""));
    runReal(runId).then((r) => { setPainted(r.painted?.nodes ?? null); setShrunk(shrunkNote(r.run)); setLedger(r.run?.steps); }).catch(() => { setPainted(null); setShrunk(null); });
  }, [runId]);

  if (err) return <Frame title="Flows" back="/u/flows"><ErrorState title="Flows did not load" reason={err} retry={() => { setErr(""); setN((x) => x + 1); }} /></Frame>;
  if (!g || !meta) return <Frame title="Flows" back="/u/flows"><LoadingState rows={3} /></Frame>;
  const nodes = painted ?? g.nodes;
  const node = nodes.find((x) => x.id === picked);
  const waiting = versionWaits(meta);

  const propose = async () => {
    setBusy(true);
    try { await proposeReal(id, meta.version); haptic.approve(); showToast("Sent. The person whose authority it runs on, or an owner or admin, will see it. Nothing runs until they approve."); setN((x) => x + 1); }
    catch (e) { showToast(e instanceof Error ? e.message : "That did not go through."); }
    finally { setBusy(false); }
  };
  const path = approvalPath({ role, by: meta.by, me });
  const approve = async () => {
    setBusy(true);
    try { const r = (await approveReal(id, meta.version, meta.hash)) as { notice?: string } | null; haptic.approve(); showToast(r && typeof r.notice === "string" && r.notice ? r.notice : "Approved. This version can run."); setN((x) => x + 1); }
    catch (e) { showToast(e instanceof Error ? e.message : "That did not work."); }
    finally { setBusy(false); }
  };

  const runNow = async () => {
    setBusy(true);
    try { const r = await startReal(id, `app-${id}-${Date.now()}`); showToast("Started."); setN((x) => x + 1); if (r.id || r.run) setRunId(r.id ?? r.run); }
    catch (e) { showToast(startRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "")); }
    finally { setBusy(false); }
  };
  const retry = async (run: string) => {
    setBusy(true);
    try { await retryReal(run); showToast("Retrying."); setN((x) => x + 1); }
    catch (e) { showToast(e instanceof Error ? e.message : "That did not work."); }
    finally { setBusy(false); }
  };
  const stop = async (run: string) => {
    setBusy(true);
    try { await cancelReal(run); showToast("Stopped."); setN((x) => x + 1); }
    catch (e) { showToast(e instanceof Error ? e.message : "That did not work."); }
    finally { setBusy(false); }
  };
  const picked_run = runs.find((r) => r.id === runId);
  const shownRuns = filterRuns(runs.map((r) => ({ ...r, when: when(r.started_at) })), runFilter, runQuery);
  const hb = healthBanner(health);
  // a Playbook stage runs when a record enters it: no Run now and no Try it
  const stageWords = stageLine(def);

  return (
    <Frame back="/u/apps" title={meta.title} sub={`${g.trigger} · v${meta.version}`}>
      <View className="gap-s2 pb-s3">
        <Text size="page" strong>{sentenceParts(g.trigger, (g.nodes || []).filter((x: any) => x.kind !== "trigger").map((x: any) => String(x.label))).map((p, i) => <Text key={i} size="page" strong tone={p.token ? "accent" : "default"}>{p.text}</Text>)}</Text>
        <Text size="caption" tone="label">{[meta.title, row?.project ? `in ${row.project}` : "Personal", `version ${meta.version}`].join(" · ")}</Text>
        {stageWords ? <Text tone="muted">{stageWords}</Text> : null}
        <View className="flex-row flex-wrap items-center gap-s3">
          <Switch label={row?.paused ? "Off" : "On"} on={!row?.paused} onChange={async (on) => { try { await setPausedReal(id, !on); setN((x) => x + 1); } catch (e) { showToast(e instanceof Error ? e.message : "That did not work."); } }} />
          <Button kind="secondary" size="sm" icon="chat" label="Change it in chat" onPress={() => openEngineer(router, { source: "flow", ref: id, words: "" })} />
          {def && !stageWords ? <Button kind={tryOpen ? "secondary" : "ghost"} size="sm" icon="play" label="Try it" onPress={() => setTryOpen(!tryOpen)} /> : null}
          {!waiting && !stageWords ? <Button kind="primary" size="sm" icon="play" label={busy ? "Starting" : "Run now"} disabled={busy} onPress={runNow} /> : null}
        </View>
      </View>
      {tryOpen ? <View className="pb-s3">{def ? <TryIt id={id} flow={def} steps={(g.nodes || []).filter((n: any) => n.kind !== "trigger").map((n: any) => ({ id: String(n.id), label: String(n.label) }))} /> : null}</View> : null}
      {hb && hb.tone !== "quiet" ? <Banner tone={hb.tone}><Text>{hb.text}</Text></Banner> : null}
      {shownWarnings(g.warnings).length ? <Banner tone="warn"><View className="gap-s1">{shownWarnings(g.warnings).map((w, i) => <Text key={i}>{w}</Text>)}</View></Banner> : null}
      {waiting && card ? (
        <Sec title="Waiting for your approval">
          <AskCard title={`Approve version ${card.version}`} why={card.changes.length ? card.changes.join(" ") : path === "propose" ? "This Flow was set up by someone else. Send this version for approval: nothing runs until the person it runs as, or an owner or admin, agrees." : "Nothing runs until you approve this exact version."}
            actions={path === "propose" ? [{ label: busy ? "Sending" : PROPOSE_LABEL, kind: "primary", icon: "check", onPress: busy ? () => {} : propose }] : [{ label: busy ? "Approving" : APPROVE_LABEL, kind: "primary", icon: "check", onPress: busy ? () => {} : approve }]} />
          {effectLines(card.effects).length ? <Block label="What it does">{effectLines(card.effects).join("\n")}</Block> : null}
          <Block label="See as code">{card.text}</Block>
        </Sec>
      ) : null}
      {hb && hb.tone === "quiet" ? <Text tone="muted">{hb.text}</Text> : null}
      <Tabs items={[["steps", "Steps"], ["runs", "Runs"], ...(hasAiStep(def) ? [["ai", "AI accounts"] as ["ai", string]] : []), ["settings", "Settings"]]} value={tab} onChange={setTab} />
      {tab === "ai" && def && hasAiStep(def) ? <View className="gap-s4 pt-s3"><FlowAiAccounts id={id} flow={def} onSaved={() => setN((x) => x + 1)} /></View> : null}
      {tab === "steps" ? (
        <View className={phone ? "gap-s4 pt-s3" : "flex-row items-start gap-s5 pt-s3"}>
          <View className="min-w-0 flex-1 gap-s4">
      {def ? <Sec title="Steps"><StoredFlowEditor id={id} flow={def} onSaved={() => setN((x) => x + 1)} /></Sec> : null}
          </View>
          <View className={phone ? "" : "w-72"}>
      <View style={{ gap: 12 }}>
        <Text strong>Runs</Text>
        {runs.slice(0, 5).map((r) => (
          <Row key={r.id} dense title={`Run of ${when(r.started_at)}`} sub={r.error?.message || (STATE[r.state]?.note ?? r.state)} onPress={() => { setRunId(r.id); setTab("runs"); }}
            end={canRetry(r.state) ? <Button kind="ghost" size="sm" label="Retry" disabled={busy} onPress={() => retry(r.id)} /> : undefined} />
        ))}
        {!runs.length ? <Text tone="muted">Not run yet.</Text> : null}
        <View className="self-start"><Button kind="ghost" size="sm" label="All runs" onPress={() => setTab("runs")} /></View>
      </View>
          </View>
        </View>
      ) : null}
      {tab === "runs" ? (
        <View className="gap-s4 pt-s3">
      <Sec title="Run history">
        <View className="flex-row flex-wrap items-center gap-s2 pb-s2">
          <Segmented options={[["all", "All"], ["failed", "Failed"], ["waiting", "Waiting"]]} value={runFilter} onChange={setRunFilter} label="Show" />
          <View className="min-w-0 flex-1"><Field label="Search runs" value={runQuery} onChangeText={setRunQuery} placeholder="A name, a date or a word from the error" /></View>
        </View>
        {runs.length && !shownRuns.length ? <Card><EmptyState title="No runs match" body="Change the filter or the search." /></Card> : null}
        {runs.length ? (
          <Card flush>
            {shownRuns.map((r, i) => {
              const s = STATE[r.state] ?? { note: r.state, tone: "plain" as const };
              return (
                <View key={r.id}>{i ? <Divider /> : null}
                  <Row selected={runId === r.id} onPress={() => setRunId(runId === r.id ? undefined : r.id)} title={`Run of ${when(r.started_at)}`} sub={runId === r.id ? <RunLines run={r.id} /> : r.error?.message || undefined} end={<Chip tone={s.tone}>{s.note}</Chip>} />
                </View>
              );
            })}
          </Card>
        ) : <Card><EmptyState title="Not run yet" body="It runs the next time what starts it happens." /></Card>}
      </Sec>
      {painted && picked_run ? (
        <Sec title={`What the run of ${when(picked_run.started_at)} did`}>
          <ExplainCard text={explain} />
          <Card flush>
            {shrunk ? <Row dense title={shrunk} sub="Its step-by-step details were cleared after the days the Space keeps them (Settings, Flows)." /> : <RunSteps onFrom={picked_run ? { refusal: (id) => retryFromRefusal(def, ledger, id), go: async (id) => { setBusy(true); try { await retryFromReal(picked_run.id, id); showToast("Retrying from that step."); setN((x) => x + 1); } catch (e) { showToast(e instanceof Error ? e.message : "That did not work."); } finally { setBusy(false); } } } : undefined} painted={painted} steps={ledger} max={retryLimits(def)} fmt={when} />}
          </Card>
          <View className="self-start pt-s2"><Button kind="ghost" size="sm" label="Open this run" onPress={() => router.push(`/u/flows/${id}/runs/${picked_run.id}` as never)} /></View>
          {canRetry(picked_run.state) ? <View className="self-start pt-s2"><Button size="sm" label={busy ? "Retrying" : "Retry this run"} disabled={busy} onPress={() => retry(picked_run.id)} /></View> : null}
          {canStop(picked_run.state) ? (confirmStop === picked_run.id ? (
            <View className="flex-row gap-s2 pt-s2"><Button kind="primary" size="sm" label={busy ? "Stopping" : "Stop it"} disabled={busy} onPress={async () => { await stop(picked_run.id); setConfirmStop(null); }} /><Button kind="ghost" size="sm" label="Keep it" onPress={() => setConfirmStop(null)} /></View>
          ) : <View className="self-start pt-s2"><Button kind="ghost" size="sm" label="Stop this run" onPress={() => setConfirmStop(picked_run.id)} /></View>) : null}
        </Sec>
      ) : null}
        </View>
      ) : null}
      {tab === "settings" ? (
        <View className="gap-s4 pt-s3">
        <FlowLimits id={id} />
        <Switch label="Show the map of this Flow" on={mapOn} onChange={setMapOn} />
        {mapOn ? <View className="gap-s3">
      <Card flush><FlowCanvas nodes={nodes} edges={g.edges} selected={picked} onSelect={(x) => setPicked(x === picked ? undefined : x)} /></Card>
      {node ? <Card title={node.kind === "trigger" ? "How it starts" : "This step"}><View className="gap-s1"><Text strong>{node.label}</Text>{node.note ? <Text tone="muted">{node.note}</Text> : null}</View></Card> : null}
        </View> : null}
      <FlowHistory id={id} versions={nver.versions} active={nver.active} onChanged={() => setN((x) => x + 1)} />
      <FlowTests id={id} runId={picked_run?.id} />
      <FlowCode id={id} version={meta.version} onSaved={() => setN((x) => x + 1)} />
        </View>
      ) : null}
      <View className="self-start"><Button kind="ghost" size="sm" label="Back to Flows" onPress={() => router.push("/u/apps" as never)} /></View>
    </Frame>
  );
}
