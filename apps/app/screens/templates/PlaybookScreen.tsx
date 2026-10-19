import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, EmptyState, ErrorState, LoadingState, Row, StepCard, Tabs, Text, showToast, useWork } from "@vyre/ui";
import { SlotsSheet } from "./SlotsSheet";
import { InlineName, AddLine } from "./InlineEdit";
import { addStage, addTask, moveStage, removeStage, removeTask, renameStage, setName, setSlot, setTask } from "./edit";
import { Frame } from "../places/Frame";
import { StartSheet, type StartExtras } from "../projects/StartSheet";
import { useMembers } from "../spaces/state";
import { openEngineer } from "../engineer/openEngineer";
import { errWords, projectIdOf, startWords, type Body, type Version } from "./model";
import { playbookPath } from "./board";
import { DEFAULT_NAME } from "./compose";
import { PAGE_TABS, metaParts, ownerWords, sentenceOf, stageCards, waitingForYes } from "./page";
import { callT } from "../../src/real/call-tool";
import { useMayMakeTemplates } from "./role";
import { templates } from "./templates";

type Tab = (typeof PAGE_TABS)[number][0];

/**
 * /u/playbooks/:id, in the Flow page's language: the sentence at the top, a meta line (name, version, who made it, Live or Draft), tabs Stages, Projects, Test and Versions, and the actions at the top right
 * (Go live, Change it in chat, Start a project). Stages are vertical cards that open to their to-dos, doers, briefs and the Flows that turn on there. Every change is made in chat; Go live and Roll back are
 * the person's own acts on a version (work.template.golive, work.template.define).
 */
