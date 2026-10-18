// The new-agent card: what the Engineer proposed as a NEW agent, shown as the character it will be and the real settings it will have, so the person says yes (Create, the task's approve) once. Nothing here
// changes the proposal: a change is asked of the Engineer in words, in this same thread, and a revised proposal comes back as a new card. The draft is read with agents.draft.get.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, AgentLookPicker, Banner, Button, Field, Row, Segmented, Sheet, Switch, Text, lookOf, markRef, partsOf, withParts, PARTS, lookSeed } from "@vyre/ui";
import { callT } from "../real/call-tool";
import { accountRows, cardOf, changeWords, draftIdOf, modelRows, skillGroups, toggled } from "./agent-new-model.js";

/** The draft behind a new-agent task, or null while it loads or when it cannot be read. */
export function useNewAgentDraft(taskId: string, wanted: boolean): { input: any; problem: string } | null {
  const [d, setD] = useState<{ input: any; problem: string } | null>(null);
  useEffect(() => {
    if (!wanted || !taskId) return;
    let live = true;
    void (async () => {
      const t = await callT<any>("tasks.get", { id: taskId });
      const id = t.error ? "" : draftIdOf(t.data);
      if (!id) { if (live) setD({ input: null, problem: "" }); return; }
      const r = await callT<any>("agents.draft.get", { id });
      if (live) setD(r.error ? { input: null, problem: r.error.message } : { input: r.data?.input ?? null, problem: "" });
    })();
    return () => { live = false; };
  }, [taskId, wanted]);
  return d;
}

