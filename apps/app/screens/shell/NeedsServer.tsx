import { View } from "react-native";
import { Button, Card, Divider, EmptyState, Row, SectionLabel, type ShellSpace } from "@vyre/ui";
import { ADD_SERVER, NEEDS_SERVER } from "./basic.js";

/** What a Basic personal space shows where a place needs a server: one plain line, the team spaces the person is in (each opens that space), and a server of their own. */
export function NeedsServer({ teams, onOpenTeam, onAddServer }: { teams: readonly ShellSpace[]; onOpenTeam: (id: string) => void; onAddServer: () => void }) {
  return (
    <View className="gap-s4 p-s4">
      <Card><EmptyState title={NEEDS_SERVER} body="Chats and projects work in Personal as they are. This part lives in a Cloud space." /></Card>
      {teams.length ? (
        <View className="gap-s2">
          <SectionLabel>Your team spaces</SectionLabel>
          <Card flush>
            {teams.map((t, i) => <View key={t.id}>{i ? <Divider /> : null}<Row title={t.name} sub={t.sub} onPress={() => onOpenTeam(t.id)} /></View>)}
          </Card>
        </View>
      ) : null}
      <View className="flex-row"><Button kind="primary" label={ADD_SERVER} onPress={onAddServer} /></View>
    </View>
  );
}
