// One card for every question (R031-92): the agent needed several things settled, so they are asked together. Each question has its choices as quiet rows and a line to type or say your own (the keyboard's own
// microphone does the saying); Continue is one button, ready when every question that is not optional has an answer. Answered, the card folds to what you said. The answers decide nothing by themselves: whatever
// the assistant then sends or changes still waits for your yes, as ever.
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Banner, Button, Chip, Icon, Text, useUiTheme } from "@vyre/ui";
import { tool } from "../real/box";
import { answerOf, pickChoice, progress, ready, toAnswers, typeOwn, type Picked, type Question } from "./question-model.js";

type QBlock = { block: "questions"; id: string; title: string; state: "waiting" | "answered" | "cancelled" | "expired"; questions: Question[]; answers: Picked | null };

export function QuestionsCard({ block }: { block: QBlock }) {
  const { color } = useUiTheme();
  const [picked, setPicked] = useState<Picked>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [sent, setSent] = useState<Picked | null>(null);
  const answers = block.answers ?? sent;
  const state = answers && block.state === "waiting" ? "answered" : block.state;
  const waiting = state === "waiting";
  const p = progress(block.questions, picked);

  const send = async () => {
    setBusy(true); setProblem("");
    try { const a = toAnswers(block.questions, picked); await tool("ask.answer", { id: block.id, answers: a }); setSent(a); }
    catch (e) { setProblem(e instanceof Error && e.message ? e.message : "That did not go through."); }
    finally { setBusy(false); }
  };

  return (
    <View accessible={false} style={{ borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], borderRadius: 14, marginVertical: 4, maxWidth: 560, padding: 14, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text strong style={{ flex: 1, minWidth: 0 }}>{block.title}</Text>
        {waiting ? <Chip>{`${p.done} of ${p.of}`}</Chip> : state === "answered" ? <Chip tone="ok" icon="check">Answered</Chip> : <Chip>{state === "cancelled" ? "Put away" : "Expired"}</Chip>}
      </View>
      {block.questions.map((q) => (
        <View key={q.id} style={{ gap: 8 }}>
          <Text size="secondary" tone="muted">{q.prompt}</Text>
          {waiting ? (
            <View style={{ gap: 6 }}>
              {q.choices.map((c) => {
                const on = picked[q.id]?.choice === c.label;
                return (
                  <Pressable key={c.label} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={c.label} onPress={() => setPicked((x) => pickChoice(x, q.id, c.label))}
                    style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: on ? color.accent : color.edge, backgroundColor: on ? color["accent-wash"] : color["surface-3"] }}>
                    <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: on ? color.accent : color["edge-strong"], alignItems: "center", justifyContent: "center", backgroundColor: on ? color.accent : "transparent" }}>
                      {on ? <Icon name="check" size={12} tone="primary-ink" /> : null}
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={2}>{c.label}</Text>
                      {c.detail ? <Text size="caption" tone="label" numberOfLines={1}>{c.detail}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
              {q.allowText ? (
                <TextInput accessibilityLabel={`Your own answer to: ${q.prompt}`} placeholder={q.choices.length ? "Or type your own" : "Type your answer"} placeholderTextColor={color.label}
                  value={picked[q.id]?.text ?? ""} onChangeText={(t) => setPicked((x) => typeOwn(x, q.id, t))} multiline
                  style={{ minHeight: 44, maxHeight: 120, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: picked[q.id]?.text ? color.accent : color.edge, color: color.text, fontSize: 16, backgroundColor: color["surface-3"], outlineStyle: "none" } as never} />
              ) : null}
            </View>
          ) : (
            <Text>{answers ? answerOf(q, answers) : "No answer"}</Text>
          )}
        </View>
      ))}
      {waiting ? (
        <View style={{ gap: 8 }}>
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <View style={{ alignSelf: "flex-start" }}><Button kind="primary" label={busy ? "Sending" : "Continue"} disabled={busy || !ready(block.questions, picked)} onPress={send} /></View>
        </View>
      ) : null}
    </View>
  );
}
