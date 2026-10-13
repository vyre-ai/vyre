// The one project picker (the chat panel's Move page and the chat list's Move sheet): type to filter, Up and Down, Enter moves the chat there, Esc goes back.
// "Remove from project" files it under the General project (a chat always has one); it is offered only when the chat is in another and General exists.
import { useEffect, useMemo, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { Avatar, Icon, PickerList, markRef, useUiTheme, type PickerItem } from "@vyre/ui";
import { filterItems, moveActive, pickerKey } from "@vyre/ui/lib/picker-model.js";
import type { ProjectRef } from "./useChatProject";

export function ProjectPicker({ projects, current, onPick, onBack }: { projects: readonly ProjectRef[]; current: ProjectRef | null; onPick: (slug: string | null) => void; onBack: () => void }) {
  const { color } = useUiTheme();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const general = projects.find((x) => x.slug === "general") ?? null;
  const items = useMemo(() => {
    const rows: (PickerItem & { slug: string | null })[] = filterItems(projects.filter((x) => x.slug !== "general" || !general).map((x) => ({ ...x, label: x.name })), q).map((x) => ({ key: x.slug, label: x.name, sub: x.slug === current?.slug ? "This chat is here" : undefined, leading: <Avatar of={markRef("project", x.name, x.slug)} size={24} />, checked: x.slug === current?.slug ? true : undefined, slug: x.slug }));
    if (current && general && current.slug !== "general" && !q) rows.push({ key: "none", label: "Remove from project", leading: <Icon name="x" size={18} />, slug: null });
    return rows;
  }, [projects, current, q, general]);
  useEffect(() => setActive(0), [q]);
  const pick = (slug: string | null) => onPick(slug === null ? general?.slug ?? null : slug);
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        autoFocus value={q} onChangeText={setQ} placeholder="Find a project" accessibilityLabel="Find a project" placeholderTextColor={color.label}
        {...(Platform.OS === "web" ? ({ role: "combobox", "aria-expanded": true, "aria-controls": "project-pop", "aria-activedescendant": items.length ? `project-pop-opt-${active}` : undefined } as object) : {})}
        onKeyPress={(e: any) => {
          const ev = e.nativeEvent;
          const a = pickerKey(ev, { query: q, count: items.length });
          if (a === "next" || a === "prev") { e.preventDefault?.(); setActive((i) => moveActive(i, a === "next" ? 1 : -1, items.length)); }
          else if (a === "pick") { e.preventDefault?.(); pick(items[active].slug); }
          else if (a === "close") { e.preventDefault?.(); e.stopPropagation?.(); onBack(); }
        }}
        style={{ minHeight: 44, borderWidth: 1, borderColor: color["edge-strong"], color: color.text, borderRadius: 12, paddingHorizontal: 12, fontSize: 16, outlineStyle: "none" } as any}
      />
      <PickerList id="project-pop" label="Projects" items={items} active={active} onActive={setActive} onPick={(i) => pick(items[i].slug)} footer="Type to filter. Up and Down, Enter to move, Esc to go back" maxRows={8} empty="No project matches" />
    </View>
  );
}
