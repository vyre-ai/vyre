import { useMemo, useRef, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import * as P from "@rn-primitives/dialog";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Icon } from "../components/Icon";
import { Field } from "../components/Field";
import { Row } from "../components/Row";
import { Text } from "../components/Text";
import { PHONE_MAX, useUiTheme } from "../theme";
import { Select } from "../components/Select";
import { DATE_DIRS, DATE_FORMATS, DATE_UNITS, appendToken, dateRefs, datePending, dateToken, dateWords, aliasTable, toAliasText, toPathText, completeBrace, history, insertList, openBrace, parseTemplate, renderPreview, smsCount, suggest, tokenKnown, tokenLabel, unknownTokens } from "./template.js";
import type { Draft, Options } from "./logic.js";

/**
 * A full-screen place to write any templated text of a step (an email subject or body, a text, a task title). Tokens are written {object.field}; the Insert panel lists every object in this Flow's
 * context with its fields, the earlier steps' outputs and the helper values, and typing "{" suggests the same list. Every change goes straight into the step (no Save), Undo steps back, and the preview
 * fills the tokens with the last run's values when there was one.
 */
export function TemplateComposer({ open, onClose, title, value, onChange, draft, stepId, options, sample, multiline = true, count = false, engineHas }: {
  open: boolean; onClose: () => void; title: string; value: string; onChange: (v: string) => void; draft: Draft; stepId: string; options: Options;
  /** Values from the last run, by token path, for the preview. */ sample?: Record<string, string>; multiline?: boolean; /** Show the character and segment count (a text message). */ count?: boolean; /** Helper tokens the engine resolves. */ engineHas?: string[];
}) {
  const { width, height } = useWindowDimensions();
  const { color } = useUiTheme();
  const wide = width >= PHONE_MAX;
  const groups = useMemo(() => insertList(draft, stepId, options, { engineHas }), [draft, stepId, options, engineHas]);
  const table = useMemo(() => aliasTable(groups), [groups]);
  const [soonOpen, setSoonOpen] = useState(false);
  const hist = useRef(history(value));
  const [, bump] = useState(0);
  const edit = (v: string) => { hist.current.push(v); onChange(v); bump((n) => n + 1); };
  const undo = () => { const v = hist.current.undo(); onChange(v); bump((n) => n + 1); };
  const [q, setQ] = useState("");
  const brace = openBrace(value);
  const hints = brace !== null ? suggest(groups, brace) : [];
  const parts = parseTemplate(value);
  const bad = unknownTokens(value, groups);
  const n = smsCount(value);
  const sealedUsed = parts.some((p) => "token" in p && groups.some((g) => g.items.some((i) => i.token === p.token && i.sealed)));
  const soon = groups.flatMap((g) => g.soon || []);
  const refs = useMemo(() => dateRefs(groups), [groups]);
  const [dateOpen, setDateOpen] = useState(false);
  const [dt, setDt] = useState({ ref: "", dir: "at", amount: 1, unit: "days", format: "" });
  const refLabel = refs.find((r) => r.token === dt.ref)?.label ?? "";
  const spec = { ...dt, refLabel, kind: refs.find((r) => r.token === dt.ref)?.dateKind };
  const panel = groups.map((g) => ({ ...g, items: g.items.filter((i) => !q || `${i.label} ${i.token}`.toLowerCase().includes(q.toLowerCase())) })).filter((g) => g.items.length);
  return (
    <P.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <P.Portal>
        <P.Overlay style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.scrim }} />
        <P.Content style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color["surface-3"], height }}>
          <View className="flex-1 gap-s3 p-s4">
            <View className="flex-row items-center gap-s2">
              <P.Title asChild><Text size="title" strong className="flex-1">{title}</Text></P.Title>
              <Button kind="ghost" size="sm" icon="undo" label="Undo" disabled={!hist.current.canUndo} onPress={undo} />
              <Button kind="primary" size="sm" label="Done" onPress={onClose} />
            </View>
            <View className={wide ? "min-h-0 flex-1 flex-row gap-s4" : "min-h-0 flex-1 gap-s3"}>
              <ScrollView className="min-w-0 flex-1" contentContainerClassName="gap-s3" keyboardShouldPersistTaps="handled">
                <Field label={title} name={title} multiline={multiline} lines={multiline ? 12 : 2} value={toAliasText(value, table)} onChangeText={(v) => edit(toPathText(v, table))} autoFocus placeholder="Write it here. Type { to insert a value." />
                {brace === "" ? <Text size="caption" tone="label">Keep typing a name, or pick from Insert.</Text> : null}
                {hints.length && brace ? (
                  <View className="gap-s1 rounded-card border border-edge bg-surface-3 p-s1">
                    {hints.map((h) => <Row key={h.token} dense title={h.label} sub={h.alias} onPress={() => edit(completeBrace(value, h.token))} />)}
                  </View>
                ) : null}
                {parts.some((p) => "token" in p) ? (
                  <View className="flex-row flex-wrap items-center gap-s2">
                    {parts.filter((p) => "token" in p).map((p, i) => {
                      const path = (p as { path: string }).path;
                      return <Chip key={i} icon={tokenKnown(path, groups) ? "mention" : "warning"} tone={tokenKnown(path, groups) ? "plain" : "warn"}>{tokenLabel(path, groups)}</Chip>;
                    })}
                  </View>
                ) : null}
                {bad.length ? <Banner tone="warn">{`${toAliasText(bad.join(", "), table)} ${bad.length === 1 ? "is" : "are"} not on the Insert list, so ${bad.length === 1 ? "it" : "they"} may stay empty when this runs. Pick from the list.`}</Banner> : null}
                {sealedUsed ? <Banner icon="lock">A sealed value is sent only where the step allows sealed values.</Banner> : null}
                {count ? <Text size="caption" tone="label">{`${n.chars} characters, ${n.segments} ${n.segments === 1 ? "text" : "texts"}${n.unicode ? " (this message has a character that makes each text shorter)" : ""}. Values you insert count by their length when sent.`}</Text> : null}
                <View className="gap-s1 rounded-card border border-edge p-s3">
                  <Text size="caption" strong tone="label">{sample ? "Preview with the last run's values" : "Preview"}</Text>
                  <Text>{renderPreview(value, sample ?? {}, groups) || "Nothing yet."}</Text>
                  {sample ? null : <Text size="caption" tone="label">There is no run yet, so values show by name in brackets.</Text>}
                </View>
              </ScrollView>
              <View className={wide ? "w-80 gap-s2" : "max-h-64 gap-s2"}>
                <Field label="Insert" name="Search the Insert list" value={q} onChangeText={setQ} placeholder="Search values" />
                <View className="gap-s2 rounded-card border border-edge p-s2">
                  <Button kind="ghost" size="sm" icon="cal" label={dateOpen ? "Close insert a date" : "Insert a date"} onPress={() => setDateOpen(!dateOpen)} />
                  {dateOpen ? (
                    <View className="gap-s2">
                      <Select label="Date" value={dt.ref} options={refs.map((r): [string, string] => [r.token, r.label])} placeholder="Choose a date field" onChange={(ref) => setDt({ ...dt, ref })} />
                      <Select label="Relative to it" value={dt.dir} options={DATE_DIRS} onChange={(dir) => setDt({ ...dt, dir })} />
                      {dt.dir === "at" ? null : (
                        <View className="flex-row items-end gap-s2">
                          <View className="w-20"><Field label="Amount" name="Amount" kind="number" value={String(dt.amount)} onChangeText={(a) => setDt({ ...dt, amount: Math.max(0, Math.floor(Number(a) || 0)) })} /></View>
                          <View className="min-w-0 flex-1"><Select label="Unit" value={dt.unit} options={DATE_UNITS} onChange={(unit) => setDt({ ...dt, unit })} /></View>
                        </View>
                      )}
                      <Select label="Show it as" value={dt.format} options={DATE_FORMATS} onChange={(format) => setDt({ ...dt, format })} />
                      {dt.ref ? <Chip icon="cal">{dateWords(spec)}</Chip> : null}
                      <Text size="caption" tone="label">{datePending(spec) ?? ""}</Text>
                      <Button kind="primary" size="sm" label="Insert the date" disabled={!dt.ref} onPress={() => { edit(appendToken(value, dateToken(dt))); setDateOpen(false); }} />
                    </View>
                  ) : null}
                </View>
                <ScrollView contentContainerClassName="gap-s2">
                  {panel.map((g) => (
                    <View key={g.title} className="gap-s1">
                      <Text size="caption" strong tone="label">{g.title}</Text>
                      {g.items.map((i) => (
                        <Row key={i.token} dense lead={i.sealed ? <Icon name="lock" tone="warn" /> : undefined} title={i.label} sub={i.note ? `${i.alias}  ${i.note}` : i.alias} onPress={() => edit(appendToken(value, i.token))} />
                      ))}
                    </View>
                  ))}
                  {panel.length ? null : <Text tone="muted">Nothing matches.</Text>}
                  {soon.length ? (
                    <View className="gap-s1">
                      <Button kind="ghost" size="sm" label={`Coming next (${soon.length})`} onPress={() => setSoonOpen(!soonOpen)} />
                      {soonOpen ? soon.map((i) => <Text key={i.token} size="caption" tone="label">{`${i.label}  ${i.alias}`}</Text>) : null}
                    </View>
                  ) : null}
                </ScrollView>
              </View>
            </View>
          </View>
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
