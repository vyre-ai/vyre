import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Divider, ErrorState, Field, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { Frame, Sec } from "../places/Frame";
import { bodyText, errWords, parseBody, projectIdOf, roleLines, startName, startWords, stateWord, treeOf, type Version } from "./model";
import { templates } from "./templates";

/**
 * /u/templates/:id, the template studio: the tree of stages and tasks, Test mode (every brief and doer on a sample, nothing created or sent), Go live (the owner or an admin), the versions, and the
 * editor for the body. Saving from the editor is a new DRAFT version: nothing changes for a running project, and nothing is live until someone with the say puts it live. @Engineer edits through the same calls.
 */
export default function TemplateScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const template = String(id);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [cur, setCur] = useState<Version | null>(null);
  const [err, setErr] = useState("");
  const [test, setTest] = useState<string[] | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    setErr("");
    templates.versions(template).then((v) => { setVersions(v); setPick((p) => p ?? (v.find((x) => x.state === "live") || v[0])?.version ?? null); }).catch((e) => setErr(errWords(e)));
  }, [template]);
  useEffect(load, [load]);
  useEffect(() => { if (pick != null) { setTest(null); setEdit(null); templates.get(template, pick).then(setCur).catch((e) => setErr(errWords(e))); } }, [template, pick]);
  const run = async (name: string, fn: () => Promise<void>) => { setBusy(name); try { await fn(); } catch (e) { showToast(errWords(e)); } finally { setBusy(""); } };
  const doTest = () => run("test", async () => { const r = await templates.test(template, cur!.version); setTest(r.ok ? r.lines || [] : (r.errors || []).map((x) => `${x.path}: ${x.message}`)); });
  const goLive = () => run("live", async () => { await templates.goLive(template, cur!.version); showToast(`Version ${cur!.version} is live. Projects already running keep their own version.`); load(); templates.get(template, cur!.version).then(setCur).catch(() => {}); });
  const save = () => run("save", async () => {
    const p = parseBody(edit || "");
    if (!p.ok) { showToast(p.why); return; }
    const v = await templates.define(p.body, template, "edited in the studio");
    showToast(`Saved as draft version ${v.version}.`); setEdit(null); setPick(v.version); load();
  });
  const start = () => run("start", async () => {
    const n = startName(projectName);
    if (!n.ok) { showToast(n.why); return; }
    const r = await templates.start(template, n.name);
    showToast(startWords(n.name, r));
    router.push(`/u/project/${projectIdOf(r.project)}` as never);
  });
  const tree = cur?.body ? treeOf(cur.body) : [];
  return (
    <Frame back="/u/templates" title={cur?.name || "Template"} sub={cur ? `Version ${cur.version}, ${stateWord(cur.state).toLowerCase()}` : undefined}
      actions={cur ? <><Button kind="ghost" size="sm" label="Test mode" loading={busy === "test"} onPress={() => void doTest()} />{cur.state === "draft" ? <Button kind="primary" size="sm" label="Go live" loading={busy === "live"} onPress={() => void goLive()} /> : null}<Button kind="ghost" size="sm" label={edit == null ? "Edit" : "Close editor"} onPress={() => setEdit(edit == null ? bodyText(cur.body!) : null)} /></> : undefined}>
      {err ? <Card flush><ErrorState title="That template did not load" reason={err} retry={load} /></Card> : null}
      {!cur && !err ? <LoadingState rows={4} /> : null}
      {versions && versions.length > 1 ? (
        <View className="flex-row flex-wrap gap-s2">{versions.map((v) => <Button key={v.version} kind={v.version === pick ? "primary" : "ghost"} size="sm" label={`v${v.version} ${stateWord(v.state)}`} onPress={() => setPick(v.version)} />)}</View>
      ) : null}
      {cur && edit != null ? (
        <Sec title="Edit as a new draft">
          <Field name="Template body (JSON)" value={edit} onChangeText={setEdit} multiline lines={18} />
          <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Save as a draft version" loading={busy === "save"} onPress={() => void save()} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setEdit(null)} /></View>
        </Sec>
      ) : null}
      {cur && cur.state === "live" ? (
        <Sec title="Start a project"><View className="gap-s3">
          <Text tone="muted">Makes the project with its team and these stages, and puts the first stage's tasks in Now. Projects already running keep their own version.</Text>
          <Field name="Project name" value={projectName} onChangeText={setProjectName} placeholder="Rivera Family Trust" />
          <View className="self-start"><Button kind="primary" size="sm" label={busy === "start" ? "Starting" : "Start project"} loading={busy === "start"} disabled={!projectName.trim()} onPress={() => void start()} /></View>
        </View></Sec>
      ) : null}
      {cur?.body ? (
        <Sec title="Stages and tasks">
          <Card flush>
            {tree.map((l, i) => (
              <View key={i}>{i ? <Divider /> : null}
                <Row title={l.text} sub={l.note} className={l.depth ? "pl-s6" : undefined} />
              </View>
            ))}
          </Card>
          {roleLines(cur.body).length ? <View className="gap-s1">{roleLines(cur.body).map((t) => <Text key={t} size="caption" tone="label">{t}</Text>)}</View> : null}
          {cur.body.tags && cur.body.tags.length ? <View className="flex-row gap-s2">{cur.body.tags.map((t) => <Chip key={t}>{t}</Chip>)}</View> : null}
        </Sec>
      ) : null}
      {test ? (
        <Sec title="Test mode">
          <Card><View className="gap-s1 p-s3">{test.map((l, i) => <Text key={i} size="caption">{l}</Text>)}</View></Card>
        </Sec>
      ) : null}
    </Frame>
  );
}
