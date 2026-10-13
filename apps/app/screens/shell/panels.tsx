// What the sidebar becomes inside a place (SidebarStack): the data for each panel. Wiring only: the look is the library's (SidebarPanel, SidebarRow).
import { useEffect } from "react";
import { create } from "zustand";
import { Platform, useWindowDimensions } from "react-native";
import { useRouter, usePathname, useGlobalSearchParams } from "expo-router";
import { Avatar, PinnedViews, SidebarRow, reorderPinned, renameView, unpinList, backTo, panelFor, useWork, type PanelDef, type PanelItem } from "@vyre/ui";
import { recordTitle } from "../../ui/tasks/model";
import { useChats } from "../../src/state/chats";
import { chatsOrdered, chatsShown } from "../chats/chats-model.js";
import { effective, saveList, useSidebar } from "./sidebar";
import { useSpaces } from "./state";
import { useNewView } from "../records/NewViewHost";
import { MOCK, tool } from "../../src/real/box";
import { useFlowsState } from "../flows/store";
import { flowsRepo } from "../flows/data";
import { BUILD_SECTIONS } from "../build/sections.js";
import { FilesTreePanel } from "../drive/FilesTreePanel";
import { VaultPanel } from "../vault/VaultPanel";
import { VAULT_PANEL_MIN } from "../vault/vault-nav";
import { SETTINGS_ITEMS } from "./settings-items.js";

/** What each panel has loaded: a loader component (below) mounts only while its panel shows, so a list is read only when it is wanted. */
const useLoaded = create<{ items: Record<string, PanelItem[]>; put: (id: string, items: PanelItem[]) => void }>((set) => ({
  items: {},
  put: (id, items) => set((s) => ({ items: { ...s.items, [id]: items } })),
}));

function ProjectsLoader() {
  const q = useWork();
  const put = useLoaded((s) => s.put);
  useEffect(() => {
    if (!q.data) return;
    const { world, items } = q.data;
    put("projects", items.map((i: any) => ({ id: i.row.id, label: recordTitle(world, i.row), href: `/u/project/${i.row.id}`, group: i.def.label, lead: <Avatar of={{ kind: "project", id: i.row.id, name: recordTitle(world, i.row), seed: i.row.data?.avatar_seed }} size={24} /> })));
  }, [q.data, put]);
  return null;
}

function ChatsLoader() {
  const chats = useChats();
  const put = useLoaded((s) => s.put);
  useEffect(() => {
    put("chats", chatsOrdered(chatsShown(chats.rows)).filter((c: any) => c.open !== false).map((c: any) => ({ id: c.id, label: c.title, href: `/u/chats/${c.id}` })));
  }, [chats.rows, put]);
  return null;
}

function FlowsLoader() {
  const put = useLoaded((s) => s.put);
  // The sample build lists the same Flows as the Flows page (the ones made in the builder and the Kit's), in the same groups; a real box lists flows.list, whose rows carry the Flow's group.
  const { made, applied, groupOf } = useFlowsState();
  useEffect(() => {
    if (!MOCK) return;
    const kit = [...(applied ? [flowsRepo.engineerFlow()] : []), ...flowsRepo.flows()];
    put("flows", [...made.map((m) => ({ id: m.id, label: m.draft.name, group: groupOf[m.id] })), ...kit.map((f) => ({ id: f.id, label: f.name, group: groupOf[f.id] }))].map((f) => ({ ...f, href: `/u/flows/${f.id}` })));
  }, [made, applied, groupOf, put]);
  useEffect(() => {
    if (MOCK) return;
    let live = true;
    tool<any[]>("flows.list", {}).then((rows) => { if (live && Array.isArray(rows)) put("flows", rows.map((f) => ({ id: String(f.id), label: String(f.label || f.name || f.id), href: `/u/flows/${f.id}`, ...(f.group ? { group: String(f.group) } : {}) }))); }, () => {});
    return () => { live = false; };
  }, [put]);
  return null;
}

