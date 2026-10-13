// Your AI keys: make a key for one of your AIs and name it. The AI then acts as you in Vyre, with the access you have and no more; the name is what shows in Activity and approvals afterwards.
// A key is for `vyre mcp` on this computer, or hosted: a URL and the key for any MCP client over HTTP. Each key has a Revoke that ends it at once. Sending, publishing and paying still wait for your yes.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, MenuRow, Row, SecretField, Segmented, Switch, Text, showToast } from "@vyre/ui";
import { Page, Sec } from "../places/Frame";
import { changeLine, usedLine, type Change, type Connection, type Made } from "./mcp-model";
import { mcp } from "./mcp";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);
const copy = (text: string) => { Clipboard.setStringAsync(text).catch(() => {}); showToast("Copied"); };

type Snip = "claude" | "codex" | "json";
/** After a key is made: where it goes, what to paste, and one Copy. The key itself is masked and shown once. */
function MadeCard({ made, onDone }: { made: Made; onDone: () => void }) {
  const [snip, setSnip] = useState<Snip>("claude");
  return (
    <Card className="gap-s3">
      <Text strong>{`${made.name} has a key`}</Text>
      <Text size="caption" tone="label">{made.local ? "Paste the line for your AI once. The key is in a file only your user account can read." : "Paste one of these into the AI's own settings."}</Text>
      {made.url ? <Text mono selectable>{made.url}</Text> : null}
      {!made.local ? <View className="gap-s2"><SecretField label="Key" read={() => made.key} /><Text size="caption" tone="label">Shown once. You won't see it again.</Text></View> : null}
      <Segmented label="What to paste" options={[["claude", "Claude Code"], ["codex", "Codex"], ["json", "JSON"]]} value={snip} onChange={setSnip} />
      <View className="flex-row flex-wrap gap-s2">
        <Button label={`Copy the ${snip === "claude" ? "Claude Code line" : snip === "codex" ? "Codex line" : "JSON config"}`} onPress={() => copy(made.snippets[snip])} />
        {made.url ? <Button kind="ghost" size="sm" label="Copy the URL" onPress={() => copy(made.url as string)} /> : null}
        <Button kind="ghost" size="sm" label="Done" onPress={onDone} />
      </View>
    </Card>
  );
}

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
  const [only, setOnly] = useState("");
  const load = useCallback(() => {
    setErr("");
    mcp.list().then(setConns).catch((e) => { setConns([]); setErr("Your keys could not be read. Try again."); console.warn("mcpconn.list failed:", e instanceof Error ? e.message : e); });
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
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {made ? <MadeCard made={made} onDone={() => setMade(null)} /> : null}
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
              <MenuRow items={c.revoked ? [{ label: "View activity", onPress: () => setOnly(only === c.name ? "" : c.name) }] : [{ label: "View activity", onPress: () => setOnly(only === c.name ? "" : c.name) }, { label: "Revoke", danger: true, onPress: () => setEnding(c.id) }]}>
                {(menu) => (
                  <View className="gap-s2 p-s3">
                    <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{c.name}</Text><Chip>{c.revoked ? "Revoked" : "Active"}</Chip>{menu}</View>
                    <Text size="caption" tone="muted">{`${c.hosted ? "Hosted" : `This computer (${c.where})`}. ${usedLine(c, now)}.`}</Text>
                    {ending === c.id && !c.revoked ? (
                      <View className="gap-s2">
                        <Text size="caption">{`Revoke ${c.name}? Its next call is refused.`}</Text>
                        <View className="flex-row flex-wrap gap-s2">
                          <Button size="sm" label="Revoke" disabled={busy === c.id} onPress={() => void act(c.id, async () => { await mcp.revoke(c.id); setEnding(""); })} />
                          <Button size="sm" kind="ghost" label="Cancel" onPress={() => setEnding("")} />
                        </View>
                      </View>
                    ) : null}
                  </View>
                )}
              </MenuRow>
            </View>
          ))}
        </Card>
      </Sec>
      <Sec title={only ? `Changed lately by ${only}` : "Changed lately"}>
        <Card flush>
          {!changes.filter((c) => !only || c.name === only).length ? <EmptyState title="Nothing yet" body="What your AIs change shows here, by key name and tool, never what was in it." /> : null}
          {changes.filter((c) => !only || c.name === only).slice(0, 12).map((c, i) => <View key={`${c.at}-${i}`}>{i ? <Divider /> : null}<Row dense title={changeLine(c, now)} /></View>)}
        </Card>
      </Sec>
    </Page>
  );
}
