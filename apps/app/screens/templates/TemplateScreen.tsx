import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, ErrorState, Field, LoadingState, Sheet, Switch, Text, showToast, useWork } from "@vyre/ui";
import { Frame, Sec } from "../places/Frame";
import { usePhone } from "../places/Page";
import { useMembers } from "../spaces/state";
import { StartSheet, type StartExtras } from "../projects/StartSheet";
import { errWords, projectIdOf, startWords, stateWord, type Body, type Version } from "./model";
import { changeCount, playbookPath, TEMPLATES_LABEL, versionBar } from "./board";
import { Board } from "./PipelineBoard";
import { TaskPanel } from "./TaskPanel";
import { TemplateEditor } from "./TemplateEditor";
import { useMayMakeTemplates } from "./role";
import { templates } from "./templates";
import { DescribeSheet } from "./DescribeSheet";
import { openEngineer } from "../engineer/openEngineer";
import * as E from "./edit";
import { canPublish, checklist, DEFAULT_NAME, NOUN_SUGGESTIONS, publishWords, saveState, typeKey, type At } from "./compose";

/**
 * /u/playbooks/:id (and the old /u/templates/:id): one playbook as a pipeline. The stages are columns and the tasks cards in them; a card opens its settings beside the board; everything is edited in place on a working copy, and the bar
 * above says what is live and how many things differ from it. Publish makes the working copy a new version and puts it live (the owner or an admin); nothing changes for a project already running. Test mode
 * is a dry run of the saved version: every brief and doer on a sample, nothing created or sent.
 */
