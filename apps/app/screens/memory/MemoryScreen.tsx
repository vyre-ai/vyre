import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Composer, Divider, EmptyState, Field, Icon, IconButton, Menu, Row, Segmented, Sheet, SpaceMark, Text, allowsMock, showToast, markRef, spaceRef, type IconName } from "@vyre/ui";
import { Footnote, Frame } from "../places/Frame";
import { SPACES, useScope } from "../places/scope";
import { memoryRepo, SUBJECTS, type Fact } from "./data";
import { editReal, forgetReal, loadReal } from "./real";
import { uncorrectReal } from "./extras";
import { RealAsk, RealExtras } from "./RealExtras";
import { answer, edit, forget, group, restore, visible } from "./logic.js";

const SRC_ICON: Record<Fact["src"]["kind"], IconName> = { record: "records", file: "file", chat: "chat", email: "mail", flow: "flows" };
/** A citation: the number in brackets, 12 mono, in the accent, set small beside the 17 answer. */
const sup = (n: number) => `[${n}]`;

/** A group's header as a row: the person's 24 face (the project's or space's emblem for those), its name, how many facts. */
function GroupHead({ mark, name, count }: { mark: ReturnType<typeof markRef>; name: string; count: number }) {
  return (
    <View accessibilityRole="header" className="flex-row items-center gap-s2 pt-s6 pb-s2">
      <Avatar of={mark} size={24} />
      <Text strong size="secondary" className="min-w-0 flex-1" numberOfLines={1}>{name}</Text>
      <Text size="caption" tone="faint">{`${count} ${count === 1 ? "fact" : "facts"}`}</Text>
    </View>
  );
}

