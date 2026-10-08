// One list of everything connected: apps connected from a key (HTTP APIs) and MCP servers, side by side with a plain word for how each is doing. Each row opens its own tab for the detail; the
// person does not have to know which tab holds what to see that it works.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Divider, EmptyState, ErrorState, LoadingState, Row, Text } from "@vyre/ui";
import { connections } from "./source-real";
import { words } from "./model";
import { unifyConnected, type Connected } from "./any-app";

export default function RealConnected({ open }: { open: (tab: "any" | "mcp" | "add") => void }) {
  const [list, setList] = useState<Connected[] | null>(null);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => {
    Promise.all([connections.madeList().catch(() => []), connections.servers().catch(() => [])])
      .then(([made, servers]) => { setList(unifyConnected(made, servers)); setProblem(""); }).catch((e) => setProblem(words(e)));
  }, []);
  useEffect(load, [load]);
  if (problem && !list) return <ErrorState title="Your connections did not load" reason={problem} retry={load} />;
  if (!list) return <LoadingState rows={2} />;
  return (
    <View className="gap-s3 pt-s2">
      {list.length ? (
        <Card flush>
          {list.map((c, i) => (
            <View key={c.key}>{i ? <Divider /> : null}
              <Row title={<View className="flex-row items-center gap-s2"><Text strong>{c.label}</Text><Text tone="muted" size="caption">{c.kind === "mcp" ? "MCP server" : "App"}</Text></View>}
                sub={<View className="gap-s1 pt-s1"><Text size="secondary" tone={c.status === "ok" ? undefined : "muted"}>{`${c.status === "ok" ? "Working" : c.status === "bad" ? "Needs attention" : "Idle"}: ${c.words}`}</Text>
                  {c.where ? <Text size="caption" tone="muted" mono>{c.where}</Text> : null}
                  <View className="self-start"><Button size="sm" kind="ghost" label="Open" onPress={() => open(c.kind === "mcp" ? "mcp" : "any")} /></View></View>} />
            </View>
          ))}
        </Card>
      ) : <Card><EmptyState title="Nothing connected yet" body="Add a service, an app with an API, or an MCP server." /></Card>}
      <View className="self-start"><Button kind="ghost" size="sm" icon="plus" label="Add a connection" onPress={() => open("add")} /></View>
    </View>
  );
}