export function AgentNewCard({ input, onSay }: { input: any; onSay?: (text: string) => void }) {
  const card = cardOf(input);
  const [looking, setLooking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [words, setWords] = useState("");
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const start = lookOf(card.look) ?? { shape: 0, color: 0 };
  const [v, setV] = useState({ ...start, parts: partsOf(withParts(card.look || card.name, card.name)) as Record<string, number> });
  const look = lookSeed(v.shape, v.color) + PARTS.map((p) => `~${p.key}${v.parts[p.key] ?? 0}`).join("");
  const shown = card.look ? withParts(card.look, card.name) : card.name;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Avatar of={markRef("agent", card.name, undefined, shown)} size={56} onPress={onSay ? () => setLooking(true) : undefined} />
        <View style={{ flex: 1 }}><Text size="title" medium>{card.name}</Text><Text tone="label" size="caption">{onSay ? "Tap it to change how it looks" : "A new agent"}</Text></View>
      </View>
      {card.grants.length ? <Banner tone="warn">{`A yes lets it:\n${card.grants.map((g) => `\u2022 ${g}`).join("\n")}`}</Banner> : null}
      {card.rows.map(([k, val]) => <Row key={k} dense title={k} sub={val} />)}
      {onSay ? (
        <View style={{ gap: 6 }}>
          {asking ? (
            <>
              <Field name="What should change" value={words} onChangeText={setWords} placeholder="for example: name: rex, or more careful with money" />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button kind="secondary" size="sm" label="Ask the Engineer" disabled={!words.trim()} onPress={() => { onSay(changeWords("what to change", words)); setWords(""); setAsking(false); }} />
                <Button kind="ghost" size="sm" label="Cancel" onPress={() => setAsking(false)} />
              </View>
            </>
          ) : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}><Button kind="ghost" size="sm" label="Skills" onPress={() => setSkillsOpen(true)} /><Button kind="ghost" size="sm" label="Model" onPress={() => setModelOpen(true)} /><Button kind="ghost" size="sm" label="Change something" onPress={() => setAsking(true)} /></View>}
        </View>
      ) : null}
      {onSay && skillsOpen ? <SkillsSheet name={card.name} chosen={Array.isArray(input?.skills) ? input.skills : []} onClose={() => setSkillsOpen(false)} onUse={(names) => { setSkillsOpen(false); onSay(changeWords("skills", names.length ? names.join(", ") : "none")); }} /> : null}
      {onSay && modelOpen ? <ModelSheet onClose={() => setModelOpen(false)} onUse={(which, id) => { setModelOpen(false); onSay(changeWords(which === "primary" ? "model" : "fallback model", id)); }} /> : null}
      {onSay ? (
        <Sheet open={looking} onClose={() => setLooking(false)} title={`How ${card.name} looks`}>
          <View style={{ gap: 16 }}>
            <View style={{ alignItems: "center" }}><Avatar of={markRef("agent", card.name, undefined, look)} size={56} /></View>
            <AgentLookPicker shape={v.shape} color={v.color} parts={v.parts} onChange={(p) => setV((x) => ({ ...x, ...p }))} onPart={(key, value) => setV((x) => ({ ...x, parts: { ...x.parts, [key]: value } }))} />
            <Banner>The Engineer makes a new card with this look. Nothing is made until you say yes to it.</Banner>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              <Button kind="ghost" label="Cancel" onPress={() => setLooking(false)} />
              <Button kind="primary" label="Use this look" onPress={() => { setLooking(false); onSay(changeWords("look", look)); }} />
            </View>
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}

/** The skills the person may attach (skills.list: the agent's own, theirs, the Space's), to choose and send to the Engineer as a change. */
function SkillsSheet({ name, chosen, onClose, onUse }: { name: string; chosen: string[]; onClose: () => void; onUse: (names: string[]) => void }) {
  const [data, setData] = useState<unknown>(null);
  const [on, setOn] = useState<string[]>(chosen);
  useEffect(() => { let live = true; void callT<any>("skills.list", { limit: 100 }).then((r) => { if (live) setData(r.error ? { skills: [] } : r.data); }); return () => { live = false; }; }, []);
  const groups = skillGroups(data, on, name);
  return (
    <Sheet open onClose={onClose} title="Skills">
      <View style={{ gap: 12 }}>
        {data === null ? <Text tone="muted">Looking.</Text> : !groups.length ? <Text tone="muted">No skills to attach yet.</Text> : groups.map((g) => (
          <View key={g.level} style={{ gap: 4 }}>
            <Text size="caption" tone="label">{g.title}</Text>
            {g.skills.map((s) => <Row key={s.name} dense title={s.name} sub={s.description || undefined} end={<Switch label={s.name} on={s.on} onChange={() => setOn((c) => toggled(c, s.name))} />} />)}
          </View>
        ))}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Button kind="ghost" label="Cancel" onPress={onClose} />
          <Button kind="primary" label="Use these skills" onPress={() => onUse(on)} />
        </View>
      </View>
    </Sheet>
  );
}

/** The models each AI account offers (sessions.accounts.list, then sessions.accounts.models), for the primary model and the fallback. */
function ModelSheet({ onClose, onUse }: { onClose: () => void; onUse: (which: "primary" | "fallback", id: string) => void }) {
  const [which, setWhich] = useState<"primary" | "fallback">("primary");
  const [groups, setGroups] = useState<{ account: string; label: string; models: { id: string; label: string }[] }[] | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const list = await callT<any>("sessions.accounts.list", {});
      const accts = list.error ? [] : accountRows(list.data);
      const out = await Promise.all(accts.slice(0, 8).map(async (a) => { const m = await callT<any>("sessions.accounts.models", { account: a.id }); return { account: a.id, label: a.label, models: m.error ? [] : modelRows(m.data) }; }));
      if (live) setGroups(out.filter((g) => g.models.length));
    })();
    return () => { live = false; };
  }, []);
  return (
    <Sheet open onClose={onClose} title="Model">
      <View style={{ gap: 12 }}>
        <Segmented label="Which" value={which} onChange={(v) => setWhich(v as "primary" | "fallback")} options={[["primary", "Primary model"], ["fallback", "Fallback model"]]} />
        {groups === null ? <Text tone="muted">Looking.</Text> : !groups.length ? <Text tone="muted">No AI account is connected yet, so there are no models to list.</Text> : groups.map((g) => (
          <View key={g.account} style={{ gap: 4 }}>
            <Text size="caption" tone="label">{g.label}</Text>
            {g.models.map((m) => <Row key={m.id} dense title={m.label} chevron onPress={() => onUse(which, m.id)} />)}
          </View>
        ))}
      </View>
    </Sheet>
  );
}
