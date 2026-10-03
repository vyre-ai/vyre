import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../components/Text";
import { Card } from "../components/Card";
import { Avatar } from "../components/Avatar";
import { renderField } from "../fields/registry";
import type { FieldEnv } from "../fields/types";
import { initialsOf, titleOf, val, viewDefOf } from "./logic.js";

export type RecordsWorld = { types: any[]; byType: Record<string, any[]>; actors: any[] };

/** The "How this page is made" disclosure: the definition that drew the page, so the person (and @Engineer) can see the page is data. */
export function HowMade({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-s2">
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} className="min-h-control-sm flex-row items-center gap-s2 self-start">
        <Text tone="label">{open ? "▾" : "▸"}</Text>
        <Text size="caption" strong tone="label">How this page is made</Text>
      </Pressable>
      {open ? <Card><Text mono size="caption" tone="muted">{text}</Text></Card> : null}
    </View>
  );
}

/** One field of one record, drawn by the kind's renderer in its compact form: what lists, boards and agendas show. */
export function fieldNode(f: any, rec: any, env: FieldEnv) {
  return renderField({ kind: f.kind, definition: f, value: val(rec, f.name), mode: "compact", read_only: true }, env);
}

/** The title of a row, with a tile of initials before it for a person-like type. */
export function TitleCell({ def, rec }: { def: any; rec: any }) {
  const vd = viewDefOf(def), title = titleOf(def, rec, vd);
  return (
    <View className="min-w-0 flex-row items-center gap-s2">
      {vd.initials ? <Avatar name={initialsOf(title) || title} size="sm" /> : null}
      <Text strong numberOfLines={1} className="min-w-0 flex-shrink">{title}</Text>
    </View>
  );
}
