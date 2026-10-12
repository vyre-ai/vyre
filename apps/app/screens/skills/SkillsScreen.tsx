// Skills for a member of a joined team: the Space's skills and her own, through the team's door (skills.list, get, draft, approve). The Space's carry the space's tag, her own the Personal tag; "Propose" says what happens next.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Divider, EmptyState, Field, LoadingState, Row, Segmented, SpaceTag, Text } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { callT } from "../../src/real/call-tool";
import { showingJoined } from "../../src/real/team-join";
import { usePlaceText } from "../../src/real/PlaceTag";
import { MINE_WORDS, SPACE_WORDS, checkProposal, nextWords, skillsView } from "./skills-model.js";

export default function SkillsScreen() {
  const spaceTag = usePlaceText("showing");
  const homeTag = usePlaceText("home");
  const [joined, setJoined] = useState<boolean | null>(null);
  const [view, setView] = useState<ReturnType<typeof skillsView> | null>(null);
  const [problem, setProblem] = useState("");
  const [said, setSaid] = useState("");
  const [shown, setShown] = useState<{ name: string; text: string } | null>(null);
  const [form, setForm] = useState({ name: "", description: "", instructions: "" });
  const [level, setLevel] = useState<"space" | "personal">("space");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void showingJoined().catch(() => false).then(async (j) => {
      setJoined(j);
      if (!j) return;
      const r = await callT("skills.list", {});
      if (r.error) { setProblem(r.error.message); setView({ mine: [], space: [], vyre: [] }); return; }
      setProblem(""); setView(skillsView(r.data));
    });
  }, []);
  useEffect(load, [load]);
  const read = async (id: string, name: string) => {
    setProblem("");
    const r = await callT<{ text?: string }>("skills.get", { id });
    if (r.error) { setProblem(r.error.message); return; }
    setShown({ name, text: String(r.data?.text ?? "") });
  };
  const propose = async () => {
    setProblem(""); setSaid("");
    const ok = checkProposal({ ...form, level });
    if ("error" in ok) { setProblem(ok.error); return; }
    setBusy(true);
    const drafted = await callT<{ version?: number }>("skills.draft", ok.input);
    if (drafted.error) { setBusy(false); setProblem(drafted.error.message); return; }
    if (level === "personal") {
      const approved = await callT("skills.approve", { name: ok.input.name, level: "personal", version: drafted.data?.version });
      if (approved.error) { setBusy(false); setProblem(approved.error.message); return; }
    }
    setBusy(false); setSaid(nextWords(level, ok.input.name)); setForm({ name: "", description: "", instructions: "" }); load();
  };
  if (joined === null) return <Frame title="Skills" back="/u/settings"><LoadingState rows={3} /></Frame>;
  if (!joined) return <Frame title="Skills" back="/u/settings"><EmptyState title="Skills of a team you joined show here" body="Open a team you have joined, and its skills and your own appear on this screen." /></Frame>;
  const list = (rows: { id: string; name: string; description: string }[], tag: string | null) => (
    <Card flush>{rows.map((r, i) => (<View key={r.id}>{i ? <Divider /> : null}<Row title={r.name} sub={r.description} end={tag ? <SpaceTag text={tag} /> : undefined} onPress={() => void read(r.id, r.name)} /></View>))}</Card>
  );
  return (
    <Frame title="Skills" back="/u/settings">
      {view === null ? <LoadingState rows={3} /> : null}
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
      {said ? <Text size="caption" tone="ok">{said}</Text> : null}
      {view ? (
        <View className="gap-s3">
          <View className="gap-s2"><Text size="caption" strong tone="label">{SPACE_WORDS}</Text>{[...view.space, ...view.vyre].length ? list([...view.space, ...view.vyre], spaceTag) : <Card><EmptyState title="No skills yet" body="The team has none approved yet. Propose one below." /></Card>}</View>
          <View className="gap-s2"><Text size="caption" strong tone="label">{MINE_WORDS}</Text>{view.mine.length ? list(view.mine, homeTag) : <Card><EmptyState title="You have none yet" body="Propose one for just you below, and it is yours at once." /></Card>}</View>
          {shown ? <Card><View className="gap-s2"><Text strong>{shown.name}</Text><Text mono>{shown.text}</Text><View className="flex-row"><Button kind="ghost" size="sm" label="Close" onPress={() => setShown(null)} /></View></View></Card> : null}
          <Card>
            <View className="gap-s2">
              <Text strong>Propose a skill</Text>
              <Segmented label="For" value={level} onChange={setLevel} options={[["space", "The team"], ["personal", "Just me"]]} />
              <Text size="caption" tone="label">{level === "space" ? "The owner or an admin approves it before the team can use it." : "It is yours at once: only you and your assistant use it."}</Text>
              <Field name="Name" value={form.name} onChangeText={(v: string) => setForm({ ...form, name: v })} placeholder="intake-checklist" />
              <Field name="What it is for (one line)" value={form.description} onChangeText={(v: string) => setForm({ ...form, description: v })} />
              <Field name="Instructions" value={form.instructions} onChangeText={(v: string) => setForm({ ...form, instructions: v })} multiline lines={6} />
              <View className="flex-row"><Button kind="primary" size="sm" label={busy ? "Sending" : level === "space" ? "Send for approval" : "Add it"} disabled={busy} onPress={() => void propose()} /></View>
            </View>
          </Card>
        </View>
      ) : null}
    </Frame>
  );
}