export default function PlaybookScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const template = String(id);
  const router = useRouter();
  const mayMake = useMayMakeTemplates();
  const { members, selfId } = useMembers();
  const work = useWork();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [shown, setShown] = useState<Version | null>(null);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [tab, setTab] = useState<Tab>("stages");
  const [open, setOpen] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [test, setTest] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [slotsAt, setSlotsAt] = useState<{ si: number; ti: number } | null>(null);
  const people = useMemo(() => members.map((m) => ({ id: m.id, name: m.name })), [members]);
  const load = useCallback(() => {
    setErr("");
    templates.versions(template).then(async (v) => {
      setVersions(v);
      const live = v.find((x) => x.state === "live");
      // a person who may edit sees the newest draft (what her edits change); everyone else sees the live version
      const newest = v.length ? v.reduce((a, b) => (b.version > a.version ? b : a)) : null;
      const head = mayMake && newest && newest.state === "draft" ? newest : live ?? v[0];
      if (head) setShown(await templates.get(template, head.version));
    }).catch((e) => setErr(errWords(e)));
  }, [template, mayMake]);
  useEffect(load, [load]);
  useEffect(() => { if (shown) callT("approvals.pending", {}).then((r) => setWaiting(!r.error && waitingForYes(r.data, template, shown.name))); }, [template, shown]);
  useEffect(() => { templates.agents().then(setAgents).catch(() => setAgents([])); }, []);
  const act = async (name: string, fn: () => Promise<void>) => { setBusy(name); try { await fn(); } catch (e) { showToast(errWords(e)); } finally { setBusy(""); } };

  const body: Body | null = shown?.body ?? null;
  const live = versions?.find((v) => v.state === "live") ?? null;
  const newest = versions && versions.length ? versions.reduce((a, b) => (b.version > a.version ? b : a)) : null;
  const draftAhead = newest && newest.state === "draft" && (!live || newest.version > live.version) ? newest : null;
  const byName = (owner: string | null) => ownerWords(owner, members, selfId);
  const projects = ((work.data?.items ?? []) as any[]).filter((i) => i.def?.name === "project" && i.row?.data?.template === template && i.row?.data?.status !== "archived");
  const cards = body ? stageCards(body, people, agents) : [];
  const noun = body?.noun?.one || "project";
  const goLive = (v: number) => act("live", async () => { await templates.goLive(template, v); showToast(`Version ${v} is live. Projects already running keep their own version.`); load(); });
  const rollBack = (v: number) => act("roll", async () => { const old = await templates.get(template, v); const made = await templates.define(old.body!, template, `rolled back to version ${v}`); showToast(`Version ${v} is back as draft ${made.version}. Go live to use it.`); load(); });
  const runTest = () => act("test", async () => { const r = await templates.test(template, shown!.version); setTest({ ok: r.ok, lines: r.ok ? r.lines || [] : (r.errors || []).map((x) => `${x.path}: ${x.message}`) }); });
  const start = async (name: string, extras: StartExtras) => {
    setStarting(true);
    try { const r = await templates.start(template, name, extras); setStartOpen(false); showToast(startWords(name, r)); router.push(`/u/project/${projectIdOf(r.project)}` as never); } catch (e) { showToast(errWords(e)); } finally { setStarting(false); }
  };
  const chat = () => openEngineer(router, { source: "playbook", ref: template, words: "" });
  // a direct edit: the new body is saved in place when the newest version is a draft, else as a new draft; nothing goes live until "Go live"
  const commit = (next: Body, what = "edited on the page") => act("save", async () => {
    const inPlace = !!shown && shown.state === "draft";
    const v = await templates.define(next, template, what, inPlace);
    setShown((cur) => (cur ? { ...cur, ...v, body: next, name: next.name } : cur));
    load();
  });

  const actions = shown ? (
    <>
      {draftAhead && mayMake ? <Button kind="secondary" size="sm" label="Go live" loading={busy === "live"} onPress={() => void goLive(draftAhead.version)} /> : null}
      <Button kind="ghost" size="sm" label="Change it in chat" onPress={chat} />
      {live ? <Button kind="primary" size="sm" label={`Start a ${noun.toLowerCase()}`} onPress={() => setStartOpen(true)} /> : null}
    </>
  ) : undefined;

  const made = shown ? ownerWords(shown.owner, members, selfId) : null;
  return (
    <Frame back={playbookPath()} onBack={() => router.push(playbookPath() as never)} title={body ? body.name.trim() || "Untitled playbook" : "Playbook"} sub={body ? sentenceOf(body) : undefined} actions={actions}
      titleNode={body ? <InlineName value={body.name} placeholder="Untitled playbook" size="page" label="the playbook" editable={mayMake} startEmpty={mayMake && template.startsWith("tpl_untitled-") && body.name === DEFAULT_NAME} onCommit={(v) => void commit(setName(body, v), "renamed")} /> : undefined}>
      {shown ? <Text size="caption" tone="label">{metaParts({ name: body?.name || shown.name, version: shown.version, by: made, live: shown.state === "live" }).slice(1).join(" · ")}</Text> : null}
      {err ? <Card flush><ErrorState title="That playbook did not load" reason={err} retry={load} /></Card> : null}
      {!err && !shown ? <LoadingState rows={3} /> : null}
      {shown && body ? (
        <>
          {waiting ? <Chip tone="accent" onPress={() => router.push("/u/now/needs" as never)}>Waiting for a yes. Open Needs you</Chip> : null}
          {draftAhead && draftAhead.version !== shown.version ? <Chip tone="warn">{`Draft version ${draftAhead.version} is waiting to go live`}</Chip> : null}
          <Tabs items={PAGE_TABS as [Tab, string][]} value={tab} onChange={setTab} />
          {tab === "stages" ? (
            <View className="max-w-read gap-s3">
              {cards.length ? (
                <View>
                  {cards.map((c, k) => (
                    <StepCard key={c.index} lead={`Stage ${c.index + 1}`} icon={k === cards.length - 1 ? "check" : "list"} title={c.name} summary={c.summary} open={open === c.index} onToggle={() => setOpen(open === c.index ? -1 : c.index)} last={k === cards.length - 1}
                      onUp={mayMake && k > 0 ? () => void commit(moveStage(body, c.index, -1), "moved a stage") : undefined}
                      onDown={mayMake && k < cards.length - 1 ? () => void commit(moveStage(body, c.index, 1), "moved a stage") : undefined}
                      onRemove={mayMake && cards.length > 1 ? () => void commit(removeStage(body, c.index), "removed a stage") : undefined}>
                      {mayMake ? <InlineName value={c.name} size="body" label={`stage ${c.index + 1}`} onCommit={(v) => void commit(renameStage(body, c.index, v), "renamed a stage")} /> : null}
                      {c.todos.map((t, n) => (
                        <View key={`${n}:${t.title}`} className="gap-s1">
                          <View className="flex-row items-center gap-s2">
                            <View className="min-w-0 flex-1"><InlineName value={t.title} placeholder="Untitled to-do" size="body" label="the to-do" editable={mayMake} onCommit={(v) => void commit(setTask(body, c.index, n, { title: v }), "renamed a to-do")} /></View>
                            {mayMake ? <Button kind="ghost" size="sm" icon="trash" label="Remove" onPress={() => void commit(removeTask(body, c.index, n), "removed a to-do")} /> : null}
                          </View>
                          {t.brief ? <Text size="caption" tone="muted">{t.brief}</Text> : null}
                          <Text size="caption" tone="label">{[`Assigned: ${t.doer}`, t.reviewer ? `Reviewer: ${t.reviewer}` : "", t.approver ? `Approver: ${t.approver}` : "", t.optional ? "Optional" : ""].filter(Boolean).join(" · ")}</Text>
                          {t.late ? <Text size="caption" tone="label">{t.late}</Text> : null}
                          {mayMake ? <View className="self-start"><Button kind="ghost" size="sm" label="Who does it, reviews and approves" onPress={() => setSlotsAt({ si: c.index, ti: n })} /></View> : null}
                        </View>
                      ))}
                      {c.flows.map((f) => <View key={`${f.flow}:${f.when}`} className="flex-row items-center gap-s2"><Chip>Flow</Chip><Text className="min-w-0 flex-1">{`Turns on ${f.when === "start" ? "when the project starts" : "here"}: ${f.label}${f.note ? `. ${f.note}` : ""}`}</Text></View>)}
                      {!c.todos.length && !c.flows.length ? <Text tone="muted">No to-dos here. A person moves the project on.</Text> : null}
                      {mayMake ? <AddLine placeholder="A to-do, for example: Send the welcome email" label="Add to-do" disabled={busy === "save"} onAdd={(title) => { const at = (body.stages[c.index]?.tasks || []).length; void commit(setTask(addTask(body, c.index), c.index, at, { title }), "added a to-do"); }} /> : null}
                    </StepCard>
                  ))}
                </View>
              ) : <EmptyState title="No stages yet" body={mayMake ? "Add the first stage below, or describe the work in chat." : "Nothing here yet."} />}
              {mayMake ? <AddLine placeholder="A stage, for example: Review" label="Add stage" disabled={busy === "save"} onAdd={(name) => void commit(renameStage(addStage(body), body.stages.length, name), "added a stage")} /> : null}
            </View>
          ) : null}
          {tab === "projects" ? (
            <View className="max-w-read gap-s3">
              {projects.length ? (
                <Card flush>{projects.map((p) => <Row key={p.row.id} title={String(p.row.data?.name ?? p.row.id)} sub={`On version ${p.row.data?.template_version ?? shown.version}${p.row.data?.template_stage ? `, in ${p.row.data.template_stage}` : ""}`} onPress={() => router.push(`/u/project/${p.row.id}` as never)} />)}</Card>
              ) : <EmptyState title="No project uses it yet" body={live ? `Start a ${noun.toLowerCase()} and its stages, to-dos and Flows are ready.` : "Go live first, then start one."} />}
              {live ? <View className="self-start"><Button kind="primary" size="sm" label={`Start a ${noun.toLowerCase()}`} onPress={() => setStartOpen(true)} /></View> : null}
            </View>
          ) : null}
          {tab === "test" ? (
            <View className="max-w-read gap-s3">
              {test ? (
                <Card><View className="gap-s2">
                  <Text strong>{test.ok ? "A dry run: this is what a new project would get. Nothing was created." : "The test found a problem."}</Text>
                  {test.lines.map((l, n) => <Text key={n} tone={test.ok ? "default" : "warn"}>{l}</Text>)}
                </View></Card>
              ) : <Text tone="muted">See exactly what a project from this playbook gets, with every brief, before anyone uses it. Nothing is created, sent or changed.</Text>}
              <View className="self-start"><Button kind={test ? "secondary" : "primary"} size="sm" label={test ? "Run it again" : "Run a test"} loading={busy === "test"} onPress={() => void runTest()} /></View>
            </View>
          ) : null}
          {tab === "versions" ? (
            <Card flush>
              {(versions ?? []).slice().sort((a, b) => b.version - a.version).map((v) => (
                <Row key={v.version} title={`Version ${v.version}`} sub={[v.state === "live" ? "Live now" : v.state === "draft" ? "Draft, not live yet" : "Retired", byName(v.owner), v.note].filter(Boolean).join(" · ")}
                  end={mayMake && v.state !== "live" ? <View className="flex-row gap-s2">{v.state === "draft" ? <Button kind="secondary" size="sm" label="Go live" onPress={() => void goLive(v.version)} /> : <Button kind="ghost" size="sm" label="Roll back to this" onPress={() => void rollBack(v.version)} />}</View> : undefined} />
              ))}
            </Card>
          ) : null}
        </>
      ) : null}
      {body ? <SlotsSheet open={!!slotsAt} task={slotsAt ? body.stages[slotsAt.si]?.tasks?.[slotsAt.ti] ?? null : null} body={body} people={people} agents={agents} busy={busy === "slots"} onClose={() => setSlotsAt(null)}
        onSave={(d, r, a) => slotsAt && void act("slots", async () => { let next = setTask(body, slotsAt.si, slotsAt.ti, { doer: d }); next = setSlot(next, slotsAt.si, slotsAt.ti, "reviewer", r); next = setSlot(next, slotsAt.si, slotsAt.ti, "approver", a); const made = await templates.define(next, template, "changed who does, reviews and approves a to-do"); setSlotsAt(null); showToast(`Saved as draft version ${made.version}. Go live when it is ready.`); load(); })} /> : null}
      <StartSheet noun={noun} playbook={body?.name} open={startOpen} busy={starting} onClose={() => setStartOpen(false)} onStart={(n, x) => void start(n, x)} />
    </Frame>
  );
}