export default function MemoryScreen() {
  const scope = useScope((s) => s.scope);
  const router = useRouter();
  const real = !allowsMock();
  const [facts, setFacts] = useState<Fact[]>(() => (real ? [] : memoryRepo.facts()));
  const [subjects, setSubjects] = useState<Record<string, string>>(SUBJECTS);
  const [load, setLoad] = useState<{ state: "loading" | "ready" | "error"; say?: string }>({ state: real ? "loading" : "ready" });
  useEffect(() => {
    if (!real) return;
    loadReal().then((r) => { setFacts(r.facts); setSubjects(r.subjects); setLoad({ state: "ready" }); }).catch((e) => setLoad({ state: "error", say: e instanceof Error ? e.message : "Memory did not answer." }));
  }, [real]);
  const [mode, setMode] = useState<Fact["kind"]>("person");
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("Jane");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [undo, setUndo] = useState<{ fact: Fact; index: number; cid?: number | null } | null>(null);
  const [cite, setCite] = useState<Fact | null>(null);

  const shown = useMemo(() => visible(facts, scope), [facts, scope]);
  const sections = useMemo(() => group(shown, mode), [shown, mode]);
  const ans = useMemo(() => (asked ? answer(facts, subjects, asked, scope) : null), [facts, asked, scope]);
  const sealed = (real ? [] : memoryRepo.sealed()).filter((s) => scope === "all" || s.space === scope);
  const open = (s: Fact["src"]) => (s.target ? router.push(`/u/${s.target}` as never) : showToast(`Opened ${s.label}.`));
  const ask = (text: string) => { setQ(text); setAsked(text); };
  const notIncluded = ans?.kind === "ok" ? (real ? [] : memoryRepo.sealed()).find((s) => s.subject === ans.name && (scope === "all" || s.space === scope)) : undefined;

  const row = (f: Fact) => {
    const isEdit = editing?.id === f.id;
    if (isEdit) {
      return (
        <View key={f.id} className="gap-s2 p-s4">
          <Field label="Fact" value={editing.text} onChangeText={(text) => setEditing({ id: f.id, text })} />
          <View className="flex-row gap-s2">
            <Button kind="primary" size="sm" label="Save" onPress={() => { const text = editing.text; (real ? editReal(f.id, text) : Promise.resolve()).then(() => { setFacts((xs) => edit(xs, f.id, text)); setEditing(null); showToast("Saved. Assistants recall the new wording."); }).catch((e) => showToast(e instanceof Error ? e.message : "That did not save.")); }} />
            <Button kind="ghost" size="sm" label="Cancel" onPress={() => setEditing(null)} />
          </View>
        </View>
      );
    }
    return (
      <Row key={f.id}
        title={<Text style={{ fontSize: 16, lineHeight: 23 }}>{f.text}</Text>}
        sub={
          <View className="gap-s1 pt-s1">
            <View className="flex-row items-center gap-s1">
              <Icon name={SRC_ICON[f.src.kind]} size={14} tone="label" />
              <Text tone="label" numberOfLines={1} className="min-w-0 flex-shrink" style={{ fontSize: 13, lineHeight: 18 }} onPress={() => open(f.src)}>{`${f.src.label}, ${memoryRepo.assistantName(f.by)}, ${f.when}`}</Text>
            </View>
            <View className="flex-row items-center gap-s1">
              <Text tone="label" numberOfLines={1} style={{ fontSize: 13, lineHeight: 18 }}>{`Used ${f.used} ${f.used === 1 ? "time" : "times"}${scope === "all" ? "," : ""}`}</Text>
              {scope === "all" ? <><SpaceMark space={spaceRef(SPACES[f.sp].name)} size={16} /><Text tone="label" numberOfLines={1} style={{ fontSize: 13, lineHeight: 18 }}>{SPACES[f.sp].name}</Text></> : null}
            </View>
          </View>
        }
        end={<Menu trigger={<IconButton icon="more" label="More about this fact" />} items={[{ label: "Edit", onPress: () => setEditing({ id: f.id, text: f.text }) }, { label: "Forget", danger: true, onPress: () => { const r = forget(facts, f.id); (real ? forgetReal(f.id) : Promise.resolve(null)).then((cid) => { setFacts(r.facts); setUndo(r.undo ? { ...r.undo, cid } : null); }).catch((e) => showToast(e instanceof Error ? e.message : "That did not work.")); } }]} />} />
    );
  };

  return (
    <Frame title="Memory" sub="What Vyre knows, and where each fact came from." scope={!real}>
      {!real && scope === "mine" ? <Footnote icon="shield">This is the Mine boundary. Facts from Harlow Legal never show here, and your assistants do not carry them into Mine.</Footnote> : null}
      {!real && scope === "harlow" ? <Footnote icon="shield">This is the Harlow Legal boundary. Facts here stay in Harlow Legal. Your own Mine facts are not shown.</Footnote> : null}

      {real ? <RealAsk /> : (
      <View className="gap-s3 pt-s2">
        <Composer label="Ask Memory" placeholder="Ask about a person or project" value={q} onChangeText={setQ} onSend={() => setAsked(q)} />
        <View className="flex-row flex-wrap gap-s2"><Chip onPress={() => ask("Jane")}>What do we know about Jane</Chip></View>
        {ans?.kind === "ok" ? (
          <View className="gap-s2 pt-s2">
            <Text size="read">
              <Text strong size="read">{ans.name}</Text>{": "}
              {ans.items.map((it) => (
                <Text key={it.n} size="read">{`${it.fact.text} `}<Text mono accessibilityRole="link" accessibilityLabel={`Source ${it.n}`} tone="accent" style={{ fontSize: 12 }} onPress={() => setCite(it.fact)}>{sup(it.n)}</Text>{" "}</Text>
              ))}
            </Text>
            {notIncluded ? <Footnote icon="sealed">{`Not included: ${notIncluded.labels.join(", ")}`}</Footnote> : null}
          </View>
        ) : null}
        {ans?.kind === "boundary" ? <Footnote icon="shield">{`Nothing in ${scope === "all" ? "this view" : SPACES[scope].name} about "${asked}". Memory does not cross spaces unless a space shares it. Switch the space to ask there.`}</Footnote> : null}
        {ans?.kind === "none" ? <Text tone="muted">Nothing remembered about {ans.name}.</Text> : null}
      </View>
      )}

      {undo ? (
        <Banner>
          <View className="flex-row flex-wrap items-center gap-s3">
            <Text className="min-w-0 flex-1">Forgot one fact. It is gone from Memory and from what assistants recall.</Text>
            <Button size="sm" label="Undo" onPress={() => { const u = undo; (real && u.cid != null ? uncorrectReal(u.cid) : Promise.resolve()).then(() => { setFacts((xs) => restore(xs, u)); setUndo(null); }).catch((e) => showToast(e instanceof Error ? e.message : "That did not work.")); }} />
          </View>
        </Banner>
      ) : null}

      <View className="pt-s4"><Segmented label="Facts by" value={mode} onChange={setMode} options={[["person", "People"], ["project", "Projects"], ["space", "Spaces"]]} /></View>

      {sections.length ? sections.map((s) => (
        <View key={s.key}>
          <GroupHead
            mark={mode === "space" ? spaceRef(SPACES[s.sp as "mine"].name) : mode === "project" ? markRef("project", subjects[s.subj] ?? s.subj) : markRef("person", subjects[s.subj] ?? s.subj, s.subj)}
            name={mode === "space" ? SPACES[s.sp as "mine"].name : subjects[s.subj] ?? s.subj} count={s.facts.length} />
          <Card flush>{s.facts.map((f, i) => <View key={f.id}>{i ? <Divider /> : null}{row(f)}</View>)}</Card>
        </View>
      )) : <Card><EmptyState title={load.state === "loading" ? "Loading Memory" : load.state === "error" ? "Memory did not answer" : "Nothing here yet"} body={load.state === "error" ? (load.say ?? "Try again in a moment.") : load.state === "loading" ? "Asking your Vyre." : real ? "Nothing is remembered yet. Facts appear as your assistants learn them." : `No ${mode} facts in this space.`} /></Card>}

      {real ? <RealExtras /> : null}

      {sealed.length ? (
        <Footnote icon="sealed">{`Sealed fields are never read into Memory: ${sealed.map((s) => `${s.subject} has ${s.labels.length}`).join(", ")}. Assistants see "SSN on file, sealed" and nothing more.`}</Footnote>
      ) : null}

      <Sheet open={!!cite} onClose={() => setCite(null)} title={cite?.src.label}>
        {cite ? (
          <>
            <Text size="read">{cite.text}</Text>
            <Text tone="label">{`Learned by ${memoryRepo.assistantName(cite.by)}, ${cite.when}. Used ${cite.used} ${cite.used === 1 ? "time" : "times"}.`}</Text>
            <Button kind="primary" label="Open the source" onPress={() => { const s = cite.src; setCite(null); open(s); }} />
          </>
        ) : null}
      </Sheet>
    </Frame>
  );
}
