// Your AI keys: make a key for one of your AIs and name it. The AI then acts as you in Vyre, with the access you have and no more; the name is what shows in Activity and approvals afterwards.
// A key is for `vyre mcp` on this computer, or hosted: a URL and the key for any MCP client over HTTP. Each key has a Revoke that ends it at once. Sending, publishing and paying still wait for your yes.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Switch, Text, showToast } from "@vyre/ui";
import { Page, Sec } from "../places/Frame";
import { changeLine, usedLine, type Change, type Connection, type Made } from "./mcp-model";
import { mcp } from "./mcp";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);
const copy = (text: string) => { Clipboard.setStringAsync(text).catch(() => {}); showToast("Copied"); };

/** Sample world only (the screenshot pass): the screen with these keys and changes, calling nothing. */
export type McpSample = { connections: Connection[]; changes: Change[]; made?: Made; ending?: string };

export default function McpScreen({ sample }: { sample?: McpSample } = {}) {
  const [conns, setConns] = useState<Connection[] | null>(sample ? sample.connections : null);
  const [changes, setChanges] = useState<Change[]>(sample ? sample.changes : []);
  const [err, setErr] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState("");
  const [made, setMade] = useState<Made | null>(sample?.made ?? null);
  const [ending, setEnding] = useState(sample?.ending ?? "");
  const [name, setName] = useState("");
  const [hosted, setHosted] = useState(false);
  const load = useCallback(() => {
    setErr("");
    mcp.list().then(setConns).catch((e) => { setConns([]); setErr(say(e, "Your AI keys could not be read.")); });
    mcp.activity().then(setChanges).catch(() => setChanges([]));
  }, []);
  useEffect(() => { if (!sample) load(); }, [load, sample]);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setProblem("");
    try { await fn(); load(); } catch (e) { setProblem(say(e)); } finally { setBusy(""); }
  };
  const now = Date.now();
  return (
    <Page title="Your AI keys" back="/u/settings">
      <Banner>A key lets one of your AIs act as you in Vyre, with the access you have and no more. Name it for what it is. Sending, publishing and paying still wait for your yes.</Banner>
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
      {made ? (
        <Card className="gap-s3">
          <Text strong>{`${made.name} has a key`}</Text>
          <Text size="caption" tone="label">{made.local ? "Run the line for your AI once. The key is in a file only your user account can read." : "Paste one of these into the AI's own settings. The key is shown only now; if you lose it, make another."}</Text>
          {made.url ? <Text mono selectable>{made.url}</Text> : null}
          {!made.local ? <Text mono selectable>{made.key}</Text> : null}
          <Text mono selectable>{made.snippets.claude}</Text>
          <View className="flex-row flex-wrap gap-s2">
            {made.url ? <Button size="sm" label="Copy the URL" onPress={() => copy(made.url as string)} /> : null}
            {!made.local ? <Button size="sm" label="Copy the key" onPress={() => copy(made.key)} /> : null}
            <Button size="sm" kind="ghost" label="Copy the Claude Code line" onPress={() => copy(made.snippets.claude)} />
            <Button size="sm" kind="ghost" label="Copy the Codex line" onPress={() => copy(made.snippets.codex)} />
            <Button size="sm" kind="ghost" label="Copy the JSON config" onPress={() => copy(made.snippets.json)} />
          </View>
          <View className="self-start"><Button kind="ghost" size="sm" label="Done" onPress={() => setMade(null)} /></View>
        </Card>
      ) : null}
      <Sec title="Make a key">
        <Card className="gap-s2">
          <Field name="Its name" value={name} onChangeText={setName} placeholder="Claude Code on laptop" />
          <Row dense title="Hosted" sub="A URL and a key for any MCP client. Keys can't install apps, add accounts or touch the vault." end={<Switch label="Hosted" on={hosted} onChange={setHosted} />} />
          <View className="self-start"><Button label="Make the key" disabled={!name.trim() || busy === "new"} onPress={() => void act("new", async () => { setMade(await mcp.connect(name.trim(), hosted)); setName(""); })} /></View>
        </Card>
      </Sec>
      <Sec title="Your keys">
        <Card flush>
          {conns === null ? <LoadingState rows={2} /> : null}
          {err ? <ErrorState title="Keys did not load" reason={err} retry={load} /> : null}
          {conns && !err && !conns.length ? <EmptyState title="No keys yet" body="Make one above. The AI can then work as you until you revoke it." /> : null}
          {(conns || []).map((c, i) => (
            <View key={c.id}>
              {i ? <Divider /> : null}
              <View className="gap-s2 p-s3">
                <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{c.name}</Text><Chip>{c.revoked ? "Revoked" : c.hosted ? "Hosted" : "This computer"}</Chip></View>
                <Text size="caption" tone="muted">{`${c.hosted ? "Hosted" : c.where}. ${usedLine(c, now)}.`}</Text>
                {c.revoked ? null : ending === c.id ? (
                  <View className="gap-s2">
                    <Text size="caption">{`Revoke ${c.name}? Its next call is refused.`}</Text>
                    <View className="flex-row flex-wrap gap-s2">
                      <Button size="sm" label="Revoke" disabled={busy === c.id} onPress={() => void act(c.id, async () => { await mcp.revoke(c.id); setEnding(""); })} />
                      <Button size="sm" kind="ghost" label="Cancel" onPress={() => setEnding("")} />
                    </View>
                  </View>
                ) : <View className="flex-row"><Button size="sm" kind="ghost" label="Revoke" onPress={() => setEnding(c.id)} /></View>}
              </View>
            </View>
          ))}
        </Card>
      </Sec>
      <Sec title="Changed lately">
        <Card flush>
          {!changes.length ? <EmptyState title="Nothing yet" body="What your AIs change shows here, by key name and tool, never what was in it." /> : null}
          {changes.slice(0, 12).map((c, i) => <View key={`${c.at}-${i}`}>{i ? <Divider /> : null}<Row dense title={changeLine(c, now)} /></View>)}
        </Card>
      </Sec>
    </Page>
  );
}
