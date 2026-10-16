import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, LoadingState, Row, Sheet, Text, showToast } from "@vyre/ui";
import { Frame, Sec } from "../places/Frame";
import { IconTile } from "../places/Page";
import { browse, get, versions, type SkillRow, type SkillVersion } from "./skills";

const LEVELS = [
  { id: "personal", label: "Mine (identity)" },
  { id: "space", label: "This Space" },
  { id: "agent", label: "Agent" },
  { id: "project", label: "Project" },
] as const;

const errWords = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");

export function RealSkills() {
  const [level, setLevel] = useState<string>("space");
  const [rows, setRows] = useState<SkillRow[] | null>(null);
  const [drafts, setDrafts] = useState<SkillVersion[]>([]);
  const [identityPersonal, setIdentityPersonal] = useState(false);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<SkillRow | null>(null);
  const [hist, setHist] = useState<SkillVersion[] | null>(null);
  const [body, setBody] = useState("");
  const load = useCallback(() => {
    setErr("");
    browse(level).then((r) => { setRows(r.skills || []); setDrafts(r.drafts || []); setIdentityPersonal(Boolean(r.identityPersonal)); }).catch((e) => setErr(errWords(e)));
  }, [level]);
  useEffect(load, [load]);
  const open = (s: SkillRow) => {
    setPick(s); setHist(null); setBody("");
    get(s.id).then((g) => setBody(g.text || "")).catch((e) => showToast(errWords(e)));
    const parts = s.id.split("/");
    const lv = s.level || parts[0];
    const scope = s.scope || (lv === "agent" || lv === "project" ? parts[1] : "");
    const name = s.name;
    versions(name, lv, scope).then((v) => setHist(v.versions || [])).catch(() => setHist([]));
  };
  return (
    <Frame back="/u/playbooks" title="Skills and plugins" sub="Browse, draft and approve skills at each level. Space skills apply to every session and cannot be overridden by a personal skill with the same name.">
      {identityPersonal && level === "personal" ? <Banner><Text size="caption">Personal skills are kept on your identity and follow you into every Space you belong to.</Text></Banner> : null}
      <Sec title="Level">
        <Card flush>
          {LEVELS.map((l, i) => (
            <View key={l.id}>{i ? <Divider /> : null}
              <Row lead={<IconTile icon="spark" />} title={l.label} end={level === l.id ? <Chip tone="ok">Showing</Chip> : <Button size="sm" label="Show" onPress={() => setLevel(l.id)} />} />
            </View>
          ))}
        </Card>
      </Sec>
      <Sec title="In use">
        {err ? <Card flush><ErrorState title="Skills did not load" reason={err} retry={load} /></Card> : null}
        {rows === null && !err ? <LoadingState rows={4} /> : null}
        {rows && !rows.length ? <Card><EmptyState title="Nothing at this level yet" body="Draft a skill from chat or ask your assistant to propose one; approve it in Now or here." /></Card> : null}
        {rows && rows.length ? (
          <Card flush>
            {rows.map((s, i) => (
              <View key={s.id}>{i ? <Divider /> : null}
                <Row lead={<IconTile icon="spark" />} title={s.name} sub={[s.level, s.scope, s.description].filter(Boolean).join(" · ")} end={<Button size="sm" label="Open" onPress={() => open(s)} />} />
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
                <Row title={d.name} sub={`${d.level} · version ${d.version}`} end={<Chip>draft</Chip>} />
              </View>
            ))}
          </Card>
        </Sec>
      ) : null}
      <Sheet open={!!pick} onClose={() => setPick(null)} title={pick?.name || ""}>
        {pick ? (
          <View className="gap-s3">
            <Text size="caption" tone="label">{pick.id}</Text>
            <Card><Text mono size="caption">{body.slice(0, 4000)}{body.length > 4000 ? "\n…" : ""}</Text></Card>
            {hist ? (
              <Card flush>
                {hist.map((v, i) => (
                  <View key={v.version}>{i ? <Divider /> : null}
                    <Row title={`Version ${v.version}`} sub={v.state} end={v.state === "approved" ? <Chip tone="ok">live</Chip> : null} />
                  </View>
                ))}
              </Card>
            ) : <LoadingState rows={2} />}
            <Text size="caption" tone="label">Approve or roll back from Now, chat, or skills.approve. Plugins with hooks or MCP servers need the acknowledgement the draft shows.</Text>
          </View>
        ) : null}
      </Sheet>
    </Frame>
  );
}
