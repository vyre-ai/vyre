// Sample world only: the question card, waiting and answered, for the screenshot pass.
import { View } from "react-native";
import { ThemeProvider, Text } from "@vyre/ui";
import { QuestionsCard } from "../src/chat/QuestionsCard";

const qs = [
  { id: "file", prompt: "Is this the file?", choices: [{ label: "report-final.pdf", detail: "Downloads, 2 MB, today" }, { label: "report-v2.pdf", detail: "Downloads, 1.8 MB, yesterday" }], allowText: true, optional: false },
  { id: "who", prompt: "Which Sam do you mean?", choices: [{ label: "Sam Lee", detail: "Slack, Northwind" }, { label: "Sam Kerr", detail: "Slack, Harbor" }], allowText: true, optional: false },
];
const base = { block: "questions" as const, id: "0a1b2c3d4e5f", title: "Before I send it", questions: qs };

export default function ShotsQuestions() {
  return (
    <ThemeProvider>
      <View style={{ padding: 20, gap: 14, maxWidth: 620 }}>
        <QuestionsCard block={{ ...base, state: "waiting", answers: null }} />
        <QuestionsCard block={{ ...base, id: "1b2c3d4e5f60", state: "answered", answers: { file: { choice: "report-final.pdf" }, who: { text: "the Sam on the lease team" } } }} />
        <Text tone="label" size="caption">Sample world</Text>
      </View>
    </ThemeProvider>
  );
}
