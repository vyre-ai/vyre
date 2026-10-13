import { View } from "react-native";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Button, IconButton } from "../components/Button";
import { Text } from "../components/Text";
import { Row } from "../components/Row";
import { fieldSummary } from "./logic.js";
import type { Draft } from "./logic.js";
import type { TypeRef } from "./types";

/** What a field row can show of its template token: `fieldTokens` in fieldtokens.js, by field name. */
export type RowToken = { key: string; token: string; nested?: { form: string; target: string } };
export type FieldRow = Partial<Draft> & { name: string; label: string; kind: string };

/** The fields of a type as rows: the name, one line that says everything set on it, and a chip only for the two states that change what a person sees (Sealed, Hidden). Open to edit, move up or down. */
export function FieldRows({ fields, types, selected, onOpen, onMove, tokens, onCopy }: { fields: FieldRow[]; types: TypeRef[]; selected?: string; onOpen: (name: string) => void; onMove?: (name: string, dir: -1 | 1) => void; tokens?: Record<string, RowToken>; onCopy?: (text: string, what: string) => void }) {
  return (
    <Card flush>
      {fields.map((f, i) => (
        <View key={f.name}>
          {i ? <Divider /> : null}
          <Row title={f.label} sub={tokens?.[f.name] ? <View className="min-w-0"><Text size="secondary" tone="label" numberOfLines={1}>{fieldSummary(f, types)}</Text><Text mono size="caption" tone="muted" selectable numberOfLines={1}>{tokens[f.name].token || `${tokens[f.name].nested?.form} (${tokens[f.name].nested?.target})`}</Text><Text mono size="caption" tone="muted" numberOfLines={1}>{`Key: ${f.name}`}</Text></View> : fieldSummary(f, types)} selected={f.name === selected} onPress={() => onOpen(f.name)}
            end={<View className="flex-row items-center gap-s1">
              {f.sealed ? <Chip tone="sealed" icon="vault">Sealed</Chip> : f.hidden ? <Chip icon="eye-off">Hidden</Chip> : null}
              {tokens?.[f.name] && onCopy ? <>
                <IconButton icon="copy" label={`Copy ${tokens[f.name].token || tokens[f.name].nested?.form} for ${f.label}`} onPress={() => onCopy(tokens[f.name].token || tokens[f.name].nested?.form || "", "Token")} />
                <Button kind="ghost" size="sm" label="Key" onPress={() => onCopy(f.name, "Key")} />
              </> : null}
              {onMove ? <><IconButton icon="chevron-up" label={`Move ${f.label} up`} onPress={() => onMove(f.name, -1)} /><IconButton icon="chevron-down" label={`Move ${f.label} down`} onPress={() => onMove(f.name, 1)} /></> : null}
            </View>} />
        </View>
      ))}
    </Card>
  );
}
