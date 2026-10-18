import { openFind } from "../find/FindHost";
import { useCallback, useEffect, useRef, useState } from "react";
import { ViewControls } from "./ViewControls";
import { callT } from "../../src/real/call-tool";
import { RecordScreen } from "./RecordScreen";
import { needsIdFill, defineInputOf } from "./records-screen.js";
import { useMoveStage } from "./MoveStage";
import { useTypeLayout } from "./layout-state";
import { LayoutControls } from "./LayoutControls";
import { TableControls } from "./TableControls";
import { useRoleChips } from "./useRoleChips";
import { useTablePrefs } from "../../src/state/record-prefs";
import { FirstVisit } from "./FirstVisit";
import { isDayOne, sampleCount } from "./first-visit.js";
import { isStageGroup } from "./move-rule.js";
import { taskDrop } from "./task-drop.js";
import { MyTasks } from "./MyTasks";
import { BusyBlocks } from "./BusyBlocks";
import { AddColumn } from "./AddColumn";
import { BoardWithStats } from "./BoardWithStats";
import { defaultScope, filterByScope, scopeFilter, scopesFor } from "./scope-views.js";
import { NewViewSheet } from "./NewViewSheet";
import { ImportSheet } from "./ImportSheet";
import { AddTypeSheet } from "../customize/AddTypeSheet";
import { useKernelTypes } from "../customize/kernel-types";
import { TypeFields } from "../customize/TypeScreen";
import { TypeAccess } from "../customize/TypeAccess";
import { TypeHistory } from "../customize/TypeHistory";
import { useEffectiveList } from "./views-actions";
import { useSidebar } from "../shell/sidebar";
import { useSpaces } from "../shell/state";
import { tableFromRecords } from "../../ui/views/records-table.js";
import { Platform, Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { allowsMock, BlockScreen, BoardView, GalleryView, SidePanel, ListHeader, chipsToFilters, listRows, Button, CalendarView, tableToCsv, Card, Chip, DashboardView, EmptyState, Icon, IconButton, Menu, ErrorState, LargeTitleScreen, LoadingState, Segmented, Tabs, Text, filterWords, showToast, storedViewsOf, useFieldEnv, useRecordsWorld, useStore, useUiTheme, viewDefOf, viewRows, viewsOf, MINE, personalViewsOf, withPersonalViews } from "@vyre/ui";
import { usePlaceText } from "../../src/real/PlaceTag";
import { tagFor, spaceOfUrn } from "../../src/real/place-tag.js";
import { useMembers } from "../spaces/state";

type ViewKind = "list" | "gallery" | "board" | "calendar" | "dashboard";
/** More types than this are a picker, not tabs. */
/** A tab says its type and how many records it holds ("People 14"); no count when the list is cut to a scope, because the number would not be the type's. */
const tabLabel = (plural: string, n: number | undefined) => (n === undefined ? plural : `${plural} ${n}`);
const LABEL: Record<ViewKind, string> = { list: "List", gallery: "Gallery", board: "Board", calendar: "Calendar", dashboard: "Dashboard" };

/**
 * The `records` block (design language, data source: records): every record of one type, as a list, a board, a calendar or a dashboard, drawn from the type's definition. Nothing here knows Contact
 * or Matter. Its sorting, filters and stored views are the type's own (the table block for the list; BoardView, CalendarView and DashboardView), so a screen that holds this block behaves as the records page always did.
 * With `page` the block draws the page's large title and scroll as well, because on /u/records it is the whole screen.
 */
export function RecordsBlock({ b }: { k: string; b: { props?: Record<string, any>; data?: { records?: { type: string; view?: string } } } }) {
  const type = String(b.data?.records?.type ?? "");
  const openedView = b.data?.records?.view;
  const router = useRouter();
  const store = useStore();
  // The scope tab (Mine, Team, Space...) is cut on the box, so a long list is right once it pages; filterByScope below stays as the answer for a box that ignores the filter.
  const [scopePicked, setScopePicked] = useState("");
  const scopes = scopesFor(type);
  const scope = scopes.some(([k]) => k === scopePicked) ? scopePicked : defaultScope(type);
  const sf = scopeFilter(scope);
  const { data: world, loading, error, reload } = useRecordsWorld(sf ? { [type]: sf } : undefined);
  const { phone } = useUiTheme();
  const roleChips = useRoleChips(type, String((world?.byType?.[type] ?? []).length));
  // A named view picked from the title menu, and whether this visit has cleared its filter (the view itself is not edited).
  const [viewName, setViewName] = useState<string | undefined>(openedView);
  const [cleared, setCleared] = useState(false);
  const [panelId, setPanelId] = useState<string | null>(null);
  // A layout the person picked in the switcher; until then the named view's own layout stands.
  const [picked, setPicked] = useState<ViewKind | null>(null);
  const [making, setMaking] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const prefs = useTablePrefs();
  const [addingType, setAddingType] = useState(false);
  const [pane, setPane] = useState("records");
  useEffect(() => setPane("records"), [type]);
  const createType = useKernelTypes((k) => k.create);
  const settingUp = Object.keys(useKernelTypes((k) => k.busy)).length;
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<any[]>([]);
  const [preset, setPreset] = useState<{ filters: any[] } | undefined>(undefined);
  const space = useSpaces((s) => s.space);
  const canShare = useSidebar((s) => s.canSetDefault);
  const entries = useEffectiveList();
  // The pins (sidebar links) open this screen with a view in the address: follow it.
  useEffect(() => { setViewName(openedView); setScopePicked(""); setPicked(null); setCleared(false); setQuery(""); setChips([]); }, [openedView, type]);
  const open = useCallback((urn: string) => router.push(`/u/record/${urn.split("/").pop()}` as never), [router]);
  const env = useFieldEnv(world, open);
  const mv = useMoveStage(env, reload);
  const lay = useTypeLayout(type);
  const cards = useMembers((st) => st.spaces);
  const showing = useSpaces((st) => st.space);
  usePlaceText("showing");   // loads the spaces the row tags are read from
  // Older records without their ID (a type that gained the field): an owner or admin opening the type asks for its own definition again, unchanged, which gives them their IDs (core/records-tools); once for a type in a visit
  const idAsked = useRef(new Set<string>());
  useEffect(() => {
    if (!world || idAsked.current.has(type)) return;
    const def = world.types.find((t) => t.name === type);
    if (!needsIdFill({ def, rows: world.byType[type] || [], canDefine: canShare })) return;
    idAsked.current.add(type);
    // The definition is read fresh just before it is replayed, never taken from this page's copy: another admin may have changed the type since the page loaded.
    const warn = (why: string) => console.warn(`records: the IDs of ${type} were not filled in (${why})`);   // nothing is shown to the person: the next visit asks again
    void Promise.resolve(store.types(!allowsMock() && space !== "all" ? space : undefined))
      .then((list: any[]) => { const now = list.find((t) => t.name === type); if (!needsIdFill({ def: now, rows: world.byType[type] || [], canDefine: canShare })) return undefined; return callT("records.define", { diff: { change_types: [defineInputOf(now)] } }); })
      .then((r) => { if (!r) return; if (r.error) warn(`${r.error.code}: ${r.error.message}`); else reload(); })
      .catch((e) => warn(e instanceof Error ? e.message : String(e)));
  }, [world, type, canShare, reload, space, store]);
  // A new type finishes setting up in the background: when the last one is done, the tabs read it in.
  const wasSettingUp = useRef(0);
  useEffect(() => { if (wasSettingUp.current > 0 && settingUp === 0) reload(); wasSettingUp.current = settingUp; }, [settingUp, reload]);
  if (error && !world) return <ErrorState title="Records did not load" reason={error.message} retry={reload} />;
  const page = Boolean(b.props?.page);
  const frame = (title: string, children: React.ReactNode, more: { own?: boolean; onRefresh?: () => void } = {}) => (page ? <LargeTitleScreen title={title} {...more}>{children}</LargeTitleScreen> : <View className="gap-s3">{children}</View>);
  if (loading && !world) return frame("Records", <LoadingState rows={5} />);
  const def = world?.types.find((t) => t.name === type);
  if (!world || !def) return <EmptyState title="No such object" body={`This space has no object called "${type}".`} action={{ label: "Go to Contacts", onPress: () => router.replace("/u/records/contact" as never) }} />;
  // The person's own views of this type are laid over the type's own; they decide how the screen is drawn only when one of them is open, so they never change what the type opens as.
  const mineViews = personalViewsOf(type, entries);
  const full = withPersonalViews(def, mineViews);
  const drawn = viewName?.startsWith(MINE) ? full : def;
  const vd = viewDefOf(drawn, undefined, viewName);
  const named = (["list", "board", "calendar"] as ViewKind[]).flatMap((k) => storedViewsOf(full, k));
  const views = viewsOf(drawn, vd) as ViewKind[];
  const own = (full.views ?? []).find((v: any) => v.name === viewName)?.type as ViewKind | undefined;
  const shown: ViewKind = picked && views.includes(picked) ? picked : own && views.includes(own) ? own : (vd as any).open && views.includes((vd as any).open) ? (vd as any).open : "list";
  const tabTypes = world.types.filter((t: any) => !t.hidden_in_records || t.name === type);
  const everyone = world.byType[def.name] || [];
  const all = scopes.length ? filterByScope(everyone, scope, (world as any).me) : everyone;
  const lctx = { tags: env.tags, me: (world as any).me, actors: world.actors as any[], links: env.links, now: env.now };
  const rows = listRows(def, all, chips, query, lctx);
  const filter = (vd as any)[shown]?.filter as string | undefined;
  const narrowed = filter && !cleared ? viewRows(rows, filter).length : rows.length;
  const move = async (rec: any, to: string) => {
    const g = vd.board?.groupBy;
    if (!g) return;
    // A stage board moves by the one rule: a stage that needs fields asks for them first (MoveStage); any other group is a plain change.
    if (to && isStageGroup(def, g)) { await mv.go(rec, def, to); return; }
    // A task's status is the kernel's: a drop goes through tasks.move, or says why it cannot.
    if (def.name === "task" && g === "status") {
      const d: any = taskDrop(String(rec.data?.status ?? ""), to);
      if (d.say) showToast(d.say);
      else if (d.call) { const r = await callT("tasks.move", { id: rec.id, ...d.call }); if (r.error) showToast(r.error.message || "That did not move."); else reload(); }
      return;
    }
    try { await store.update(rec.urn, { [g]: to || null } as any, rec.version); } catch (e) { showToast(e instanceof Error ? e.message : String(e)); }
  };
  // One scope-style control, with icons only on a phone.
  const switcher = views.length > 1 ? <Segmented<ViewKind> label="View" value={shown} onChange={setPicked} iconsOnly={phone} icons={{ list: "list", gallery: "grid", board: "board", calendar: "cal", dashboard: "chart" }} options={views.map((v) => [v, LABEL[v]] as [ViewKind, string])} /> : null;
  // a record opens in a panel that slides in over the view (the list stays where it was); its own page is still /u/record/<id>
  const openRec = (rec: any) => (page ? setPanelId(String(rec.id)) : router.push(`/u/record/${rec.id}` as never));
  // The list is a table block with typed cells (the values cross into it through tableFromRecords, which stops a sealed value): the same sorting, filters and rows as the list view had.
  const table = tableFromRecords(drawn, rows, { roles: roleChips, view: viewName, noFilter: cleared, layout: lay.layout, env: { actors: world.actors, links: env.links } });
  // each row says where it lives (placeTag): the space its address names, else the space showing
  const tagged = { ...table, content: { ...table.content, rows: table.content.rows.map((r: any) => ({ ...r, tag: tagFor(cards, spaceOfUrn(r.urn) || showing, showing) })) } };
  // Export CSV: the table content above is what the list draws (the view's rows, filters and search, a sealed value already stopped), so the file holds nothing the person cannot see.
  const exportCsv = () => {
    if (typeof document === "undefined") return;
    const url = URL.createObjectURL(new Blob(["\uFEFF" + tableToCsv(table.content as any)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${vd.plural.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    showToast(`${table.content.rows.length} ${vd.plural.toLowerCase()} exported.`);
  };
  const tableColumns = (table.content.columns as any[]).filter((c) => c.id !== "_title" && c.id !== "_roles" && c.role !== "sortOnly" && c.role !== "endDate").map((c) => String(c.id));
  const addColumn = (compact: boolean) => <AddColumn compact={compact} type={type} types={world.types.map((t: any) => ({ name: t.name, label: String(t.label ?? t.name) }))} onAdded={(n) => { reload(); if (n) void lay.save("columns", [...tableColumns, n]); }} />;
  const listScreen = { v: 2 as const, id: "records-list", layout: { block: "t" }, blocks: { t: { type: "table", ...tagged } } };
  return (
    <View className="min-h-0 flex-1">
    {frame(vd.plural, <>
      <ListHeader askBar onSearch={() => openFind("records")} noun={vd.plural.toLowerCase()} shown={rows.length} total={all.length} query={query} onQuery={setQuery} chips={chips} onChips={setChips} def={def} ctx={lctx} onImport={() => setImporting(true)} onExport={Platform.OS === "web" ? exportCsv : undefined}
        title={<>
          {named.length > 1 ? (
            <Menu trigger={<Pressable accessibilityRole="button" accessibilityLabel={`${vd.plural}, choose a view`} className="flex-row items-center gap-s1 self-start"><Text size="page" strong>{viewName ? (named.find((n) => n.name === viewName)?.label ?? vd.plural) : `All ${vd.plural.toLowerCase()}`}</Text><Icon name="chevron-down" size={16} tone="label" /></Pressable>}
              items={[{ label: `All ${vd.plural.toLowerCase()}`, selected: !viewName, onPress: () => { setViewName(undefined); setPicked(null); setCleared(false); } }, ...named.map((n) => ({ label: n.label, selected: viewName === n.name, onPress: () => { setViewName(n.name); setPicked(null); setCleared(false); } }))]} />
          ) : <Text size="page" strong>{vd.plural}</Text>}
        </>}
        onSave={() => { const r = chipsToFilters(chips, def); setPreset({ filters: r.filters }); setMaking(true); }}
        saveNote={chipsToFilters(chips, def).skipped ? `${chipsToFilters(chips, def).skipped} of these filters cannot be kept by a saved view yet and are left out.` : undefined} />
      {/* The views of the type as a row of chips, a person's own marked with a lock (the approved design); the title menu above is the same list. */}
      {named.length ? (
        <View className="flex-row flex-wrap items-center gap-s2">
          <Text size="caption" tone="label">Views</Text>
          <Chip selected={!viewName} onPress={() => { setViewName(undefined); setPicked(null); setCleared(false); }}>{`All ${vd.plural.toLowerCase()}`}</Chip>
          {named.map((n) => <Chip key={n.name} selected={viewName === n.name} icon={n.name.startsWith(MINE) ? "lock" : undefined} onPress={() => { setViewName(n.name); setPicked(null); setCleared(false); }}>{n.label}</Chip>)}
        </View>
      ) : null}
      {/* Reminders and Notes are Records types (the app map): the same list, board and calendar as any other. */}
      <View className="flex-row gap-s2">
        <Button kind="primary" size={phone ? "md" : "sm"} icon="plus" label={`New ${def.label.toLowerCase()}`} onPress={() => router.push(`/u/record/new?type=${type}` as never)} />
        {phone ? (
          <>
            <ViewControls compact type={type} viewName={viewName} label={viewName ? (named.find((n) => n.name === viewName)?.label ?? vd.plural) : vd.plural} personal={!!viewName?.startsWith(MINE)} space={space} size="md" />
            <Menu trigger={<IconButton icon="more" label="More" />} items={[
              { label: "New view", onPress: () => setMaking(true) },
              { label: "New type", onPress: () => setAddingType(true) },
              { label: "Reminders", onPress: () => router.push("/u/records/reminder" as never) },
              { label: "Notes", onPress: () => router.push("/u/records/note" as never) },
            ]} />
          </>
        ) : (
          <>
        <Button kind="secondary" size={phone ? "md" : "sm"} icon="plus" label="New view" onPress={() => setMaking(true)} />
        {shown === "list" ? addColumn(false) : null}
        <LayoutControls fields={def.fields.filter((f: any) => f.kind !== "sealed").map((f: any) => ({ name: f.name, label: String(f.label ?? f.name) }))} columns={tableColumns} scope={lay.scope} onScope={lay.setScope} mine={lay.mine} onColumns={(c) => void lay.save("columns", c)} onReset={() => void lay.reset()} sheetOpen={colsOpen} onSheet={setColsOpen} />
        <ViewControls type={type} viewName={viewName} label={viewName ? (named.find((n) => n.name === viewName)?.label ?? vd.plural) : vd.plural} personal={!!viewName?.startsWith(MINE)} space={space} size={phone ? "md" : "sm"} />
        <Button kind="ghost" size={phone ? "md" : "sm"} icon="alarm" label="Reminders" onPress={() => router.push("/u/records/reminder" as never)} />
        <Button kind="ghost" size={phone ? "md" : "sm"} icon="edit" label="Notes" onPress={() => router.push("/u/records/note" as never)} />
          </>
        )}
      </View>
      <FirstVisit show={isDayOne(world)} samples={sampleCount(world)} reload={reload} />
      {/* Every type is a tab with its count, in a strip that scrolls sideways (the approved Records design). A type the Space keeps out of Records (Files, Templates, Playbooks) is not a tab; a "+" at the end makes a new one. */}
      <View className="flex-row items-center gap-s2">
        <View className="min-w-0 flex-1">
          <Tabs value={type} onChange={(t) => router.replace(`/u/records/${t}` as never)} items={tabTypes.map((t) => [t.name, tabLabel(viewDefOf(t).plural, t.name === type && sf ? undefined : (world.byType[t.name] || []).length)] as [string, string])} />
        </View>
        <IconButton icon="plus" label="New type" onPress={() => setAddingType(true)} />
      </View>
      {/* The type's own tabs, as on a Flow: its records, its fields, who may do what with it, and what changed. */}
      <Tabs value={pane} onChange={setPane} items={[["records", vd.plural], ["fields", "Fields"], ["access", "Access"], ["history", "History"]]} />
      {pane === "fields" ? <TypeFields type={type} /> : pane === "access" ? <TypeAccess type={type} label={vd.plural} /> : pane === "history" ? <TypeHistory type={type} /> : <>
      {filter && !cleared ? (
        <Card>
          <View className="flex-row items-center gap-s3 px-s4 py-s3">
            <View className="min-w-0 flex-1"><Text tone="label">{`Filtered: ${filterWords(def, filter)}, ${narrowed} of ${rows.length}`}</Text></View>
            <Button kind="ghost" size={phone ? "md" : "sm"} label="Clear" onPress={() => setCleared(true)} />
          </View>
        </Card>
      ) : null}
      {scopes.length ? <Segmented<string> label="Show" value={scope} onChange={setScopePicked} options={scopes} /> : null}
      {def.name === "event" ? <BusyBlocks /> : null}
      {def.name === "task" ? <MyTasks onOpen={(id) => router.push(`/u/record/${id}` as never)} /> : null}
      {shown === "list" && !phone ? (
        <TableControls columns={tableColumns.length + 1} onColumns={() => setColsOpen(true)}
          fields={def.fields.filter((f: any) => ["choice", "stage", "link", "actor", "boolean"].includes(f.kind) && tableColumns.includes(f.name)).map((f: any) => ({ name: f.name, label: String(f.label ?? f.name) }))}
          groupBy={lay.layout?.group_by} onGroup={(n) => void lay.save("group_by", n)}
          density={prefs.density} onDensity={prefs.setDensity} freeze={prefs.freezeFirst} onFreeze={prefs.setFreezeFirst} scope={lay.scope} mine={lay.mine} />
      ) : null}
      {shown === "list" ? <BlockScreen screen={listScreen} handlers={{ open: (_k, r) => openRec(r), openLink: open, slot: (_k, name) => (name === "lead" ? switcher : name === "header-end" ? addColumn(true) : null) }} /> : switcher}
      {shown === "gallery" ? <GalleryView def={drawn} rows={rows} onOpen={openRec} view={viewName} noFilter={cleared} /> : null}
      {shown === "board" ? <BoardWithStats def={drawn} rows={rows} env={env} onOpen={openRec} onMove={move} view={viewName} noFilter={cleared} /> : null}
      {shown === "dashboard" ? <DashboardView def={def} rows={rows} onOpen={openRec} now={env.now} /> : null}
      {shown === "calendar" ? <CalendarView def={drawn} rows={rows} env={env} onOpen={openRec} view={viewName} noFilter={cleared} /> : null}
      </>}
      {mv.sheet}
      <AddTypeSheet open={addingType} onClose={() => setAddingType(false)} space={space} taken={world.types.map((t) => t.name)} onAdd={(t, plural) => { createType(t); showToast(`${plural} is being set up. This can take a minute.`); }} />
      <ImportSheet open={importing} onClose={() => setImporting(false)} def={def} noun={vd.plural.toLowerCase()} onDone={reload} />
      <NewViewSheet open={making} preset={preset} onClose={() => { setMaking(false); setPreset(undefined); }} types={world.types} type={type} space={space} canShare={canShare}
        onSaved={(name, t) => { if (t === type) { setViewName(name); setPicked(null); } else router.replace(`/u/records/${t}?view=${encodeURIComponent(name)}` as never); }} />
    </>, { own: true, onRefresh: reload })}
    {page ? <SidePanel open={panelId !== null} onClose={() => setPanelId(null)} title="Record">
      {panelId ? <RecordScreen id={panelId} onClose={() => setPanelId(null)} onOpen={(urn) => setPanelId(urn.split("/").pop() || null)} /> : null}
    </SidePanel> : null}
    </View>
  );
}
