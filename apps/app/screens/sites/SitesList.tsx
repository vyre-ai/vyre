// The list of sites in this space: each row is a site, what is live and where, and where it stands. Tapping a row opens the site.
import { View } from "react-native";
import { Card, Chip, Divider, IconTile, Row } from "@vyre/ui";
import { siteLine, type Site } from "./real-model";

export function SitesList({ rows, onOpen }: { rows: Site[]; onOpen: (name: string) => void }) {
  return (
    <Card flush>
      {rows.map((s, i) => (
        <View key={s.name}>{i ? <Divider inset={60} /> : null}
          <Row dense chevron onPress={() => onOpen(s.name)} lead={<IconTile name="sites" />} title={s.name} sub={siteLine(s)} end={<Chip tone={s.status.tone}>{s.status.label}</Chip>} />
        </View>
      ))}
    </Card>
  );
}
