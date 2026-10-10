// One list of everything connected: apps connected from a key (HTTP APIs) and MCP servers, side by side with a plain word for how each is doing. Each row opens its own tab for the detail; the
// person does not have to know which tab holds what to see that it works.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, EmptyState, ErrorState, LoadingState } from "@vyre/ui";
import { connections } from "./source-real";
import { words } from "./model";
import { unifyConnected, type Connected } from "./any-app";
import { ConnectedList } from "./ConnectedList";

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
        <ConnectedList list={list} onOpen={(c) => open(c.kind === "mcp" ? "mcp" : "any")} />
      ) : <Card><EmptyState title="Nothing connected yet" body="Add a service, an app with an API, or an MCP server." /></Card>}
      <View className="self-start"><Button kind="ghost" size="sm" icon="plus" label="Add a connection" onPress={() => open("add")} /></View>
    </View>
  );
}
