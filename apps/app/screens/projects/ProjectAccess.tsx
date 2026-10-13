// The rail's Access block: which agents may reach this project's data (projects.access.list, grant and revoke). A person's own act: the box refuses an agent or a member the list, so a refusal is said in words and the block stays quiet.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Divider, Row, Sheet, Text, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";

type Grant = { agent: string; status?: string };

export function ProjectAccess({ slug }: { slug: string }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [picking, setPicking] = useState(false);
  const [agents, setAgents] = useState<string[]>([]);
  const load = useCallback(() => { void callT<{ grants?: Grant[] }>("projects.access.list", { project: slug }).then((r) => { if (r.error) { setDenied(true); setGrants([]); } else setGrants((r.data?.grants ?? []).filter((g) => g.status !== "revoked")); }); }, [slug]);
  useEffect(load, [load]);
  useEffect(() => { if (picking) void callT<unknown>("agents.list").then((r) => { const d = r.data as { agents?: { name: string }[] } | { name: string }[] | undefined; const list = Array.isArray(d) ? d : d?.agents ?? []; setAgents(list.map((a) => a.name).filter((n) => !grants?.some((g) => g.agent === n))); }); }, [picking, grants]);
  if (grants === null || denied) return null;
  const act = async (tool: string, agent: string, ok: string) => { const r = await callT(tool, { project: slug, agent }); if (r.error) showToast(r.error.message || "That did not go through."); else { showToast(ok); load(); } };
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">Access</Text>
      {grants.length ? <Card flush>{grants.map((g, i) => <View key={g.agent}>{i ? <Divider /> : null}<Row dense title={g.agent} sub="Agent that can reach this project" end={<Button kind="ghost" size="sm" label="Revoke" onPress={() => void act("projects.access.revoke", g.agent, "Access taken away.")} />} /></View>)}</Card> : <Text size="caption" tone="muted">No agent can reach this project's data yet.</Text>}
      <View className="flex-row"><Button kind="secondary" size="sm" label="Let an agent in" onPress={() => setPicking(true)} /></View>
      <Sheet open={picking} onClose={() => setPicking(false)} title="Let an agent in">
        {agents.length ? <Card flush>{agents.map((n, i) => <View key={n}>{i ? <Divider /> : null}<Row dense title={n} onPress={() => { setPicking(false); void act("projects.access.grant", n, `${n} can reach this project.`); }} /></View>)}</Card> : <Text tone="muted">Every agent you can add already has access.</Text>}
      </Sheet>
    </View>
  );
}
