import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Row, Text, showToast } from "@vyre/ui";
import { CHOICES, DEFAULT_CHOICE, GAINS, SERVER_KINDS } from "../../src/real/add-server.js";
import { startAddServer, type AddServerState } from "../../src/real/add-server-bind";

/**
 * Upgrade to My Cloud: the one way a server joins. What a server unlocks, the two choices (With Records first and selected), then the install line to paste on the server; the app finds the server by itself,
 * shows four words to check against the server's terminal, and pairs. The confirm is here, never at the server. `onDone` hears the server is paired, and the My Cloud card carries on from there.
 */
export function AddServerCard({ onDone }: { onDone: () => void }) {
  const [choice, setChoice] = useState(DEFAULT_CHOICE);
  const [kind, setKind] = useState(SERVER_KINDS[0].id);
  const [state, setState] = useState<AddServerState | null>(null);
  const run = useRef<Awaited<ReturnType<typeof startAddServer>> | null>(null);
  useEffect(() => () => { run.current?.stop(); }, []);
  const begin = async () => {
    const r = await startAddServer((s) => { setState(s); if (s.stage === "done") onDone(); });
    run.current = r;
    await r.begin(choice, kind);
  };
  const stage = state?.stage ?? "idle";

  if (stage === "idle") {
    return (
      <Card className="gap-s3">
        <Text strong>Upgrade to My Cloud</Text>
        <Text tone="muted">A server is a computer that stays on. With one:</Text>
        <View className="gap-s1">{GAINS.map((g) => <Text key={g}>{g}</Text>)}</View>
        <View>
          {CHOICES.map((c) => <Row key={c.id} title={c.label} sub={choice === c.id ? `${c.note} Selected.` : c.note} onPress={() => setChoice(c.id)} />)}
        </View>
        <View>
          {SERVER_KINDS.map((k) => <Row key={k.id} title={k.label} sub={kind === k.id ? "Selected." : undefined} onPress={() => setKind(k.id)} />)}
        </View>
        <View className="flex-row"><Button label="Show me the line to run" onPress={() => void begin()} /></View>
      </Card>
    );
  }
  if (!state) return null;
  return (
    <Card className="gap-s3">
      <Text strong>Add a server</Text>
      {stage === "install" ? (<>
        <Text tone="muted">{`${(SERVER_KINDS.find((k) => k.id === kind) ?? SERVER_KINDS[0]).where} It works once, for one hour.`}</Text>
        <Card className="flex-row items-center gap-s3">
          <Text mono size="caption" className="flex-1">{state.installLine}</Text>
          <Button size="sm" label="Copy" onPress={() => { Clipboard.setStringAsync(state.installLine).catch(() => {}); showToast("Copied"); }} />
        </Card>
        <Text tone="muted">Waiting for your server. This screen updates when it is ready.</Text>
        {state.lines.length ? <Text mono size="caption">{state.lines[state.lines.length - 1]}</Text> : null}
      </>) : null}
      {stage === "found" && state.box ? (<>
        <Text>Your server is ready. It shows four words. Are these the same?</Text>
        <Text strong size="title">{state.box.words.join("  ")}</Text>
        {state.note ? <Banner tone="warn">{state.note}</Banner> : null}
        <View className="flex-row gap-s2">
          <Button label="Same" onPress={() => void run.current?.confirmWords()} />
          <Button kind="ghost" label="Not the same" onPress={() => run.current?.denyWords()} />
        </View>
      </>) : null}
      {stage === "pairing" ? (<><Text tone="muted">Connecting to your server.</Text>{state.note ? <Banner tone="warn">{state.note}</Banner> : null}</>) : null}
      {stage === "done" ? <Text>Your server is connected.</Text> : null}
      {stage === "stopped" ? (<>
        <Banner tone="warn">{state.error?.message}</Banner>
        <View className="flex-row"><Button label="Start again" onPress={() => { run.current?.stop(); run.current = null; setState(null); }} /></View>
      </>) : null}
    </Card>
  );
}