/** Build: Playbooks, Objects and Kits, one footer place instead of a section of three. Drilled into like Settings; the old routes are these sections' own. */
const BUILD: PanelItem[] = BUILD_SECTIONS.map(([id, label, icon, href]) => ({ id, label, href, icon: icon as PanelItem["icon"] }));

/** The sections of Settings: what the owner moved under it (sidebar-ia). */
const SETTINGS = SETTINGS_ITEMS as unknown as PanelItem[];

const META: Record<string, { title: string; icon: PanelDef["icon"]; search?: string; empty: string }> = {
  projects: { title: "Projects", icon: "projects", search: "Search projects", empty: "No projects yet." },
  chats: { title: "Chat", icon: "chat", search: "Search chats", empty: "No chats yet." },
  records: { title: "Records", icon: "records", empty: "" },
  flows: { title: "Flows", icon: "flows", search: "Search flows", empty: "No flows yet." },
  settings: { title: "Settings", icon: "settings", search: "Search settings", empty: "" },
  build: { title: "Build", icon: "kits", empty: "" },
  drive: { title: "Files", icon: "drive", empty: "" },
  vault: { title: "Vault", icon: "vault", empty: "" },
};

/** The component that loads the active panel's list. Mount it once in the shell. */
export function PanelLoader({ id }: { id: string | null }) {
  return id === "projects" ? <ProjectsLoader /> : id === "chats" ? <ChatsLoader /> : id === "flows" ? <FlowsLoader /> : null;
}

/** The panel the path opens, or null (the main sidebar): a place with no list built yet stays on the main sidebar. */
export function usePanel(onNavigate: (href: string) => void): { panel: PanelDef | null; id: string | null } {
  const path = usePathname();
  const params = useGlobalSearchParams();
  const router = useRouter();
  const { base, mine, load } = useSidebar();
  const space = useSpaces((s) => s.space);
  const loaded = useLoaded((s) => s.items);
  const search = new URLSearchParams(Object.entries(params).filter(([k, v]) => k !== "id" && k !== "type" && typeof v === "string") as [string, string][]).toString();
  const { width } = useWindowDimensions();
  const id = panelFor(path, search);
  // Files' tree and the Vault's groups are the web's wide screens' panels; a phone keeps each screen's own list.
  const meta = id && !((id === "drive" || id === "vault") && (width < VAULT_PANEL_MIN || Platform.OS !== "web")) ? META[id] : undefined;
  if (!id || !meta) return { panel: null, id: null };
  const goBack = () => { const to = backTo(path, search); if (to) router.push(to as never); };
  const all = effective(base, mine) as any[];
  const edit = async (list: any[]) => { await saveList("me", space, list); await load(space); };
  const views = id === "records" ? (effective(base, mine) as any[]).filter((e) => e.kind === "view" && !e.hidden && String(e.href).startsWith("/u/records/")) : [];
  return {
    id,
    panel: {
      id, title: meta.title, icon: meta.icon, search: meta.search, empty: meta.empty, onBack: goBack, currentHref: path,
      items: id === "settings" ? SETTINGS : id === "build" ? BUILD : id === "records" ? [] : loaded[id] ?? [],
      before: id === "drive" ? <FilesTreePanel /> : id === "vault" ? <VaultPanel /> : id === "records" ? <><SidebarRow label="Contacts" icon="contacts" on={path === "/u/records/contact"} onPress={() => onNavigate("/u/records/contact")} />
        <PinnedViews entries={all} onOpen={onNavigate}
          onMove={(i, before) => void edit(reorderPinned(all, i, before))} onRename={(i, label) => void edit(renameView(all, i, label))} onUnpin={(i) => void edit(unpinList(all, i))} /></> : undefined,
      after: id === "records" ? <><SidebarRow label="All objects" icon="records" tone="label" onPress={() => onNavigate("/u/settings/customize")} /><SidebarRow label="New view" icon="plus" tone="label" onPress={() => useNewView.getState().set(true)} /></> : undefined,
    },
  };
}
