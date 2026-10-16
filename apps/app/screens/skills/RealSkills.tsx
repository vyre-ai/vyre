import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Sheet, Text, showToast } from "@vyre/ui";
import { Frame, Sec } from "../places/Frame";
import { IconTile } from "../places/Page";
import { browse, get, versions, draft, approve, rollback, decline, type SkillRow, type SkillVersion, type BrowsePack } from "./skills";
import { callT as call } from "../../src/real/call-tool";
import { pickConnections } from "../connections/model";
const AIS = ["claude", "codex", "grok"] as const;
import { PluginDeclaresView, PluginEditor, type ConnectionPick } from "./PluginEditor";
import { emptyPlugin, pluginBody, type PluginManifest } from "./plugin-model";

const LEVELS = [
  { id: "personal", label: "Mine (identity)" },
  { id: "space", label: "This Space" },
  { id: "agent", label: "Agent" },
  { id: "project", label: "Project" },
] as const;

const errWords = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");
const skillTpl = (name: string) => `---\nname: ${name}\ndescription: Use when the work is about ${name}.\n---\n\n# ${name}\n\nSteps.\n`;

export function RealSkills() {
  const [level, setLevel] = useState<string>("space");
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
  const rows = pack?.skills || [];
  const drafts = pack?.drafts || [];
  const mayDraft = Boolean(can.draft?.[level]);
  const mayPlugin = Boolean(can.plugin?.[level]);
  const onInstallName = (name: string) => {
    setInstallName(name);
    if (installKind === "plugin") setInstallPlugin((p) => ({ ...p, name: name.trim() || p.name }));
  };
  return (
    <Frame back="/u/playbooks" title="Skills and plugins" sub="Browse, install, draft, approve or roll back. Space skills apply to every session and cannot be overridden by a personal skill with the same name.">
      {pack?.identityPersonal && level === "personal" ? <Banner><Text size="caption">Personal skills are kept on your identity and follow you into every Space you belong to.</Text></Banner> : null}
      {pack?.role ? <Banner><Text size="caption">You are signed in as {pack.role} for this Space.</Text></Banner> : null}
      <Sec title="Level">
        <Card flush>
          {LEVELS.map((l, i) => (
            <View key={l.id}>{i ? <Divider /> : null}
              <Row lead={<IconTile icon="spark" />} title={l.label} end={level === l.id ? <Chip tone="ok">Showing</Chip> : <Button size="md" label="Show" onPress={() => setLevel(l.id)} />} />
            </View>
          ))}
        </Card>
      </Sec>
      {mayDraft ? (
        <Sec title="Install">
          <Card>
            <View className="flex-row flex-wrap gap-s2">
              <Button size="md" kind="primary" label="New skill or plugin" onPress={() => { setInstallName(""); setInstallKind("skill"); setInstallBody(skillTpl("my-skill")); setInstallPlugin(emptyPlugin("my-plugin")); setInstallOpen(true); }} />
            </View>
          </Card>
        </Sec>
      ) : null}
      <Sec title="In use">
        {err ? <Card flush><ErrorState title="Skills did not load" reason={err} retry={load} /></Card> : null}
        {pack === null && !err ? <LoadingState rows={4} /> : null}
        {pack && !rows.length ? <Card><EmptyState title="Nothing at this level yet" body={mayDraft ? "Install a skill or plugin, or ask your assistant to draft one." : "Ask an owner or admin to add a Space skill."} /></Card> : null}
        {rows.length ? (
          <Card flush>
            {rows.map((s, i) => (
              <View key={s.id}>{i ? <Divider /> : null}
                <Row lead={<IconTile icon="spark" />} title={s.name} sub={[s.level, s.scope, s.description].filter(Boolean).join(" · ")}
                  end={<View className="flex-row flex-wrap items-center gap-s1 max-w-[45%] justify-end">{harnessChips(s.harnesses)}<Button size="md" label="Open" onPress={() => open(s)} /></View>} />
              </View>
            ))}
          </Card>
        ) : null}
      </Sec>
      {drafts.length ? (
        <Sec title="Drafts waiting for a yes">
          <Card flush>
            {drafts.map((d, i) => (
              <View key={`${d.name}-${d.version}`}>{i ? <Divider /> : null}
                <Row title={d.name} sub={`${d.level} · version ${d.version}${d.proposer ? ` · ${d.proposer}` : ""}`}
                  end={<View className="flex-row gap-s2 flex-wrap justify-end">
                    {can.approve?.[d.level] ? <Button size="md" kind="primary" label="Approve" disabled={busy} onPress={() => act(() => approve({ name: d.name, level: d.level, scope: d.scope, version: d.version, ...(d.ack ? { ack: d.ack } : {}) }), "Approved.")} /> : null}
                    <Button size="md" kind="ghost" label="Decline" disabled={busy} onPress={() => act(() => decline({ name: d.name, level: d.level, scope: d.scope, version: d.version }), "Turned down.")} />
                  </View>} />
              </View>
            ))}
          </Card>
        </Sec>
      ) : null}
      <Sheet open={!!pick} onClose={() => setPick(null)} title={pick?.name || ""}>
        {pick ? (
          <View className="gap-s3">
            <View className="flex-row flex-wrap gap-s1">{harnessChips(pick.harnesses)}</View>
            <Text size="caption" tone="label">{pick.id}</Text>
            <PluginDeclaresView declares={pick.declares} />
            <Card><Text mono size="caption">{body.slice(0, 4000)}{body.length > 4000 ? "\n…" : ""}</Text></Card>
            {hist ? (
              <Card flush>
                {hist.map((v, i) => (
                  <View key={v.version}>{i ? <Divider /> : null}
                    <Row title={`Version ${v.version}`} sub={v.state}
                      end={<View className="flex-row gap-s2">
                        {v.state === "approved" ? <Chip tone="ok">live</Chip> : null}
                        {v.state === "retired" && can.approve?.[v.level] ? <Button size="md" label="Roll back" disabled={busy} onPress={() => act(() => rollback({ name: v.name, level: v.level, scope: v.scope, to: v.version, ...(v.ack ? { ack: v.ack } : {}) }), "Rolled back.")} /> : null}
                      </View>} />
                  </View>
                ))}
              </Card>
            ) : <LoadingState rows={2} />}
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