export default function TemplateScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const phone = usePhone();
  const template = String(id);
  const mayMake = useMayMakeTemplates();
  const { members } = useMembers();
  const people = useMemo(() => members.map((m) => ({ id: m.id, name: m.name })), [members]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [flows, setFlows] = useState<{ id: string; name: string; active: boolean }[]>([]);
  useEffect(() => { templates.agents().then(setAgents).catch(() => setAgents([])); templates.flows().then(setFlows).catch(() => setFlows([])); }, []);
  const work = useWork();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [cur, setCur] = useState<Version | null>(null);
  const [live, setLive] = useState<Version | null>(null);
  const [draft, setDraft] = useState<Body | null>(null);
  const [selected, setSelected] = useState<{ si: number; ti: number } | null>(null);
  const [err, setErr] = useState("");
  const [test, setTest] = useState<string[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [focus, setFocus] = useState<At | null>({ si: 0, ti: 0 });
  const [savedJson, setSavedJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [describing, setDescribing] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(() => {
    setErr("");
    templates.versions(template).then((v) => { setVersions(v); setPick((p) => p ?? (v.find((x) => x.state === "live") || v[0])?.version ?? null); const l = v.find((x) => x.state === "live"); if (l) templates.get(template, l.version).then(setLive).catch(() => setLive(null)); else setLive(null); }).catch((e) => setErr(errWords(e)));
  }, [template]);
  useEffect(load, [load]);
  useEffect(() => { if (pick != null) { setTest(null); setSelected(null); templates.get(template, pick).then((v) => { setCur(v); setDraft(structuredClone(v.body!)); setSavedJson(JSON.stringify(v.body)); }).catch((e) => setErr(errWords(e))); } }, [template, pick]);
  const run = async (name: string, fn: () => Promise<void>) => { setBusy(name); try { await fn(); } catch (e) { showToast(errWords(e)); } finally { setBusy(""); } };
  // a playbook that was never live is a draft being written: it is typed as a list and saved as it goes
  const compose = Boolean(cur && draft && cur.state === "draft" && !live && mayMake && pick === cur.version);
  const dirty = Boolean(draft) && JSON.stringify(draft) !== savedJson;
  useEffect(() => {
    if (!compose || !dirty || !draft) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { setSaving(true); setSaveErr(""); templates.define(draft, template, "written in the studio", true).then(() => setSavedJson(JSON.stringify(draft))).catch((e) => setSaveErr(errWords(e))).finally(() => setSaving(false)); }, 1200);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [compose, dirty, draft, template]);
  const base = live?.body ?? null;
  const dirtyFromShown = cur?.body && draft ? changeCount(cur.body, draft) : 0;
  const changes = draft ? changeCount(base ?? cur?.body ?? null, draft) : 0;
  const bar = versionBar({ live: live?.version ?? null, changes: live ? changes : dirtyFromShown });
  const noun = draft?.noun?.one || "project";
  const running = (work.data?.items ?? []).filter((i: any) => i.def?.name === "project" && i.row?.data?.template === template).length;
  const saveDraft = () => run("save", async () => { const v = await templates.define(draft!, template, "edited in the studio"); showToast(`Saved as draft version ${v.version}.`); setPick(v.version); load(); });
  const publish = () => run("publish", async () => {
    const v = await templates.define(draft!, template, "published from the board", compose);
    await templates.goLive(template, v.version);
    setPublishOpen(false);
    showToast(`Version ${v.version} is live. Projects already running keep their own version.`); setPick(v.version); load();
  });
  const doTest = async (on: boolean) => {
    if (!on) { setTest(null); return; }
    setTesting(true);
    try { const r = await templates.test(template, cur!.version); setTest(r.ok ? r.lines || [] : (r.errors || []).map((x) => `${x.path}: ${x.message}`)); } catch (e) { showToast(errWords(e)); } finally { setTesting(false); }
  };
  const start = async (name: string, extras: StartExtras) => {
    setStarting(true);
    try { const r = await templates.start(template, name, extras); setStartOpen(false); showToast(startWords(name, r)); router.push(`/u/project/${projectIdOf(r.project)}` as never); } catch (e) { showToast(errWords(e)); } finally { setStarting(false); }
  };
  const flowName = (fid: string) => flows.find((f) => f.id === fid)?.name || fid;
  const title = draft?.name || cur?.name || TEMPLATES_LABEL;
  const panel = draft && selected ? <TaskPanel body={draft} si={selected.si} ti={selected.ti} onChange={setDraft} onClose={() => setSelected(null)} people={people} agents={agents} /> : null;
  return (
    <Frame back={playbookPath()} title={title} sub={cur ? `${draft?.noun ? `Its projects are called ${draft.noun.many}. ` : ""}${stateWord(cur.state)}, version ${cur.version}` : undefined}
      actions={cur && !phone ? <>
        <View className="flex-row items-center gap-s2"><Switch on={test !== null || testing} onChange={(v: boolean) => void doTest(v)} label="Test mode" /><Text size="caption" tone="muted">Test mode</Text></View>
        {mayMake ? <Button kind="ghost" size="sm" label="Improve with the Engineer" onPress={() => setDescribing(true)} /> : null}
        {live ? <Button kind="primary" size="sm" label={`Start a ${noun.toLowerCase()}`} onPress={() => setStartOpen(true)} /> : null}
      </> : undefined}>
      {err ? <Card flush><ErrorState title="That playbook did not load" reason={err} retry={load} /></Card> : null}
      {!cur && !err ? <LoadingState rows={4} /> : null}
      {versions && versions.length > 1 ? <View className="flex-row flex-wrap gap-s2">{versions.map((v) => <Button key={v.version} kind={v.version === pick ? "primary" : "ghost"} size="sm" label={`v${v.version} ${stateWord(v.state)}`} onPress={() => setPick(v.version)} />)}</View> : null}
      {cur && phone ? <View className="gap-s2">        <View className="flex-row items-center gap-s2"><Switch on={test !== null || testing} onChange={(v: boolean) => void doTest(v)} label="Test mode" /><Text size="caption" tone="muted">Test mode</Text></View>        {mayMake ? <Button kind="ghost" size="sm" label="Improve with the Engineer" onPress={() => setDescribing(true)} /> : null}        {live ? <Button kind="primary" size="sm" label={`Start a ${noun.toLowerCase()}`} onPress={() => setStartOpen(true)} /> : null}      </View> : null}
      {cur && draft ? (
        <>
          {compose ? (
            <View className="gap-s2">
              <Field name="Playbook name" value={draft.name} onChangeText={(v: string) => setDraft(E.setName(draft, v))} placeholder={DEFAULT_NAME} autoFocus />
              <View className="flex-row flex-wrap items-center gap-s2">
                <Text tone="muted">Each one is called a</Text>
                <View style={{ width: 180 }}><Field name="What one is called" value={draft.noun?.one || ""} onChangeText={(v: string) => setDraft(E.setNoun(draft, v))} placeholder="Matter" /></View>
                {NOUN_SUGGESTIONS.map((n) => <Chip key={n} selected={draft.noun?.one === n} onPress={() => setDraft(E.setNoun(draft, n))}>{n}</Chip>)}
              </View>
            </View>
          ) : null}
          <Card><View className="flex-row flex-wrap items-center gap-s2 p-s3">
            <View className="min-w-0 flex-1"><Text strong>{compose ? saveState({ dirty, saving, error: saveErr }) : bar.line}</Text>{compose && !canPublish(draft).ok ? <Text size="caption" tone="label">{canPublish(draft).why}</Text> : null}{!mayMake ? <Text size="caption" tone="label">Only an owner or an admin changes a playbook.</Text> : null}</View>
            {compose ? <Button kind="primary" size="sm" label="Publish" disabled={!canPublish(draft).ok} onPress={() => setPublishOpen(true)} /> : null}
            {mayMake && !compose ? <>
              <Button kind="ghost" size="sm" label="Save draft" loading={busy === "save"} disabled={dirtyFromShown === 0} onPress={() => void saveDraft()} />
              {bar.canPublish ? <Button kind="primary" size="sm" label="Publish" loading={busy === "publish"} onPress={() => void publish()} /> : null}
            </> : null}
          </View></Card>
          <View className={phone || !(panel || compose) ? "gap-s4" : "flex-row items-start gap-s4"}>
            <View className="min-w-0 flex-1"><Board body={draft} onChange={setDraft} selected={selected} onOpen={(si, ti) => setSelected({ si, ti })} people={people} agents={agents} editable={mayMake} compose={compose ? { focus, onKey: (at, text, key) => { const r = typeKey(draft, at, text, key); if (r.body !== draft) setDraft(r.body); setFocus(r.focus); return r; } } : undefined} /></View>
            {panel || compose ? <View className={phone ? "gap-s3" : "w-80 gap-s3"}>
              {compose ? <Card><View className="gap-s2 p-s3">
                <Text size="caption" strong tone="label">Checklist</Text>
                {checklist(draft).map((c) => <View key={c.id} className="flex-row items-center gap-s2"><Text tone={c.done ? "faint" : "default"}>{c.done ? "✓" : "○"}</Text><Text tone={c.done ? "faint" : "default"}>{c.label}{c.optional ? " (optional)" : ""}</Text></View>)}
              </View></Card> : null}
              {panel}
            </View> : null}
          </View>
          <Sec title="Connected">
            <Card><View className="gap-s2 p-s3">
              <View className="flex-row flex-wrap items-center gap-s2"><Text size="caption" strong tone="label">Flows</Text>{(draft.automations || []).length ? (draft.automations || []).map((a) => <Chip key={`${a.when}|${a.flow}`}>{`${flowName(a.flow)}: ${a.when === "start" ? "when it starts" : `in ${a.when}`}`}</Chip>) : <Text size="caption" tone="muted">None run on its stages.</Text>}</View>
              <View className="flex-row flex-wrap items-center gap-s2"><Text size="caption" strong tone="label">Running</Text><Text size="caption" tone="muted">{`${running} open ${running === 1 ? noun.toLowerCase() : (draft.noun?.many || "projects").toLowerCase()}`}</Text><Button kind="ghost" size="sm" label="See them in Projects" onPress={() => router.push(`/u/projects?playbook=${template}` as never)} /></View>
            </View></Card>
          </Sec>
          {test ? <Sec title="Test mode"><Card><View className="gap-s1 p-s3">{test.map((l, i) => <Text key={i} size="caption">{l}</Text>)}</View></Card></Sec> : null}
          {mayMake ? <Sec title="Settings"><TemplateEditor body={draft} onChange={setDraft} part="settings" /></Sec> : null}
        </>
      ) : null}
      <DescribeSheet open={describing} title="Improve this playbook" question="What should be better?" placeholder="For example: add a review step before signing" cta="Ask the Engineer" onClose={() => setDescribing(false)} onSend={(words) => { setDescribing(false); openEngineer(router, { source: "playbook", ref: template, words, intent: "change" }); }} />
      <Sheet open={publishOpen} onClose={() => setPublishOpen(false)} title={`Publish ${draft?.name || "this playbook"}`}>
        <View className="gap-s3 p-s4">
          <Text tone="muted">{publishWords({ name: draft?.name || "", noun: draft?.noun, stages: draft?.stages || [], live: live?.version ?? null })}</Text>
          <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Publish" loading={busy === "publish"} onPress={() => void publish()} /><Button kind="ghost" size="sm" label="Not yet" onPress={() => setPublishOpen(false)} /></View>
        </View>
      </Sheet>
      <StartSheet noun={noun} playbook={title} open={startOpen} busy={starting} onClose={() => setStartOpen(false)} onStart={(n, x) => void start(n, x)} />
    </Frame>
  );
}
