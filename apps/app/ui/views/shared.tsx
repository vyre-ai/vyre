import { View } from "react-native";
import { Text } from "../components/Text";
import { Avatar } from "../components/Avatar";
import { renderField } from "../fields/registry";
import { isTemplateField, templateLabel } from "../records/template-names.js";
import type { FieldEnv } from "../fields/types";
import { titleOf, val, viewDefOf } from "./logic.js";

/**
 * The records a screen draws. A world read whole has every record of every type; a partial one (Records opening from its kept copy or a first page, ui/views/records-cache.js) has one type's
 * first rows, the box's `counts` for the tabs and the `links` titles those rows point at.
 */
export type RecordsWorld = { types: any[]; byType: Record<string, any[]>; actors: any[]; me?: string; counts?: Record<string, number>; links?: Record<string, { title: string; type: string; id: string }>; partial?: boolean };

/** One field of one record, drawn by the kind's renderer in its compact form: what lists, boards and agendas show. */
export function fieldNode(f: any, rec: any, env: FieldEnv) {
  const v = val(rec, f.name);
  return renderField({ kind: f.kind, definition: f, value: isTemplateField(rec, f) ? templateLabel(v) : v, mode: "compact", read_only: true }, env);
}

/** The title of a row, with a tile of initials before it for a person-like type. */
export function TitleCell({ def, rec }: { def: any; rec: any }) {
  const vd = viewDefOf(def), title = titleOf(def, rec, vd);
  return (
    <View className="min-w-0 flex-row items-center gap-s2">
      {vd.initials ? <Avatar of={{ kind: "person", id: String(rec?.id ?? title), name: title }} size={24} /> : null}
      <Text strong numberOfLines={1} className="min-w-0 flex-shrink">{title}</Text>
    </View>
  );
}
