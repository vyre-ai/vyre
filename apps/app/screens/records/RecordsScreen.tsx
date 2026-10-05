import { useCallback, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { BoardView, CalendarView, DashboardView, EmptyState, ErrorState, LargeTitleScreen, ListView, LoadingState, Segmented, Tabs, Text, showToast, useFieldEnv, useRecordsWorld, useStore, useUiTheme, viewDefOf, viewsOf } from "@vyre/ui";

type ViewKind = "list" | "board" | "calendar" | "dashboard";
const LABEL: Record<ViewKind, string> = { list: "List", board: "Board", calendar: "Calendar", dashboard: "Dashboard" };

/** /u/records/<type>: every record of one type, as a list, a board or a calendar, drawn from the type's definition. Nothing here knows Contact or Matter. */
export function RecordsScreen({ type }: { type: string }) {
  const router = useRouter();
  const store = useStore();
  const { data: world, loading, error, reload } = useRecordsWorld();
  const { phone } = useUiTheme();
  const [view, setView] = useState<ViewKind>("list");
  const open = useCallback((urn: string) => router.push(`/u/record/${urn.split("/").pop()}` as never), [router]);
  const env = useFieldEnv(world, open);
  if (error && !world) return <ErrorState title="Records did not load" reason={error.message} retry={reload} />;
  if (loading && !world) return <LargeTitleScreen title="Records"><LoadingState rows={5} /></LargeTitleScreen>;
  const def = world?.types.find((t) => t.name === type);
  if (!world || !def) return <EmptyState title="No such record type" body={`This space has no type called "${type}".`} action={{ label: "Go to Contacts", onPress: () => router.replace("/u/records/contact" as never) }} />;
  const vd = viewDefOf(def);
  const views = viewsOf(def, vd) as ViewKind[];
  const shown: ViewKind = views.includes(view) ? view : "list";
  const rows = world.byType[def.name] || [];
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
          <Text size="page" strong>{vd.plural}</Text>
          <Text size="caption" tone="label">{rows.length} {rows.length === 1 ? def.label.toLowerCase() : vd.plural.toLowerCase()}</Text>
        </View>
      </View>
      <Tabs value={type} onChange={(t) => router.replace(`/u/records/${t}` as never)} items={world.types.map((t) => [t.name, viewDefOf(t).plural] as [string, string])} />
      {shown === "list" ? <ListView def={def} rows={rows} env={env} onOpen={openRec} lead={switcher} /> : switcher}
      {shown === "board" ? <BoardView def={def} rows={rows} env={env} onOpen={openRec} onMove={move} /> : null}
      {shown === "dashboard" ? <DashboardView def={def} rows={rows} onOpen={openRec} now={env.now} /> : null}
      {shown === "calendar" ? <CalendarView def={def} rows={rows} env={env} onOpen={openRec} /> : null}
    </LargeTitleScreen>
  );
}
