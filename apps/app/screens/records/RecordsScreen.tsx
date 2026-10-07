import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { BoardView, Button, CalendarView, Card, DashboardView, EmptyState, Icon, Menu, ErrorState, LargeTitleScreen, ListView, LoadingState, Segmented, Select, Tabs, Text, filterWords, showToast, storedViewsOf, useFieldEnv, useRecordsWorld, useStore, useUiTheme, viewDefOf, viewRows, viewsOf } from "@vyre/ui";

type ViewKind = "list" | "board" | "calendar" | "dashboard";
/** More types than this are a picker, not tabs. */
const TABS_MAX = 5;
const LABEL: Record<ViewKind, string> = { list: "List", board: "Board", calendar: "Calendar", dashboard: "Dashboard" };

/** /u/records/<type>: every record of one type, as a list, a board or a calendar, drawn from the type's definition. Nothing here knows Contact or Matter. */
export function RecordsScreen({ type }: { type: string }) {
  const router = useRouter();
  const store = useStore();
  const { data: world, loading, error, reload } = useRecordsWorld();
  const { phone } = useUiTheme();
  const [view, setView] = useState<ViewKind>("list");
  // A named view picked from the title menu, and whether this visit has cleared its filter (the view itself is not edited).
  const [viewName, setViewName] = useState<string | undefined>(undefined);
  const [cleared, setCleared] = useState(false);
  const open = useCallback((urn: string) => router.push(`/u/record/${urn.split("/").pop()}` as never), [router]);
  const env = useFieldEnv(world, open);
  if (error && !world) return <ErrorState title="Records did not load" reason={error.message} retry={reload} />;
  if (loading && !world) return <LargeTitleScreen title="Records"><LoadingState rows={5} /></LargeTitleScreen>;
  const def = world?.types.find((t) => t.name === type);
  if (!world || !def) return <EmptyState title="No such record type" body={`This space has no type called "${type}".`} action={{ label: "Go to Contacts", onPress: () => router.replace("/u/records/contact" as never) }} />;
  const vd = viewDefOf(def, undefined, viewName);
  const named = (["list", "board", "calendar"] as ViewKind[]).flatMap((k) => storedViewsOf(def, k));
  const views = viewsOf(def, vd) as ViewKind[];
  const shown: ViewKind = views.includes(view) ? view : "list";
  const rows = world.byType[def.name] || [];
  const filter = (vd as any)[shown]?.filter as string | undefined;
  const narrowed = filter && !cleared ? viewRows(rows, filter).length : rows.length;
  const move = async (rec: any, to: string) => {
    const g = vd.board?.groupBy;
    if (!g) return;
    try { await store.update(rec.urn, { [g]: to || null } as any, rec.version); } catch (e) { showToast(e instanceof Error ? e.message : String(e)); }
  };
  // One scope-style control, with icons only on a phone.
  const switcher = views.length > 1 ? <Segmented<ViewKind> label="View" value={shown} onChange={setView} iconsOnly={phone} icons={{ list: "list", board: "board", calendar: "cal", dashboard: "chart" }} options={views.map((v) => [v, LABEL[v]] as [ViewKind, string])} /> : null;
  const openRec = (rec: any) => router.push(`/u/record/${rec.id}` as never);
  return (
    <LargeTitleScreen title={vd.plural} own onRefresh={reload}>
      <View className="flex-row items-center gap-s3">
        <View className="min-w-0 flex-1">
          {named.length > 1 ? (
            <Menu trigger={<Pressable accessibilityRole="button" accessibilityLabel={`${vd.plural}, choose a view`} className="flex-row items-center gap-s1 self-start"><Text size="page" strong>{viewName ? (named.find((n) => n.name === viewName)?.label ?? vd.plural) : `All ${vd.plural.toLowerCase()}`}</Text><Icon name="chevron-down" size={16} tone="label" /></Pressable>}
              items={[{ label: `All ${vd.plural.toLowerCase()}`, selected: !viewName, onPress: () => { setViewName(undefined); setCleared(false); } }, ...named.map((n) => ({ label: n.label, selected: viewName === n.name, onPress: () => { setViewName(n.name); setView(n.type as ViewKind); setCleared(false); } }))]} />
          ) : <Text size="page" strong>{vd.plural}</Text>}
          <Text size="caption" tone="label">{rows.length} {rows.length === 1 ? def.label.toLowerCase() : vd.plural.toLowerCase()}</Text>
        </View>
      </View>
      {/* Reminders and Notes are Records types (the app map): the same list, board and calendar as any other. */}
      <View className="flex-row gap-s2">
        <Button kind="ghost" size="sm" icon="alarm" label="Reminders" onPress={() => router.push("/u/records/reminder" as never)} />
        <Button kind="ghost" size="sm" icon="edit" label="Notes" onPress={() => router.push("/u/records/note" as never)} />
      </View>
      {/* A handful of types read as tabs; more than that would run off the edge and cut a name, so they are one picker. */}
      {world.types.length > TABS_MAX
        ? <Select label="Type" value={type} options={world.types.map((t) => [t.name, viewDefOf(t).plural] as [string, string])} onChange={(t) => router.replace(`/u/records/${t}` as never)} />
        : <Tabs value={type} onChange={(t) => router.replace(`/u/records/${t}` as never)} items={world.types.map((t) => [t.name, viewDefOf(t).plural] as [string, string])} />}
      {filter && !cleared ? (
        <Card>
          <View className="flex-row items-center gap-s3 px-s4 py-s3">
            <View className="min-w-0 flex-1"><Text tone="label">{`Filtered: ${filterWords(def, filter)}, ${narrowed} of ${rows.length}`}</Text></View>
            <Button kind="ghost" size="sm" label="Clear" onPress={() => setCleared(true)} />
          </View>
        </Card>
      ) : null}
      {shown === "list" ? <ListView def={def} rows={rows} env={env} onOpen={openRec} lead={switcher} view={viewName} noFilter={cleared} /> : switcher}
      {shown === "board" ? <BoardView def={def} rows={rows} env={env} onOpen={openRec} onMove={move} view={viewName} noFilter={cleared} /> : null}
      {shown === "dashboard" ? <DashboardView def={def} rows={rows} onOpen={openRec} now={env.now} /> : null}
      {shown === "calendar" ? <CalendarView def={def} rows={rows} env={env} onOpen={openRec} view={viewName} noFilter={cleared} /> : null}
    </LargeTitleScreen>
  );
}
