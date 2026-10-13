// Your accounts: the MCP servers a team member brought themselves. Kept in the member's own vault (mcp.mine.*), used only in their own sessions, never shown to the owner. A credential is typed once and never shown again.
// A locked vault says so in words and asks the member to unlock it; it never falls back to anyone else's.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, Field, Row, Text, showToast } from "@vyre/ui";
import { callT as call } from "../../src/real/call-tool";

type Mine = { name: string; type: string; url: string };
const say = (e: { code?: string; message?: string } | undefined) => (e?.code === "locked" ? "Unlock your vault first, then try again." : e?.message || "That did not work.");

export default function RealMine() {
  const [list, setList] = useState<Mine[] | null>(null);
  const [problem, setProblem] = useState("");
  const [adding, setAdding] = useState(false);
  const [n, setN] = useState({ name: "", url: "", token: "" });
  const load = useCallback(() => { call<Mine[]>("mcp.mine.list").then((r) => { if (r.error) { setProblem(say(r.error)); setList([]); } else { setProblem(""); setList(r.data ?? []); } }); }, []);
  useEffect(load, [load]);
  const add = () => call("mcp.mine.add", { name: n.name.trim(), type: "http", url: n.url.trim(), ...(n.token.trim() ? { headers: { authorization: `Bearer ${n.token.trim()}` } } : {}) })
    .then((r) => { if (r.error) { showToast(say(r.error)); return; } setN({ name: "", url: "", token: "" }); setAdding(false); load(); });
  const remove = (name: string) => call("mcp.mine.remove", { name }).then((r) => { if (r.error) showToast(say(r.error)); else load(); });
  if (!list) return null;
  return (
    <View className="gap-s3 pt-s3">
      <Text size="secondary" tone="muted">Your accounts: servers you add here are kept in your own vault and used only in your own sessions. The owner and other members cannot see them.</Text>
      {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      {list.length ? (
        <Card flush>{list.map((s, i) => (
          <View key={s.name}>{i ? <Divider /> : null}
            <Row title={s.name} end={<Button kind="ghost" size="sm" label="Remove" onPress={() => remove(s.name)} />}><Text size="secondary" tone="label" mono numberOfLines={1}>{s.url}</Text></Row>
          </View>
        ))}</Card>
      ) : problem ? null : <EmptyState title="No accounts of your own yet" body="Add a mail, calendar or other MCP server you sign in to yourself." />}
      {adding ? (
        <View className="gap-s3">
          <Field label="Name" value={n.name} onChangeText={(name) => setN({ ...n, name })} help="Letters, digits, dot and dash." />
          <Field label="Address" value={n.url} onChangeText={(url) => setN({ ...n, url })} placeholder="https://example.com/mcp" />
          <Field label="Token (optional)" value={n.token} onChangeText={(token) => setN({ ...n, token })} kind="password" help="Sent as a bearer token. It is kept in your vault and not shown again." />
          <View className="flex-row gap-s2"><Button kind="primary" label="Add" onPress={add} /><Button kind="ghost" label="Cancel" onPress={() => setAdding(false)} /></View>
        </View>
      ) : <View className="self-start"><Button kind="ghost" size="sm" icon="plus" label="Add one of your own" onPress={() => setAdding(true)} /></View>}
    </View>
  );
}
