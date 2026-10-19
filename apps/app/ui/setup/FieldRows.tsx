import { View } from "react-native";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { IconButton } from "../components/Button";
import { Menu, type MenuItem } from "../components/Menu";
import { Row } from "../components/Row";
import { fieldBadges, fieldKindLine } from "./logic.js";
import type { Draft } from "./logic.js";
import type { TypeRef } from "./types";

/** What a field row can show of its template token: `fieldTokens` in fieldtokens.js, by field name. */
export type RowToken = { key: string; token: string; nested?: { form: string; target: string } };
export type FieldRow = Partial<Draft> & { name: string; label: string; kind: string };

/**
 * The fields of a type as calm rows: the name, what it is on one line, and the badges that matter (Required, Unique, Link to Contact, Sealed, Hidden). The template token, the key and moving a field are behind one "..." menu,
 * so a row reads as a person's field and not as developer text. Press a row to edit it.
 */
export function FieldRows({ fields, types, selected, onOpen, onMove, tokens, onCopy }: { fields: FieldRow[]; types: TypeRef[]; selected?: string; onOpen: (name: string) => void; onMove?: (name: string, dir: -1 | 1) => void; tokens?: Record<string, RowToken>; onCopy?: (text: string, what: string) => void }) {
  return (
    <Card flush>
      {fields.map((f, i) => {
        const tok = tokens?.[f.name];
        const items: MenuItem[] = [
          ...(tok && onCopy ? [{ label: "Copy token", onPress: () => onCopy(tok.token || tok.nested?.form || "", "Token") }] : []),
          ...(onCopy ? [{ label: "Copy key", onPress: () => onCopy(f.name, "Key") }] : []),
          ...(onMove ? [{ label: "Move up", onPress: () => onMove(f.name, -1) }, { label: "Move down", onPress: () => onMove(f.name, 1) }] : []),
        ];
        return (
          <View key={f.name}>
            {i ? <Divider /> : null}
            <Row title={f.label} sub={fieldKindLine(f)} selected={selected === f.name} onPress={() => onOpen(f.name)}
              end={<View className="flex-row flex-wrap items-center justify-end gap-s1">
                {fieldBadges(f, types).map((b) => <Chip key={b}>{b}</Chip>)}
                {f.sealed ? <Chip tone="sealed" icon="vault">Sealed</Chip> : f.hidden ? <Chip icon="eye-off">Hidden</Chip> : null}
                {items.length ? <Menu trigger={<IconButton icon="more" label={`More for ${f.label}`} />} items={items} /> : null}
              </View>} />
          </View>
        );
      })}
    </Card>
  );
}
