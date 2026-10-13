import { View } from "react-native";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { IconButton } from "../components/Button";
import { Row } from "../components/Row";
import { fieldSummary } from "./logic.js";
import type { Draft } from "./logic.js";
import type { TypeRef } from "./types";

export type FieldRow = Partial<Draft> & { name: string; label: string; kind: string };

/** The fields of a type as rows: the name, one line that says everything set on it, and a chip only for the two states that change what a person sees (Sealed, Hidden). Open to edit, move up or down. */
export function FieldRows({ fields, types, selected, onOpen, onMove }: { fields: FieldRow[]; types: TypeRef[]; selected?: string; onOpen: (name: string) => void; onMove?: (name: string, dir: -1 | 1) => void }) {
  return (
    <Card flush>
      {fields.map((f, i) => (
        <View key={f.name}>
          {i ? <Divider /> : null}
          <Row title={f.label} sub={fieldSummary(f, types)} selected={f.name === selected} onPress={() => onOpen(f.name)}
            end={<View className="flex-row items-center gap-s1">
              {f.sealed ? <Chip tone="sealed" icon="vault">Sealed</Chip> : f.hidden ? <Chip icon="eye-off">Hidden</Chip> : null}
              {onMove ? <><IconButton icon="chevron-up" label={`Move ${f.label} up`} onPress={() => onMove(f.name, -1)} /><IconButton icon="chevron-down" label={`Move ${f.label} down`} onPress={() => onMove(f.name, 1)} /></> : null}
            </View>} />
        </View>
      ))}
    </Card>
  );
}
