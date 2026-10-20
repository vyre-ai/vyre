import { useId, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { Field } from "./Field";
import { Segmented } from "./Segmented";
import { PickerList, type PickerItem } from "./PickerList";
import { ProviderLogo } from "./ProviderLogo";
import { providerName } from "../marks/provider.js";
import { moveActive } from "../lib/picker-model.js";
import { chosen, detailLine, detailRows, effortChoices, effortFor, emptyWords, pickValue, searchModels, type Account, type Model, type ModelGroup } from "../../src/models/model-choice.js";

export type ModelPick = { account: Account; model: Model };

/**
 * The one model picker, on every screen that chooses a model: the person's own AI accounts, each with the provider's mark and the models it can run, searchable, every row with its details in one line
 * (who makes it, context, price, a vision or tools mark). Under it, the chosen model's details and, only when that model takes one, the effort control with that model's own levels. Groups come from
 * src/models/useMyModels.ts (the one model service); nothing here names a model.
 */
export function ModelPicker({ groups, value, onChange, effort, onEffort, label = "Model", disabled, note, details = true }: {
  /** The person's accounts and their models; null while the first look has not answered. */ groups: ModelGroup[] | null;
  /** What runs now: the account when known, the provider and the model id. */ value: { account?: string | null; provider?: string | null; model?: string | null };
  onChange: (pick: ModelPick) => void;
  /** The effort kept now, and its setter; without onEffort no effort control is drawn. */ effort?: string | null; onEffort?: (e: string) => void;
  label?: string; disabled?: boolean; /** A quiet line under the picker (a refusal, what a choice changes). */ note?: string; /** Show the chosen model's details under it. */ details?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const now = useMemo(() => (groups ? chosen(groups, value) : null), [groups, value]);
  const shown = now ? now.model.name : value.model || (groups === null ? "Loading your models" : "Choose a model");
  const efforts = effortChoices(now?.model);
  const effortNow = effortFor(now?.model, effort);
  const nothing = groups !== null && !groups.some((g) => g.models.length);
  return (
    <View style={{ gap: 6, minWidth: 0, opacity: disabled ? 0.6 : 1 }}>
      {label ? <Text size="caption" strong tone="label">{label}</Text> : null}
      <Pressable disabled={disabled || nothing} accessibilityRole="button" accessibilityLabel={`${label}: ${shown}`} onPress={() => setOpen(true)}
        className="min-h-control w-full min-w-0 flex-row items-center gap-s2 rounded-field border border-edge bg-surface-3 px-s3 py-s1"
        style={({ hovered }: any) => (hovered ? { borderColor: "var(--edge-strong)" } : undefined)}>
        {now ? <ProviderLogo provider={now.model.provider} size={18} /> : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} tone={now || value.model ? "default" : "label"}>{shown}</Text>
          {now ? <Text size="caption" tone="label" numberOfLines={1}>{[now.account.label, detailLine(now.model)].filter(Boolean).join(" · ")}</Text> : null}
        </View>
        <Icon name="chevron-down" size={16} tone="label" />
      </Pressable>
      {nothing ? <Text size="caption" tone="label">{emptyWords(groups || [])}</Text> : null}
      {details && now ? detailRows(now.model).map((l) => <Text key={l} size="caption" tone="label">{l}</Text>) : null}
      {onEffort && efforts.length ? <Segmented label="Effort" value={effortNow} options={efforts} onChange={(e) => onEffort(e)} /> : null}
      {note ? <Text size="caption" tone="label">{note}</Text> : null}
      {open && groups ? <ModelPickerSheet title={label} groups={groups} current={now} onClose={() => setOpen(false)} onPick={(p) => { setOpen(false); onChange(p); }} /> : null}
    </View>
  );
}

/**
 * The list on its own, for a screen that opens it from a control of its own (the chat composer's model chip): a search field over every account's models, arrows to move, Enter to pick, Escape to
 * close. Rows sit under their account's name. With `onEffort`, the chosen model's own effort levels sit under the list, only when it takes effort.
 */
export function ModelPickerSheet({ title, groups, current, onClose, onPick, effort, onEffort, inline }: { title: string; groups: ModelGroup[]; current: ModelPick | null; onClose: () => void; onPick: (p: ModelPick) => void; effort?: string | null; onEffort?: (e: string) => void; /** Drawn in place rather than over the screen (the design gallery's picture). */ inline?: boolean }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => searchModels(groups, query).flatMap((g) => g.models.map((m) => ({ account: g.account, model: m }))), [groups, query]);
  const items: PickerItem[] = useMemo(() => rows.map(({ account, model }) => ({
    key: pickValue(account, model), label: model.name, sub: detailLine(model), group: `${account.label} · ${providerName(account.provider)}`,
    leading: <ProviderLogo provider={model.provider} size={18} />, checked: Boolean(current && current.account.id === account.id && current.model.key === model.key),
  })), [rows, current]);
  const [active, setActive] = useState(() => Math.max(0, rows.findIndex((r) => current && r.account.id === current.account.id && r.model.key === current.model.key)));
  const at = Math.min(active, Math.max(0, items.length - 1));
  const pick = (i: number) => { const r = rows[i]; if (r) onPick(r); };
  const body = (
    <>
      <Field name={`Search ${title}`} placeholder="Search models" value={query} autoFocus
        onChangeText={(q) => { setQuery(q); setActive(0); }}
        onSubmit={() => pick(at)}
        onKey={(k, e) => {
          if (k === "ArrowDown" || k === "ArrowUp") { e?.preventDefault?.(); setActive(moveActive(at, k === "ArrowDown" ? 1 : -1, items.length)); }
          else if (k === "Escape") onClose();
        }} />
      <PickerList id={`models-${id}`} label={title} items={items} active={at} onActive={setActive} onPick={pick} maxRows={9} empty={groups.some((g) => g.models.length) ? "No model of yours matches" : emptyWords(groups)} />
      {onEffort && current && effortChoices(current.model).length ? <Segmented label={`Effort for ${current.model.name}`} value={effortFor(current.model, effort)} options={effortChoices(current.model)} onChange={(e) => onEffort(e)} /> : null}
    </>
  );
  if (inline) return <View style={{ gap: 12 }}><Text strong>{title}</Text>{body}</View>;
  return <Sheet open onClose={onClose} title={title} scroll={false}>{body}</Sheet>;
}
