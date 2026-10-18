import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Segmented, Sheet, Text, showToast } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { browse, get, versions, draft, approve, rollback, decline, type SkillRow, type SkillVersion, type BrowsePack } from "./skills";
import { callT as call } from "../../src/real/call-tool";
import { pickConnections } from "../connections/model";
import { PluginDeclaresView, PluginEditor, type ConnectionPick } from "./PluginEditor";
import { emptyPlugin, pluginBody, type PluginManifest } from "./plugin-model";
import { AIS } from "../../../../lib/ai-ids.js";
import { SEGMENTS, listRows, needsLines, stateWord, versionLine } from "./skills-model.js";

const LEVELS = [
  { id: "personal", label: "Mine (identity)" },
  { id: "space", label: "This Space" },
  { id: "agent", label: "Agent" },
  { id: "project", label: "Project" },
] as const;

const errWords = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");
const skillTpl = (name: string) => `---\nname: ${name}\ndescription: Use when the work is about ${name}.\n---\n\n# ${name}\n\nSteps.\n`;

export function RealSkills() {
  // Settings opens this at a level: Skills and plugins under You is personal, under the Space it is the Space's.
  const { level: asked } = useLocalSearchParams<{ level?: string }>();
  const [level, setLevel] = useState<string>(LEVELS.some((l) => l.id === asked) ? String(asked) : "space");
  const [segment, setSegment] = useState<"skills" | "plugins">("skills");
  const [draftPick, setDraftPick] = useState<SkillVersion | null>(null);
  const [pack, setPack] = useState<BrowsePack | null>(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<SkillRow | null>(null);
  const [hist, setHist] = useState<SkillVersion[] | null>(null);
  const [body, setBody] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const [installName, setInstallName] = useState("");
  const [installKind, setInstallKind] = useState<"skill" | "plugin">("skill");
  const [installBody, setInstallBody] = useState("");
  const [installPlugin, setInstallPlugin] = useState<PluginManifest>(() => emptyPlugin("my-plugin"));
  const [connections, setConnections] = useState<ConnectionPick[]>([]);
  const [busy, setBusy] = useState(false);
  const can = pack?.can || { draft: {}, approve: {}, plugin: {} };
  const loadConnections = useCallback(() => {
    call("connectors.connection.list", {}).then((r) => {
      if (r.error) return;
      setConnections(pickConnections(r.data).map((c) => ({ id: c.id, label: c.label || c.id })));
    }).catch(() => setConnections([]));
  }, []);
  useEffect(() => { if (installOpen && installKind === "plugin") loadConnections(); }, [installOpen, installKind, loadConnections]);
  const load = useCallback(() => {
    setErr("");
    browse(level).then(setPack).catch((e) => setErr(errWords(e)));
  }, [level]);
  useEffect(load, [load]);
  const act = (run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    run().then(() => { showToast(done); load(); if (pick) open(pick); }).catch((e) => showToast(errWords(e))).finally(() => setBusy(false));
  };
  const open = (s: SkillRow) => {
    setPick(s); setHist(null); setBody("");
    get(s.id).then((g) => setBody(g.text || "")).catch((e) => showToast(errWords(e)));
    const parts = s.id.split("/");
    const lv = s.level || parts[0];
    const scope = s.scope || (lv === "agent" || lv === "project" ? parts[1] : "");
    versions(s.name, lv, scope).then((v) => setHist(v.versions || [])).catch(() => setHist([]));
  };
  const harnessChips = (h?: string[]) => (h && h.length ? h : [...AIS]).map((x) => <Chip key={x} tone="plain">{x}</Chip>);
  const mayDraft = Boolean(can.draft?.[level]);
  const mayPlugin = Boolean(can.plugin?.[level]);
  const onInstallName = (name: string) => {
    setInstallName(name);
    if (installKind === "plugin") setInstallPlugin((p) => ({ ...p, name: name.trim() || p.name }));
  };
  const list = pack ? listRows(pack, segment) : [];
  const noun = segment === "plugins" ? "plugin" : "skill";
  const sub = level === "personal" ? "Only you use these." : level === "space" ? "Everyone in this Space uses these. Members draft, owners and admins approve." : "Browse, draft, approve or roll back.";
  return (
    <Frame back="/u/settings" title="Skills and plugins" sub={sub}
      actions={mayDraft ? <Button size="md" kind="primary" icon="plus" label="New" onPress={() => { setInstallName(""); setInstallKind(segment === "plugins" && mayPlugin ? "plugin" : "skill"); setInstallBody(skillTpl("my-skill")); setInstallPlugin(emptyPlugin("my-plugin")); setInstallOpen(true); }} /> : undefined}>
      {pack?.identityPersonal && level === "personal" ? <Banner><Text size="caption">Personal skills are kept on your identity and follow you into every Space you belong to.</Text></Banner> : null}
      <View className="gap-s2">
        <Segmented label="Show" value={segment} onChange={(v) => setSegment(v as "skills" | "plugins")} options={SEGMENTS.map(([k, v]) => [k, v] as [string, string])} />
        {asked ? null : <Segmented label="Level" value={level} onChange={setLevel} options={LEVELS.map((l) => [l.id, l.label] as [string, string])} />}
      </View>
      {err ? <Card flush><ErrorState title="Skills did not load" reason={err} retry={load} /></Card> : null}
      {pack === null && !err ? <LoadingState rows={4} /> : null}
      {pack && !list.length ? <Card><EmptyState title={`No ${noun}s here yet`} body={mayDraft ? `Add one with New, or ask your assistant to draft one.` : "Ask an owner or admin to add one for the Space."} /></Card> : null}
      {list.length ? (
        <Card flush>
          {list.map((r, i) => (
            <View key={r.key}>{i ? <Divider /> : null}
              <Row title={r.name} sub={r.sub} state={r.state} chevron onPress={() => (r.draft && r.version ? setDraftPick(r.version) : r.skill ? open(r.skill) : undefined)} />
            </View>
          ))}
        </Card>
      ) : null}

      <Sheet open={!!pick} onClose={() => setPick(null)} title={pick?.name || ""}>
        {pick ? (
          <View className="gap-s3">
            <Text tone="muted">{[stateWord("approved"), pick.description].filter(Boolean).join(". ")}</Text>
            {needsLines(pick.declares).length ? <View className="gap-s1"><Text size="caption" strong tone="label">Needs</Text>{needsLines(pick.declares).map((l) => <Text key={l} size="secondary">{l}</Text>)}</View> : null}
            <Text size="caption" strong tone="label">Versions</Text>
            {hist ? (
              <Card flush>
                {hist.map((v, i) => (
                  <View key={v.version}>{i ? <Divider /> : null}
                    <Row title={versionLine(v)} sub={v.proposer ? `proposed by ${v.proposer}` : undefined}
                      end={v.state === "retired" && can.approve?.[v.level] ? <Button size="md" label="Roll back" disabled={busy} onPress={() => act(() => rollback({ name: v.name, level: v.level, scope: v.scope, to: v.version, ...(v.ack ? { ack: v.ack } : {}) }), "Rolled back.")} /> : undefined} />
                  </View>
                ))}
              </Card>
            ) : <LoadingState rows={2} />}
            <Text size="caption" strong tone="label">Text</Text>
            <Card><Text mono size="caption">{body.slice(0, 4000)}{body.length > 4000 ? "\n…" : ""}</Text></Card>
            <View className="flex-row flex-wrap gap-s1">{harnessChips(pick.harnesses)}</View>
          </View>
        ) : null}
      </Sheet>

      <Sheet open={!!draftPick} onClose={() => setDraftPick(null)} title={draftPick?.name || ""}>
        {draftPick ? (
          <View className="gap-s3">
            <Text tone="muted">{`${stateWord("draft")}. ${versionLine(draftPick)}${draftPick.proposer ? `, proposed by ${draftPick.proposer}` : ""}.`}</Text>
            {needsLines(draftPick.declares).length ? <View className="gap-s1"><Text size="caption" strong tone="label">Needs</Text>{needsLines(draftPick.declares).map((l) => <Text key={l} size="secondary">{l}</Text>)}</View> : null}
            <View className="flex-row flex-wrap gap-s2">
              {can.approve?.[draftPick.level] ? <Button size="md" kind="primary" label="Approve" disabled={busy} onPress={() => act(() => approve({ name: draftPick.name, level: draftPick.level, scope: draftPick.scope, version: draftPick.version, ...(draftPick.ack ? { ack: draftPick.ack } : {}) }).then(() => setDraftPick(null)), "Approved.")} /> : null}
              <Button size="md" kind="ghost" label="Decline" disabled={busy} onPress={() => act(() => decline({ name: draftPick.name, level: draftPick.level, scope: draftPick.scope, version: draftPick.version }).then(() => setDraftPick(null)), "Turned down.")} />
            </View>
          </View>
        ) : null}
      </Sheet>
      <Sheet open={installOpen} onClose={() => setInstallOpen(false)} title="Install at this level">
        <View className="gap-s3">
          <Field label="Name" value={installName} onChangeText={onInstallName} placeholder="house-style" />
          <View className="flex-row gap-s2">
            <Button size="md" label="Skill" kind={installKind === "skill" ? "primary" : "ghost"} onPress={() => { setInstallKind("skill"); if (!installBody.trim()) setInstallBody(skillTpl(installName || "my-skill")); }} />
            {mayPlugin ? <Button size="md" label="Plugin" kind={installKind === "plugin" ? "primary" : "ghost"} onPress={() => { setInstallKind("plugin"); setInstallPlugin(emptyPlugin(installName || "my-plugin")); loadConnections(); }} /> : null}
          </View>
          {installKind === "skill" ? (
            <Field label="SKILL.md" value={installBody} onChangeText={setInstallBody} multiline />
          ) : (
            <PluginEditor value={installPlugin} onChange={setInstallPlugin} connections={connections} />
          )}
          <Button kind="primary" label="Save draft" disabled={busy || !installName.trim()} onPress={() => act(async () => {
            const bodyText = installKind === "plugin" ? pluginBody({ ...installPlugin, name: installName.trim() }) : installBody;
            await draft({ name: installName.trim(), level, kind: installKind, body: bodyText });
            setInstallOpen(false);
          }, "Draft saved. Approve it when you are ready.")} />
        </View>
      </Sheet>
    </Frame>
  );
}
