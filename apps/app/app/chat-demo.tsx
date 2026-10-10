// The chat demo: the chat screen on the mock stream, no server. Routes:
//   /chat-demo                 a live mock session (text at about 40 tokens a second)
//   /chat-demo?n=10000         the same, over a preloaded 10,000-message thread
//   /chat-demo?at=4200         fast-forward the script 4.2 s at connect (for shots), then live
//   /chat-demo?at=4200&hold=1  ...and stay there (a frozen mid-turn view)
//   /chat-demo?composer=1      the composer open
// `window.__chat` carries the measurements the perf script reads (frame emit to paint, key times).

import { useEffect, useMemo } from "react";
import { Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ThemeProvider } from "@vyre/ui";
import { ChatScreen } from "../src/chat/ChatScreen";
import { createMockStream, historyFrames } from "../src/chat/mock-stream";

type Meter = { delta: number[]; first: number[]; keys: number[]; paints: number[]; mounted: number };

/** `sample` is one of the sample world's chats (demo-three, demo-people), opened from the Chats list; with none it is the default demo. */
export default function ChatDemo({ sample }: { sample?: string } = {}) {
  const q = useLocalSearchParams<{ n?: string; at?: string; composer?: string; tps?: string; hold?: string; scenario?: string; about?: string; note?: string }>();
  const group = q.scenario === "group";
  const activity = q.scenario === "activity";
  const previews = q.scenario === "previews";
  const markdown = q.scenario === "markdown";
  const n = Number(q.n) || 0;
  const at = Number(q.at) || 0;
  const source = useMemo(
    () => createMockStream({ session: sample ?? "demo", scenario: sample === "demo-three" ? "models" : sample === "demo-people" ? "people" : sample === "demo-assistant" ? "assistant" : activity ? "activity" : markdown ? "markdown" : previews ? "previews" : group ? "group" : undefined, startAt: at, hold: q.hold === "1", tps: Number(q.tps) || (group ? 30 : 40), history: n ? historyFrames(n) : undefined }),
    [n, at, q.tps, q.hold, group, activity, previews, markdown, sample],
  );
  const router = useRouter();
  const meter = useMemo<Meter>(() => ({ delta: [], first: [], keys: [], paints: [], mounted: 0 }), []);
  useEffect(() => {
    if (Platform.OS === "web") (window as unknown as { __chat: unknown }).__chat = { meter, source, answer: (a: string) => source.answer(a, "approve"), send: (t: string) => source.send(t) };
  }, [meter, source]);
  return (
    <ThemeProvider>
      <ChatScreen
        sessionId={sample ?? "demo"}
        onBack={() => router.back()}
        title={sample === "demo-three" ? "Which clause is riskier?" : sample === "demo-people" ? "Intake hand-off" : sample === "demo-assistant" ? "Tests before the call" : group ? "Northwind lease, before the 3 pm call" : activity ? "Chase the overdue invoices" : "Fix the intake date check"}
        about={group ? { record: { title: "Northwind Bakery, lease dispute", type: "Matter" }, space: "Juniper Studio", sealed: 2, runsOn: "server" } : undefined}
        initialAbout={q.about === "1"}
        showSealedNote={q.note === "0" ? false : undefined}
        source={source}
        autoFocusComposer={q.composer === "1"}
        perf={(name, ms) => (name === "paint.first" ? meter.first : meter.delta).push(ms)}
        onKey={(t) => meter.keys.push(t)}
        handlers={{ onFaceId: async () => true, onOpenInDrive: () => {}, onOpenTerminal: () => {}, onTakeOver: () => {} }}
      />
    </ThemeProvider>
  );
}
