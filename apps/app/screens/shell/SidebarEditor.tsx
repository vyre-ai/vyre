import { createElement, useEffect, useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { Banner, Button, Card, Divider, Field, Menu, Row, Segmented, Text } from "@vyre/ui";
import { Frame, Sec } from "../places/Frame";
import { MOCK, said, tool } from "../../src/real/box";
import { add, builtinEntries, keyOf, moveBefore, move, remove, resolve, setGroup, setHidden, REGIONS } from "../../../../lib/sidebar/model.js";
import { catalogOf, effective, saveList, useSidebar, type Entry } from "./sidebar";
import { useSpaces } from "./state";

const REGION_LABEL: Record<string, string> = { main: "Main", more: "More", bottom: "Bottom" };
const groupLabel = (g: string | undefined, fallback: string) => (g ? REGION_LABEL[g] ?? g : fallback);

/** A row a mouse can drag on the web; elsewhere the Up and Down buttons do the same. */
function Draggable({ k, onDropOn, children }: { k: string; onDropOn: (from: string, to: string) => void; children: React.ReactNode }) {
  if (Platform.OS !== "web") return <>{children}</>;
  return createElement("div", {
    draggable: true,
    onDragStart: (e: DragEvent) => { e.dataTransfer?.setData("text/plain", k); },
    onDragOver: (e: DragEvent) => e.preventDefault(),
    onDrop: (e: DragEvent) => { e.preventDefault(); const from = e.dataTransfer?.getData("text/plain"); if (from) onDropOn(from, k); },
  }, children);
}

/** Settings, Sidebar: the places in order, each with Up, Down, Hide or Show and a group; add the ones that are not there; for you or, if you are an admin, for the team. */
export function SidebarEditor() {
  const space = useSpaces((s) => s.space);
  const { base, mine, modules, load } = useSidebar();
  const [scope, setScope] = useState<"me" | "team">("me");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  useEffect(() => { void load(space); }, [load, space]);
  const cat = useMemo(() => catalogOf(modules), [modules]);
  const list: Entry[] = useMemo(() => (scope === "team" ? (base ?? (builtinEntries() as Entry[])) : effective(base, mine)), [scope, base, mine]);
  const labelOf = (e: Entry) => (resolve(e as never, cat) as { label: string } | null)?.label ?? keyOf(e as never);
  const present = (e: Entry) => resolve(e as never, cat) !== null;

  const apply = async (next: Entry[]) => {
    setBusy(true); setError("");
    try { await saveList(scope, space, next); await load(space); } catch (e) { setError(said(e)); } finally { setBusy(false); }
  };
  const key = (e: Entry) => keyOf(e as never);
  const nextTo = (k: string, d: number) => { const i = list.findIndex((e) => key(e) === k); return i < 0 ? list : (move(list as never, k, i + d) as Entry[]); };

  // What can still be added: built-in places not in the list or hidden, and installed module screens not in it.
  const addable: { entry: Entry; label: string }[] = useMemo(() => {
    const have = new Set(list.filter((e) => !e.hidden).map(key));
    const out: { entry: Entry; label: string }[] = [];
    for (const e of builtinEntries() as Entry[]) if (!have.has(key(e)) && resolve(e as never, cat)) out.push({ entry: { kind: "place", id: (e as { id: string }).id }, label: labelOf(e) });
    for (const m of modules) for (const s of m.screens) { const e: Entry = { kind: "module", module: m.module, screen: s.id }; if (!have.has(key(e))) out.push({ entry: e, label: s.label }); }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, modules, cat]);

  return (
    <Frame title="Sidebar" sub="Arrange the places you open from the side or the tab bar.">
      <Segmented label="Whose sidebar" value={scope} onChange={(v) => setScope(v as "me" | "team")} options={[["me", "Mine"], ["team", "The team's"]]} />
      <Text size="secondary" tone="muted">{scope === "me" ? "Your own order, groups and hidden places, on top of the team's. The same on every device." : "What everyone in this Space starts from. Only an admin can change it; each person can still arrange their own."}</Text>
      {MOCK ? <Banner>The sample world cannot save a sidebar.</Banner> : null}
      {error ? <Banner tone="warn">{error}</Banner> : null}
      <Sec title="Places">
        <Card flush>
          {list.map((e, i) => (
            <View key={key(e)}>
              {i ? <Divider inset={16} /> : null}
              <Draggable k={key(e)} onDropOn={(from, to) => void apply(moveBefore(list as never, from, to) as Entry[])}>
                <Row dense title={labelOf(e)} sub={`${e.hidden ? "Hidden. " : ""}${present(e) ? groupLabel(e.group, "") : "Not available here"}`.trim() || undefined}
                  end={
                    <View className="flex-row items-center gap-s2">
                      <Button size="sm" kind="ghost" label="Up" disabled={busy || i === 0} onPress={() => void apply(nextTo(key(e), -1))} />
                      <Button size="sm" kind="ghost" label="Down" disabled={busy || i === list.length - 1} onPress={() => void apply(nextTo(key(e), 1))} />
                      <Menu trigger={<Button size="sm" kind="ghost" label="More" />} items={[
                        { label: e.hidden ? "Show" : "Hide", onPress: () => void apply(setHidden(list as never, key(e), !e.hidden) as Entry[]) },
                        ...[...REGIONS, ...Array.from(new Set(list.map((x) => x.group).filter((g): g is string => Boolean(g) && !REGIONS.includes(g as never))))].map((g) => ({ label: `Move to ${groupLabel(g, g)}`, selected: e.group === g, onPress: () => void apply(setGroup(list as never, key(e), g) as Entry[]) })),
                        { label: "Move to a new group", onPress: () => { setNaming(key(e)); setGroupName(""); } },
                        ...(e.kind !== "place" ? [{ label: "Remove", danger: true, onPress: () => void apply(remove(list as never, key(e)) as Entry[]) }] : []),
                      ]} />
                    </View>
                  } />
              </Draggable>
              {naming === key(e) ? (
                <View className="gap-s2 px-s4 pb-s3">
                  <Field label="Group name" value={groupName} onChangeText={setGroupName} placeholder="Work" />
                  <View className="flex-row gap-s2">
                    <Button label="Move" disabled={!groupName.trim() || busy} onPress={() => { const n = groupName.trim(); setNaming(null); void apply(setGroup(list as never, key(e), n) as Entry[]); }} />
                    <Button kind="ghost" label="Cancel" onPress={() => setNaming(null)} />
                  </View>
                </View>
              ) : null}
            </View>
          ))}
        </Card>
      </Sec>
      {addable.length ? (
        <Sec title="Add">
          <Card flush>
            {addable.map((a, i) => (
              <View key={key(a.entry)}>{i ? <Divider inset={16} /> : null}<Row dense title={a.label} end={<Button size="sm" label="Add" disabled={busy} onPress={() => void apply(add(list as never, a.entry as never, {}) as Entry[])} />} /></View>
            ))}
          </Card>
        </Sec>
      ) : null}
      {scope === "me" && mine.length ? <View className="flex-row"><Button kind="ghost" label="Back to the team's order" disabled={busy} onPress={async () => { setBusy(true); try { await tool("settings.reset", { key: "sidebar.mine", level: "account" }); await load(space); } catch (e) { setError(said(e)); } finally { setBusy(false); } }} /></View> : null}
    </Frame>
  );
}
