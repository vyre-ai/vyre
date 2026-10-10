// The Kits of this space: the installed ones (with Update and Remove) and the ones on offer (Read the card). A Remove is a held press.
import { View } from "react-native";
import { Button, Card, Chip, Divider, Row } from "@vyre/ui";
import { IconTile } from "../places/Page";
import { addsLine, kitLine, kitName, statusWord, type KitRow, type LibraryKit } from "./kits-model";

export function InstalledKits({ shown, newer, busy, onUpdate, onRemove }: { shown: KitRow[]; newer: Record<string, number>; busy: boolean; onUpdate: (k: KitRow) => void; onRemove: (k: KitRow) => void }) {
  return (
    <Card flush>
      {shown.map((k, i) => (
        <View key={k.id}>{i ? <Divider /> : null}
          <Row lead={<IconTile icon="box" />} title={kitName(k.id)} sub={kitLine(k)}
            end={k.status === "installed" ? <View className="flex-row items-center gap-s2">{newer[k.id] ? <Button kind="primary" size="sm" label={`Update to v${newer[k.id]}`} onPress={() => onUpdate(k)} /> : null}<Button kind="holdText" size="sm" label="Remove" disabled={busy} onPress={() => onRemove(k)} /></View> : <Chip>{statusWord(k.status)}</Chip>} />
        </View>
      ))}
    </Card>
  );
}

export function AvailableKits({ offer, loadingCard, onRead }: { offer: LibraryKit[]; loadingCard: string; onRead: (k: LibraryKit) => void }) {
  return (
    <Card flush>
      {offer.map((k, i) => (
        <View key={k.id}>{i ? <Divider /> : null}
          <Row lead={<IconTile icon="box" />} title={k.name ?? kitName(k.id)} sub={[k.description, addsLine(k)].filter(Boolean).join(" · ")}
            end={<Button size="sm" kind="primary" label={loadingCard === k.id ? "Reading" : "Read the card"} onPress={loadingCard ? () => {} : () => onRead(k)} />} />
        </View>
      ))}
    </Card>
  );
}
