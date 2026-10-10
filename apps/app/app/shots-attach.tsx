// Sample world only: the composer with files added to a message (uploading, ready, failed), the sent message with its file names, and the turn's changes sheet with Undo on each file, for the screenshot pass.
// ?state=composer | sent | changes
import { View } from "react-native";
import { ThemeProvider, Text } from "@vyre/ui";
import { useLocalSearchParams } from "expo-router";
import { ChatComposer } from "../src/chat/ChatComposer";
import { TurnChip } from "../src/chat/ChatRows";
import { UserText } from "../src/chat/ChatRows";
import { Chip } from "@vyre/ui";

const files = [
  { key: "a1", name: "offer letter.pdf", line: "1.2 MB", state: "ready" as const },
  { key: "a2", name: "screenshot.png", line: "2.4 MB · adding", state: "uploading" as const },
  { key: "a3", name: "ledger.xlsx", line: "ledger.xlsx is over 8 MB; a larger file goes through a Flow or the VyreDrive mount.", state: "failed" as const },
];
const it = {
  line: "2 files, 1 min",
  files: [{ path: "src/order.js", op: "edit", add: 1, del: 1 }, { path: "README.md", op: "edit", add: 2, del: 0 }],
  diffs: [{ path: "src/order.js", op: "edit", diff: "@@\n-const total = items.length\n+const total = items.reduce((n, i) => n + i.qty, 0)" }, { path: "README.md", op: "edit", diff: "@@\n+Orders are counted by quantity.\n+See src/order.js." }],
};

export default function ShotsAttach() {
  const q = useLocalSearchParams<{ state?: string }>();
  const state = q.state ?? "composer";
  return (
    <ThemeProvider>
      <View style={{ padding: 20, gap: 14, maxWidth: 700 }}>
        {state === "composer" ? (
          <ChatComposer state="idle" phone={false} onSend={() => {}} attachments={files} onRemoveAttachment={() => {}} attachProblem="At most 5 files in one message." onAttachFile={() => {}} onAttachPhoto={() => {}} />
        ) : null}
        {state === "sent" ? (
          <View style={{ gap: 8 }}>
            <UserText text="Please read these and tell me what is missing." pending={false} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}><Chip icon="file">offer letter.pdf · 1.2 MB</Chip><Chip icon="file">screenshot.png · 2.4 MB</Chip></View>
          </View>
        ) : null}
        {state === "changes" ? <TurnChip it={it} ctx={{ wide: true }} session="chat_sample" defaultOpen /> : null}
        <Text tone="label" size="caption">Sample world</Text>
      </View>
    </ThemeProvider>
  );
}
