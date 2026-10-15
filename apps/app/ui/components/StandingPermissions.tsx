import { View } from "react-native";
import { Button } from "./Button";
import { Chip } from "./Chip";
import { Divider } from "./Card";
import { Row } from "./Row";
import { Text } from "./Text";

export type StandingRow = { id: string; title: string; chips: string[]; meta: string; following?: boolean; recent?: string[] };

/**
 * What an agent may send, post or pay by itself: a row per permission with its connection, the people or domains it may go to as chips, the daily cap and how often it has been used,
 * and Revoke. A followed list says so on the row. "Add" opens the person's sheet. Revoking ends it at once. See docs/design/system/components/standing-permissions.md.
 */
export function StandingPermissions({ rows, onRevoke, onAdd, canEdit = true, empty = "This agent asks you each time it wants to send, post or pay." }: {
  rows: StandingRow[]; onRevoke: (id: string) => void; onAdd: () => void; canEdit?: boolean; empty?: string;
}) {
  return (
    <View className="gap-s2">
      {rows.length ? rows.map((r, i) => (
        <View key={r.id}>
          {i ? <Divider inset={16} /> : null}
          <Row title={r.title} sub={r.meta}
            end={canEdit ? <Button kind="ghost" size="sm" label="Revoke" onPress={() => onRevoke(r.id)} /> : undefined} />
          <View className="flex-row flex-wrap gap-s2 px-s4 pb-s2">
            {r.chips.map((c) => <Chip key={c}>{c}</Chip>)}
            {r.following ? <Chip tone="warn">Follows the list</Chip> : null}
          </View>
          {r.recent && r.recent.length ? <Text size="caption" tone="label" className="px-s4 pb-s2">{`Recently: ${r.recent.join("; ")}`}</Text> : null}
        </View>
      )) : <Text tone="muted">{empty}</Text>}
      {canEdit ? <View className="self-start"><Button kind="ghost" size="sm" icon="plus" label="Let it act by itself" onPress={onAdd} /></View> : null}
    </View>
  );
}
