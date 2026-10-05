import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { joinWithCode } from "@vyre/relay-client/join.js";
import { Banner, Button, Card, Field, IconTile, Row, Text } from "@vyre/ui";
import { about, presenceKey, relayCrypto, relayKeyStore } from "../../src/api/relay";
import { afterPaired } from "../../src/real/pairing";
import { relayUrl } from "../../src/api/relay-url";
import { parseWinkCode } from "../../src/api/wink-code";
import { MAC_SERVER, macServerSay } from "./first-run.js";

type Stage = "enter" | "ack" | "done";

/**
 * The Mac app's window, On a server, with no vyred of its own (rows 4e and 4f): type the code the server shows, then type this Mac's ack code on the server (typing it there is the yes), then it is connected.
 * Three wrong tries end the code. Nothing is connected until joinWithCode resolves.
 */
export function MacServer({ name, onBack, onDone }: { name: string; onBack: () => void; onDone: () => void }) {
  const [stage, setStage] = useState<Stage>("enter");
  const [text, setText] = useState("");
  const [ack, setAck] = useState("");
  const [left, setLeft] = useState<number>(MAC_SERVER.tries);
  const [said, setSaid] = useState<{ title: string; line: string; over: boolean } | null>(null);
  const [paired, setPaired] = useState("");
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const connect = async () => {
    const c = parseWinkCode(text);
    if (!c.ok || c.kind !== "typed") { setSaid({ title: MAC_SERVER.wrongTitle, line: "It looks like WINK-7K4Q-M2XD.", over: false }); return; }
    setSaid(null);
    const r = await joinWithCode({ relay: relayUrl(), input: c.code, name: "Vyre on this Mac", onState: (s) => { if (live.current && s.state === "ack" && s.code) { setAck(s.code); setStage("ack"); } },
      pairOptions: { crypto: relayCrypto(), keyStore: relayKeyStore(), about, presenceKey: await presenceKey(), deviceKind: "computer", keyStorage: "software" } }).catch(() => ({ ok: false as const, reason: "offline" as const }));
    if (!live.current) return;
    if (!r.ok) {
      const wrong = r.reason === "refused" || r.reason === "closed" || r.reason === "format";
      const rest = wrong ? left - 1 : left;
      if (wrong) setLeft(rest);
      setSaid(macServerSay(wrong ? "wrong" : r.reason, rest));
      setStage("enter"); setAck("");
      return;
    }
    await afterPaired(r.paired).catch(() => {});
    setPaired(r.paired.name); setStage("done");
  };

  if (stage === "ack") {
    return (
      <View className="gap-s4">
        <View className="gap-s1"><Text size="page" strong>{MAC_SERVER.ackTitle}</Text><Text tone="muted">{MAC_SERVER.ackLine}</Text></View>
        <Card className="items-center"><Text mono strong size="title" selectable className="text-center">{ack}</Text></Card>
        <Text size="caption" tone="muted">Your server says "Waiting for the code." No words to compare.</Text>
        <Button kind="ghost" label={MAC_SERVER.cancel} onPress={onBack} />
      </View>
    );
  }
  if (stage === "done") {
    return (
      <View className="gap-s4">
        <View className="gap-s1"><Text size="page" strong>{MAC_SERVER.doneTitle}</Text><Text tone="muted">{MAC_SERVER.doneLine}</Text></View>
        <Card><Row lead={<IconTile name="server" />} title={MAC_SERVER.doneRow} sub={`Paired to ${name ? `${name}.vyre.run` : paired}`} /></Card>
        <Button kind="primary" label={MAC_SERVER.doneContinue} onPress={onDone} />
      </View>
    );
  }
  return (
    <View className="gap-s4">
      <View className="gap-s1"><Text size="page" strong>{said && !said.over && said.title === MAC_SERVER.wrongTitle ? MAC_SERVER.wrongTitle : MAC_SERVER.title}</Text><Text tone="muted">{MAC_SERVER.line}</Text></View>
      {said ? <Banner tone="warn"><Text strong>{said.title}</Text><Text>{said.line}</Text></Banner> : null}
      <Field label="Code" name="Server code" value={text} onChangeText={setText} placeholder="WINK-7K4Q-M2XD" mono help={MAC_SERVER.help} />
      <Button kind="primary" label={MAC_SERVER.connect} disabled={!text.trim() || Boolean(said?.over)} onPress={() => void connect()} />
      <Button kind="ghost" label={MAC_SERVER.back} onPress={onBack} />
    </View>
  );
}
