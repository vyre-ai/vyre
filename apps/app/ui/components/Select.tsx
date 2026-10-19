import { useId, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { Menu } from "./Menu";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { Field } from "./Field";
import { PickerList } from "./PickerList";
import { filterItems, moveActive } from "../lib/picker-model.js";

/** Past this many options the list opens with a search field (type to filter); a short list stays a plain menu. */
export const SEARCH_FROM = 15;

/** One choice from a list, in a menu. Looks like Field; the options are [value, label]. "None" is the caller's option when a blank is allowed. A long list (more than SEARCH_FROM, or `search`) opens in a sheet with a search field. */
export function Select({ value, options, onChange, placeholder = "Choose", label, disabled, className, search }: {
  value: string; options: [string, string][]; onChange: (v: string) => void; placeholder?: string; label?: string; disabled?: boolean; className?: string;
  /** Type to filter the list. Default: on when there are more than SEARCH_FROM options. */ search?: boolean;
}) {
  const current = options.find(([v]) => v === value);
  const [open, setOpen] = useState(false);
  const searchable = search ?? options.length > SEARCH_FROM;
  const shown = current?.[1] ?? placeholder;
  const trigger = (
    <Pressable disabled={disabled} accessibilityRole="button" accessibilityLabel={label ? `${label}: ${shown}` : shown}
      {...(searchable ? { onPress: () => setOpen(true) } : null)}
      className="h-control w-full min-w-0 flex-row items-center gap-s2 rounded-field border border-edge bg-surface-3 px-s3"
      style={({ hovered }: any) => (hovered ? { borderColor: "var(--edge-strong)" } : undefined)}>
      <Text numberOfLines={1} tone={current ? "default" : "label"} style={{ flex: 1, minWidth: 0 }}>{shown}</Text>
      <Icon name="chevron-down" size={16} tone="label" />
    </Pressable>
  );
  return (
    <View className={cn("min-w-0 gap-s1", disabled && "opacity-60", className)}>
      {label ? <Text size="caption" strong tone="label">{label}</Text> : null}
      {searchable ? (
        <>
          {trigger}
          {open ? <SearchList title={label ?? placeholder} value={value} options={options} onClose={() => setOpen(false)} onPick={(v) => { setOpen(false); onChange(v); }} /> : null}
        </>
      ) : (
        <Menu trigger={trigger} items={options.map(([v, l]) => ({ label: l, selected: v === value, onPress: () => onChange(v) }))} />
      )}
    </View>
  );
}

/** The long list: a search field over the options, arrows to move, Enter to pick. Rows draw with the theme's colours as styles (PickerList), so they read in a portal. */
function SearchList({ title, value, options, onClose, onPick }: { title: string; value: string; options: [string, string][]; onClose: () => void; onPick: (v: string) => void }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const all = useMemo(() => options.map(([v, l]) => ({ key: v, label: l, checked: v === value })), [options, value]);
  const items = useMemo(() => filterItems(all, query, all.length), [all, query]);
  const [active, setActive] = useState(() => Math.max(0, all.findIndex((i) => i.key === value)));
  const at = Math.min(active, Math.max(0, items.length - 1));
  const pick = (i: number) => { const it = items[i]; if (it) onPick(it.key); };
  return (
    <Sheet open onClose={onClose} title={title} scroll={false}>
      <Field name={`Search ${title}`} placeholder="Search" value={query} autoFocus
        onChangeText={(q) => { setQuery(q); setActive(0); }}
        onSubmit={() => pick(at)}
        onKey={(k, e) => {
          if (k === "ArrowDown" || k === "ArrowUp") { e?.preventDefault?.(); setActive(moveActive(at, k === "ArrowDown" ? 1 : -1, items.length)); }
          else if (k === "Escape") onClose();
        }} />
      <PickerList id={`select-${id}`} label={title} items={items} active={at} onActive={setActive} onPick={pick} maxRows={8} />
    </Sheet>
  );
}
