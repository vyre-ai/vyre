import { useCallback, useState } from "react";
import { PinToSidebar } from "../shell/PinToSidebar";
import { tableFromRecords } from "../../ui/views/records-table.js";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { BlockScreen, BoardView, Button, CalendarView, Card, DashboardView, EmptyState, Icon, Menu, ErrorState, LargeTitleScreen, LoadingState, Segmented, Select, Tabs, Text, filterWords, showToast, storedViewsOf, useFieldEnv, useRecordsWorld, useStore, useUiTheme, viewDefOf, viewRows, viewsOf } from "@vyre/ui";

type ViewKind = "list" | "board" | "calendar" | "dashboard";
/** More types than this are a picker, not tabs. */
const TABS_MAX = 5;
const LABEL: Record<ViewKind, string> = { list: "List", board: "Board", calendar: "Calendar", dashboard: "Dashboard" };

/**
 * The `records` block (design language, data source: records): every record of one type, as a list, a board, a calendar or a dashboard, drawn from the type's definition. Nothing here knows Contact
 * or Matter. Its sorting, filters and stored views are the type's own (ListView, BoardView, CalendarView and DashboardView), so a screen that holds this block behaves as the records page always did.
 * With `page` the block draws the page's large title and scroll as well, because on /u/records it is the whole screen.
 */
export function RecordsBlock({ b }: { k: string; b: { props?: Record<string, any>; data?: { records?: { type: string; view?: string } } } }) {
  const type = String(b.data?.records?.type ?? "");
  const openedView = b.data?.records?.view;
  const router = useRouter();
  const store = useStore();
  const { data: world, loading, error, reload } = useRecordsWorld();
  const { phone } = useUiTheme();
  const [view, setView] = useState<ViewKind>("list");
  // A named view picked from the title menu, and whether this visit has cleared its filter (the view itself is not edited).
  const [viewName, setViewName] = useState<string | undefined>(openedView);
  const [cleared, setCleared] = useState(false);
  const open = useCallback((urn: string) => router.push(`/u/record/${urn.split("/").pop()}` as never), [router]);
  const env = useFieldEnv(world, open);
  if (error && !world) return <ErrorState title="Records did not load" reason={error.message} retry={reload} />;
  const page = Boolean(b.props?.page);
  const frame = (title: string, children: React.ReactNode, more: { own?: boolean; onRefresh?: () => void } = {}) => (page ? <LargeTitleScreen title={title} {...more}>{children}</LargeTitleScreen> : <View className="gap-s3">{children}</View>);
  if (loading && !world) return frame("Records", <LoadingState rows={5} />);
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
  // The list is a table block with typed cells (the values cross into it through tableFromRecords, which stops a sealed value): the same sorting, filters and rows as the list view had.
  const listScreen = { v: 2 as const, id: "records-list", layout: { block: "t" }, blocks: { t: { type: "table", ...tableFromRecords(def, rows, { view: viewName, noFilter: cleared, env: { actors: world.actors, links: env.links } }) } } };
  return (
    frame(vd.plural, <>
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
        <PinToSidebar id={`records-${type}${viewName ? `-${viewName}` : ""}`} label={viewName ? (named.find((n) => n.name === viewName)?.label ?? vd.plural) : vd.plural} href={`/u/records/${type}${viewName ? `?view=${encodeURIComponent(viewName)}` : ""}`} />
        <Button kind="ghost" size={phone ? "md" : "sm"} icon="alarm" label="Reminders" onPress={() => router.push("/u/records/reminder" as never)} />
        <Button kind="ghost" size={phone ? "md" : "sm"} icon="edit" label="Notes" onPress={() => router.push("/u/records/note" as never)} />
      </View>
      {/* A handful of types read as tabs; more than that would run off the edge and cut a name, so they are one picker. */}
      {world.types.length > TABS_MAX
        ? <Select label="Type" value={type} options={world.types.map((t) => [t.name, viewDefOf(t).plural] as [string, string])} onChange={(t) => router.replace(`/u/records/${t}` as never)} />
        : <Tabs value={type} onChange={(t) => router.replace(`/u/records/${t}` as never)} items={world.types.map((t) => [t.name, viewDefOf(t).plural] as [string, string])} />}
      {filter && !cleared ? (
        <Card>
          <View className="flex-row items-center gap-s3 px-s4 py-s3">
            <View className="min-w-0 flex-1"><Text tone="label">{`Filtered: ${filterWords(def, filter)}, ${narrowed} of ${rows.length}`}</Text></View>
            <Button kind="ghost" size={phone ? "md" : "sm"} label="Clear" onPress={() => setCleared(true)} />
          </View>
        </Card>
      ) : null}
      {shown === "list" ? <BlockScreen screen={listScreen} handlers={{ open: (_k, r) => openRec(r), openLink: open, slot: () => switcher }} /> : switcher}
      {shown === "board" ? <BoardView def={def} rows={rows} env={env} onOpen={openRec} onMove={move} view={viewName} noFilter={cleared} /> : null}
      {shown === "dashboard" ? <DashboardView def={def} rows={rows} onOpen={openRec} now={env.now} /> : null}
      {shown === "calendar" ? <CalendarView def={def} rows={rows} env={env} onOpen={openRec} view={viewName} noFilter={cleared} /> : null}
    </>, { own: true, onRefresh: reload })
  );
}
