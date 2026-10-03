// The chat demo: the chat screen on the mock stream, no server. Routes:
//   /chat-demo                 a live mock session (text at about 40 tokens a second)
//   /chat-demo?n=10000         the same, over a preloaded 10,000-message thread
//   /chat-demo?at=4200         fast-forward the script 4.2 s at connect (for shots), then live
//   /chat-demo?at=4200&hold=1  ...and stay there (a frozen mid-turn view)
//   /chat-demo?composer=1      the composer open
// `window.__chat` carries the measurements the perf script reads (frame emit to paint, key times).

import { useEffect, useMemo } from "react";
import { Platform } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { ThemeProvider } from "@vyre/ui";
import { ChatScreen } from "../src/chat/ChatScreen";
import { createMockStream, historyFrames } from "../src/chat/mock-stream";

type Meter = { delta: number[]; first: number[]; keys: number[]; paints: number[]; mounted: number };

export default function ChatDemo() {
  const q = useLocalSearchParams<{ n?: string; at?: string; composer?: string; tps?: string; hold?: string }>();
  const n = Number(q.n) || 0;
  const at = Number(q.at) || 0;
  const source = useMemo(
    () => createMockStream({ session: "demo", startAt: at, hold: q.hold === "1", tps: Number(q.tps) || 40, history: n ? historyFrames(n) : undefined }),
    [n, at, q.tps, q.hold],
  );
  const meter = useMemo<Meter>(() => ({ delta: [], first: [], keys: [], paints: [], mounted: 0 }), []);
  useEffect(() => {
    if (Platform.OS === "web") (window as unknown as { __chat: unknown }).__chat = { meter, source, answer: (a: string) => source.answer(a, "approve"), send: (t: string) => source.send(t) };
  }, [meter, source]);
  return (
    <ThemeProvider>
      <ChatScreen
        sessionId="demo"
        title="Fix the intake date check"
        source={source}
        autoFocusComposer={q.composer === "1"}
        perf={(name, ms) => (name === "paint.first" ? meter.first : meter.delta).push(ms)}
        onKey={(t) => meter.keys.push(t)}
        handlers={{ onFaceId: async () => true, onOpenInDrive: () => {}, onOpenTerminal: () => {}, onTakeOver: () => {} }}
      />
    </ThemeProvider>
  );
}
