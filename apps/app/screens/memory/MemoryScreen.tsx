import { useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Divider, EmptyState, Field, Segmented, Text, showToast, type IconName } from "@vyre/ui";
import { Note, Page, Section, SpaceChip } from "../places/Page";
import { SPACES, useScope } from "../places/scope";
import { memoryRepo, SUBJECTS, type Fact } from "./data";
import { answer, edit, forget, group, restore, visible } from "./logic.js";

const SRC_ICON: Record<Fact["src"]["kind"], IconName> = { record: "file", file: "file", chat: "chat", email: "send", flow: "refresh" };

export default function MemoryScreen() {
  const scope = useScope((s) => s.scope);
  const router = useRouter();
  const [facts, setFacts] = useState<Fact[]>(() => memoryRepo.facts());
  const [mode, setMode] = useState<Fact["kind"]>("person");
  const [q, setQ] = useState("Jane");
  const [asked, setAsked] = useState("Jane");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [undo, setUndo] = useState<{ fact: Fact; index: number } | null>(null);

  const shown = useMemo(() => visible(facts, scope), [facts, scope]);
  const sections = useMemo(() => group(shown, mode), [shown, mode]);
  const ans = useMemo(() => (asked ? answer(facts, SUBJECTS, asked, scope) : null), [facts, asked, scope]);
  const sealed = memoryRepo.sealed().filter((s) => scope === "all" || s.space === scope);
  const open = (s: Fact["src"]) => (s.target ? router.push(`/u/${s.target}` as never) : showToast(`Opened ${s.label}.`));

  const row = (f: Fact) => {
    const isEdit = editing?.id === f.id;
    return (
      <View key={f.id} className="gap-s2 px-s4 py-s3">
        {isEdit ? (
          <View className="gap-s2">
            <Field label="Fact" value={editing.text} onChangeText={(text) => setEditing({ id: f.id, text })} />
            <View className="flex-row gap-s2">
              <Button kind="primary" size="sm" label="Save" onPress={() => { setFacts((xs) => edit(xs, f.id, editing.text)); setEditing(null); showToast("Saved. Assistants recall the new wording."); }} />
              <Button kind="ghost" size="sm" label="Cancel" onPress={() => setEditing(null)} />
            </View>
          </View>
        ) : <Text>{f.text}</Text>}
        <View className="flex-row flex-wrap items-center gap-x-s3 gap-y-s2">
          <Button size="sm" kind="secondary" icon={SRC_ICON[f.src.kind]} label={f.src.label} onPress={() => open(f.src)} />
          <Text size="caption" tone="label">Learned by {memoryRepo.assistantName(f.by)}, {f.when}</Text>
          <Text size="caption" tone="label">Used {f.used} {f.used === 1 ? "time" : "times"}</Text>
          <SpaceChip sp={f.sp} />
        </View>
        {isEdit ? null : (
          <View className="flex-row gap-s2">
            <Button kind="ghost" size="sm" label="Edit" onPress={() => setEditing({ id: f.id, text: f.text })} />
            <Button kind="danger" size="sm" label="Forget" onPress={() => { const r = forget(facts, f.id); setFacts(r.facts); setUndo(r.undo); }} />
          </View>
        )}
      </View>
    );
  };

  return (
    <Page title="Memory" sub="What Vyre knows, and where each fact came from.">
      {scope === "mine" ? <Note title="This is the Mine boundary." body="Facts from Harlow Legal never show here, and your assistants do not carry them into Mine." /> : null}
      {scope === "harlow" ? <Note title="This is the Harlow Legal boundary." body="Facts here stay in Harlow Legal. Members with the right role can read them. Your own Mine facts are not shown." /> : null}

      <Card title="Ask Memory">
        <View className="gap-s3">
          <Field value={q} onChangeText={setQ} placeholder="Who or what?" />
          <View className="self-start"><Button kind="primary" label={`What do we know about ${q.trim() || "..."}`} onPress={() => setAsked(q)} /></View>
          {ans?.kind === "ok" ? (
            <View className="gap-s2">
              <Text size="read"><Text strong size="read">{ans.name}</Text>{": "}{ans.items.map((it) => `${it.fact.text} [${it.n}]`).join(" ")}</Text>
              <View className="gap-s1">
                {ans.items.map((it) => (
                  <Text key={it.n} size="caption" tone="label">[{it.n}] {it.fact.src.label}, {it.fact.when}</Text>
                ))}
              </View>
              {memoryRepo.sealed().some((s) => s.subject === ans.name && (scope === "all" || s.space === scope)) ? (
                <Chip tone="sealed" icon="shield">{`Not included: ${memoryRepo.sealed().find((s) => s.subject === ans.name)?.labels.join(", ")}`}</Chip>
              ) : null}
            </View>
          ) : null}
          {ans?.kind === "boundary" ? <Note tone="warn" title={`Nothing in ${scope === "all" ? "this view" : SPACES[scope].name} about "${asked}".`} body="Memory does not cross spaces unless a space shares it. Switch to All spaces, or to another space, to ask there." /> : null}
          {ans?.kind === "none" ? <Text tone="muted">Nothing remembered about {ans.name}.</Text> : null}
        </View>
      </Card>

      {undo ? (
        <Banner>
          <View className="flex-row flex-wrap items-center gap-s3">
            <Text className="min-w-0 flex-1">Forgot one fact. It is gone from Memory and from what assistants recall.</Text>
            <Button size="sm" label="Undo" onPress={() => { setFacts((xs) => restore(xs, undo)); setUndo(null); }} />
          </View>
        </Banner>
      ) : null}

      <Segmented label="Facts by" value={mode} onChange={setMode} options={[["person", "People"], ["project", "Projects"], ["space", "Spaces"]]} />

      {sections.length ? sections.map((s) => (
        <Section key={s.key} title={mode === "space" ? SPACES[s.sp as "mine"].name : SUBJECTS[s.subj] ?? s.subj} meta={`${s.facts.length} ${s.facts.length === 1 ? "fact" : "facts"}`}>
          <Card flush>{s.facts.map((f, i) => <View key={f.id}>{i ? <Divider /> : null}{row(f)}</View>)}</Card>
        </Section>
      )) : <Card><EmptyState title="Nothing here yet" body={`No ${mode} facts in this space.`} /></Card>}

      {sealed.length ? (
        <Note title="Not remembered" body={sealed.map((s) => `Sealed fields are never read into Memory: ${s.subject} has ${s.labels.length} (${s.labels.join(", ")}). Assistants see "SSN on file, sealed" and nothing more.`).join(" ")} />
      ) : null}
    </Page>
  );
}
