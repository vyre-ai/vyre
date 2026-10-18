// The new-agent card: what the Engineer proposed as a NEW agent, shown as the character it will be and the real settings it will have, so the person says yes (Create, the task's approve) once. Nothing here
// changes the proposal: a change is asked of the Engineer in words, in this same thread, and a revised proposal comes back as a new card. The draft is read with agents.draft.get.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, AgentLookPicker, Banner, Button, Field, Row, Sheet, Text, lookOf, markRef, partsOf, withParts, PARTS, lookSeed } from "@vyre/ui";
import { callT } from "../real/call-tool";
import { cardOf, changeWords, draftIdOf } from "./agent-new-model.js";

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
          ) : <View style={{ flexDirection: "row" }}><Button kind="ghost" size="sm" label="Change something" onPress={() => setAsking(true)} /></View>}
        </View>
      ) : null}
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
