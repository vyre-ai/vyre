// Connect your AI: Claude Code or Codex acts as you in Vyre once you connect it here. The lines to register it, the connections with when each was last used and a Revoke, and what it changed lately.
// Sending, publishing and paying still wait for your yes.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { Page, Sec } from "../places/Frame";
import { LINES, changeLine, usedLine, type Change, type Connection, type Made } from "./mcp-model";
import { mcp } from "./mcp";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);
const copy = (text: string) => { Clipboard.setStringAsync(text).catch(() => {}); showToast("Copied"); };

/** Sample world only (the screenshot pass): the screen with these connections and changes, calling nothing. */
export type McpSample = { connections: Connection[]; changes: Change[]; made?: Made; ending?: string };

export default function McpScreen({ sample }: { sample?: McpSample } = {}) {
  const [conns, setConns] = useState<Connection[] | null>(sample ? sample.connections : null);
  const [changes, setChanges] = useState<Change[]>(sample ? sample.changes : []);
  const [err, setErr] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState("");
  const [made, setMade] = useState<Made | null>(sample?.made ?? null);
  const [ending, setEnding] = useState(sample?.ending ?? "");
  const load = useCallback(() => {
    setErr("");
    mcp.list().then(setConns).catch((e) => { setConns([]); setErr(say(e, "Your connected AI could not be read.")); });
    mcp.activity().then(setChanges).catch(() => setChanges([]));
  }, []);
  useEffect(() => { if (!sample) load(); }, [load, sample]);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setProblem("");
    try { await fn(); load(); } catch (e) { setProblem(say(e)); } finally { setBusy(""); }
  };
  const now = Date.now();
  const lines = made?.lines ?? LINES;
  return (
    <Page title="Connect your AI" back="/u/settings">
      <Banner>Connect your own Claude Code or Codex and it acts as you in Vyre, with the access you have and no more. It can set up your projects, agents and records, and bring your old sessions in. Sending, publishing and paying still wait for your yes.</Banner>
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
      <Sec title="Connect">
        <Card className="gap-s3">
          {made ? <Text strong>{`${made.client} is connected on ${made.device}`}</Text> : <Text strong>Connect an AI on this computer</Text>}
          <Text size="caption" tone="label">Connect it here with one yes, then run the line for your AI once.</Text>
          <Text mono selectable>{lines.claude}</Text>
          <Text mono selectable>{lines.codex}</Text>
          <View className="flex-row flex-wrap gap-s2">
            <Button size="sm" label="Copy the Claude Code line" onPress={() => copy(lines.claude)} />
            <Button size="sm" kind="ghost" label="Copy the Codex line" onPress={() => copy(lines.codex)} />
          </View>
          <View className="self-start"><Button label={made ? "Connect again" : "Connect"} disabled={busy === "new"} onPress={() => void act("new", async () => setMade(await mcp.connect()))} /></View>
          <Text size="caption" tone="muted">Then, in a new session, run the prompt setup-vyre and it will walk through your work with you.</Text>
        </Card>
      </Sec>
      <Sec title="Your connections">
        <Card flush>
          {conns === null ? <LoadingState rows={2} /> : null}
          {err ? <ErrorState title="Connections did not load" reason={err} retry={load} /> : null}
          {conns && !err && !conns.length ? <EmptyState title="Nothing connected yet" body="Connect above. It can then work as you until you end it." /> : null}
          {(conns || []).map((c, i) => (
            <View key={c.id}>
              {i ? <Divider /> : null}
              <View className="gap-s2 p-s3">
                <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{c.client}</Text><Chip>{c.revoked ? "Ended" : "Connected"}</Chip></View>
                <Text size="caption" tone="muted">{`${c.device ? c.device + ". " : ""}${usedLine(c, now)}.`}</Text>
                {c.revoked ? null : ending === c.id ? (
                  <View className="gap-s2">
                    <Text size="caption">{`End ${c.client} on ${c.device || "this computer"}? Its key stops working now.`}</Text>
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
      <Sec title="Changed lately, via your Claude Code">
        <Card flush>
          {!changes.length ? <EmptyState title="Nothing yet" body="What your connected AI changes shows here, by tool, never what was in it." /> : null}
          {changes.slice(0, 12).map((c, i) => <View key={`${c.at}-${i}`}>{i ? <Divider /> : null}<Row dense title={changeLine(c, now)} /></View>)}
        </Card>
      </Sec>
    </Page>
  );
}
