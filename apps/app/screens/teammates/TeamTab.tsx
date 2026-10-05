import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Select, Switch, Text, markRef, showToast } from "@vyre/ui";
import { ROLE, dutyLine, errWords, fillLine, plural, rowLine, stateWord, type Pane, type Teammate } from "./model";
import { teammates } from "./teammates";
import { useTeam } from "./useTeam";

/** One teammate, opened: what it is doing, its last result, notes, and its setup (who fills it, charter, duties). Every value is drawn as text. */
function TeammatePane({ t, project, done }: { t: Teammate; project: string; done: () => void }) {
  const [p, setP] = useState<Pane | null>(null);
  const [fillers, setFillers] = useState<string[]>([]);
  const [edit, setEdit] = useState<"" | "notes" | "charter">("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [sure, setSure] = useState(false);
  const read = useCallback(() => { void teammates.pane(t).then(setP); }, [t.agent, t.current]);
  useEffect(() => { read(); void teammates.fillers().then(setFillers); }, [read]);
  const act = async (name: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(name);
    try { await fn(); after?.(); read(); done(); } catch (e) { showToast(errWords(e)); } finally { setBusy(""); }
  };
  if (!p) return <LoadingState rows={2} />;
  const open = (kind: "notes" | "charter") => { setText((kind === "notes" ? p.notes : p.charter) || ""); setEdit(kind); };
  return (
    <View className="gap-s4 p-s3">
      <View className="gap-s1">
        <Text size="caption" strong tone="label">Now</Text>
        <Text>{p.status && t.current ? `${stateWord(p.status.state)}${p.status.position != null ? `, position ${p.status.position}` : ""}` : "Nothing running."}</Text>
        {t.queued ? <Text size="caption" tone="label">{`${plural(t.queued, "request")} waiting in its inbox.`}</Text> : null}
      </View>
      <View className="gap-s1">
        <Text size="caption" strong tone="label">Last result</Text>
        <Text>{t.last ? (t.last.state === "failed" ? "Failed: " : "") + t.last.result : "No finished work yet."}</Text>
      </View>
      <View className="gap-s2">
        <Text size="caption" strong tone="label">Notes</Text>
        {p.notes == null ? <Text tone="muted">Notes could not be read.</Text> : edit === "notes" ? (
          <>
            <Field name={`${t.role} notes`} value={text} onChangeText={setText} multiline lines={8} />
            <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Save notes" loading={busy === "notes"} onPress={() => void act("notes", () => teammates.setNotes(t.agent, text), () => setEdit(""))} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setEdit("")} /></View>
          </>
        ) : (<><Text>{p.notes || "No notes yet."}</Text><View className="flex-row"><Button kind="ghost" size="sm" label="Edit notes" onPress={() => open("notes")} /></View></>)}
      </View>
      <View className="gap-s3">
        <Text size="caption" strong tone="label">Setup</Text>
        <Select label={`Who fills ${t.role}`} value={t.filler || ""} options={[["", "The project's helper"], ...fillers.map((a): [string, string] => [a, a])]} onChange={(v: string) => void act("fill", () => teammates.fill(t.agent, v))} />
        <View className="gap-s2">
          <Text strong>Charter</Text>
          {edit === "charter" ? (
            <>
              <Field name={`${t.role} charter`} value={text} onChangeText={setText} multiline lines={8} />
              <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Save charter" loading={busy === "charter"} onPress={() => void act("charter", () => teammates.setCharter(t.agent, text), () => setEdit(""))} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setEdit("")} /></View>
            </>
          ) : (
            <>
              <Text>{p.charter || "No charter yet."}</Text>
              <View className="flex-row flex-wrap gap-s2"><Button kind="ghost" size="sm" label="Edit" onPress={() => open("charter")} /><Button kind="ghost" size="sm" label={busy === "draft" ? "Drafting" : "Draft it from the project"} disabled={busy === "draft"} onPress={() => void act("draft", () => teammates.draftCharter(t.agent))} /></View>
            </>
          )}
        </View>
        <View className="gap-s2">
          <Text strong>Duties</Text>
          {p.duties.length ? p.duties.map((d) => (
            <View key={d.id} className="gap-s1">
              {d.title ? <Text strong>{d.title}</Text> : null}
              <Text>{d.instruction}</Text>
              {dutyLine(d) ? <Text size="caption" tone="label">{dutyLine(d)}</Text> : null}
              <View className="flex-row flex-wrap gap-s2">
                <Button kind="ghost" size="sm" label={d.enabled ? "Pause" : "Turn on"} disabled={busy === `duty${d.id}`} onPress={() => void act(`duty${d.id}`, () => (d.enabled ? teammates.dutyOff(d) : teammates.dutyOn(d)))} />
                {d.enabled ? <Button kind="ghost" size="sm" label="Run now" onPress={() => void act(`run${d.id}`, () => teammates.dutyRun(d))} /> : null}
              </View>
            </View>
          )) : <Text tone="muted">No duties.</Text>}
        </View>
        {sure ? (
          <View className="gap-s2">
            <Text tone="muted">{`Retire ${t.role}? Its notes and history are kept, and adding ${t.role} again brings it back.`}</Text>
            <View className="flex-row gap-s2"><Button size="sm" label="Retire" loading={busy === "retire"} onPress={() => void act("retire", () => teammates.retire(t.agent), () => setSure(false))} /><Button kind="ghost" size="sm" label="Keep" onPress={() => setSure(false)} /></View>
          </View>
        ) : <View className="flex-row"><Button kind="ghost" size="sm" label={`Retire ${t.role}`} onPress={() => setSure(true)} /></View>}
      </View>
    </View>
  );
}

export function TeammateRow({ t, project, open, onToggle, reload }: { t: Teammate; project: string; open: boolean; onToggle: () => void; reload: () => void }) {
  return (
    <View>
      <Row lead={<Avatar of={markRef("teammate", t.role, t.agent)} size={40} />} title={t.role} sub={[fillLine(t), rowLine(t)].filter(Boolean).join("\n")} end={<Chip tone={t.state === "failed" ? "warn" : "plain"}>{stateWord(t.state)}</Chip>} onPress={onToggle} accessibilityLabel={`${t.role}, ${stateWord(t.state)}`} />
      {open ? <><Divider /><TeammatePane t={t} project={project} done={reload} /></> : null}
    </View>
  );
}

/** Add a teammate: a role (one lowercase word) and, if the person likes, what work goes to it. */
export function AddTeammate({ project, done }: { project: string; done: () => void }) {
  const [on, setOn] = useState(false);
  const [role, setRole] = useState("");
  const [brief, setBrief] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!on) return <View className="flex-row"><Button label="Add a teammate" onPress={() => setOn(true)} /></View>;
  const go = async () => {
    const r = role.trim().toLowerCase();
    if (!ROLE.test(r)) { setErr("A role is one lowercase word, like design."); return; }
    setBusy(true); setErr("");
    try { await teammates.add(project, r, brief); setOn(false); setRole(""); setBrief(""); done(); } catch (e) { setErr(errWords(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="gap-s3">
      <Field label="Role" name="Role" value={role} onChangeText={setRole} placeholder="A role, like design or backend" error={err} />
      <Field label="What goes to it" name="What goes to it" value={brief} onChangeText={setBrief} placeholder="What work goes to it (optional)" />
      <View className="flex-row gap-s2"><Button kind="primary" label="Add" loading={busy} onPress={() => void go()} /><Button kind="ghost" label="Cancel" onPress={() => { setOn(false); setErr(""); }} /></View>
    </Card>
  );
}

/** The project page's Team tab: the teammates that serve the project, and what each is doing. `project` is the Project record's id. */
export function TeamTab({ project }: { project: string }) {
  const { rows, error, steer, reload } = useTeam(project);
  const [open, setOpen] = useState("");
  const [busy, setBusy] = useState(false);
  if (rows === null) return <LoadingState rows={3} />;
  if (error) return <Card flush><ErrorState title="Teammates could not be read" reason={error} retry={reload} /></Card>;
  const flip = async (on: boolean) => { setBusy(true); try { await teammates.setSteer(project, on); reload(); } catch (e) { showToast(errWords(e)); } finally { setBusy(false); } };
  return (
    <View className="gap-s4">
      {steer != null ? <Card><View className="flex-row items-center gap-s3"><View className="min-w-0 flex-1"><Text strong>Steer new work to teammates</Text><Text size="caption" tone="label">New work in this project goes to a teammate by role.</Text></View><Switch on={steer} label="Steer new work to teammates" disabled={busy} onChange={(v) => void flip(v)} /></View></Card> : null}
      {rows.length ? (
        <Card flush title="Teammates" actions={<Text size="caption" tone="label">{plural(rows.length, "teammate")}</Text>}>
          {rows.map((t, i) => <View key={t.agent}>{i ? <Divider /> : null}<TeammateRow t={t} project={project} open={open === t.agent} onToggle={() => setOpen(open === t.agent ? "" : t.agent)} reload={reload} /></View>)}
        </Card>
      ) : <Card><EmptyState title="No teammates yet" body="A teammate is a role in this project, like design or backend, that keeps its own notes and takes work in order." /></Card>}
      <AddTeammate project={project} done={reload} />
    </View>
  );
}

