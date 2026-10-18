import { useMemo } from "react";
import { View } from "react-native";
import { Button } from "../components/Button";
import { TokenField } from "../components/TokenField";
import { Menu } from "../components/Menu";
import type { Draft, Options } from "./logic.js";
import { aliasTable, appendToken, insertList, toAliasText, toPathText } from "./template.js";

/**
 * A one-line input that takes a typed value or a value from before this step. "Insert" lists what is there to use (what started the Flow, what earlier steps made); the box shows friendly names such as
 * {client.email} and stores the engine's own path, so a person never reads {steps.create1.record.data.email}. Used by every field of a step, so a value never has to be typed twice.
 */
export function ValueField({ label, name, value, onChange, placeholder, help, draft, stepId, options, multiline, lines }: {
  label?: string; name?: string; value: string; onChange: (v: string) => void; placeholder?: string; help?: string; draft: Draft; stepId: string; options: Options; multiline?: boolean; lines?: number;
}) {
  const groups = useMemo(() => insertList(draft, stepId, options), [draft, stepId, options]);
  const table = useMemo(() => aliasTable(groups), [groups]);
  const sources = groups.flatMap((g) => g.items.filter((i) => i.known).map((i) => ({ token: i.token, maybe: Boolean(g.maybe), words: `${g.object ? `${g.object} \u00b7 ` : ""}${i.label}${g.maybe ? ` (only on the ${g.maybe} path; reads n/a if that path did not run)` : ""}` })));
  return (
    <View className="gap-s1">
      <TokenField label={label} name={name} value={value} onChange={onChange} options={sources.map((s) => ({ token: s.token, label: s.words, ...(s.maybe ? { maybe: "path" } : {}) }))} placeholder={placeholder} help={help} multiline={multiline} lines={lines} plain={{ value: toAliasText(value, table), onChange: (v) => onChange(toPathText(v, table)) }} />
      {sources.length ? (
        <View className="flex-row">
          <Menu align="start" trigger={<Button kind="ghost" size="sm" icon="mention" label="Insert a value" />} items={sources.map(({ token, words, maybe }) => ({ label: words, onPress: () => onChange(appendToken(value, maybe ? token.replace(/\}$/, " | n/a}") : token)) }))} />
        </View>
      ) : null}
    </View>
  );
}
