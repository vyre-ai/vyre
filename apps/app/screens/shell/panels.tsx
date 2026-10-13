// What the sidebar becomes inside a place (SidebarStack): the data for each panel. Wiring only: the look is the library's (SidebarPanel, SidebarRow).
import { useEffect } from "react";
import { create } from "zustand";
import { useRouter, usePathname, useGlobalSearchParams } from "expo-router";
import { Avatar, PinnedViews, SidebarRow, reorderPinned, renameView, unpinList, backTo, panelFor, useWork, type PanelDef, type PanelItem } from "@vyre/ui";
import { recordTitle } from "../../ui/tasks/model";
import { useChats } from "../../src/state/chats";
import { chatsOrdered, chatsShown } from "../chats/chats-model.js";
import { effective, saveList, useSidebar } from "./sidebar";
import { useSpaces } from "./state";
import { MOCK, tool } from "../../src/real/box";

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
  useEffect(() => {
    if (MOCK) return;
    let live = true;
    tool<any[]>("flows.list", {}).then((rows) => { if (live && Array.isArray(rows)) put("flows", rows.map((f) => ({ id: String(f.id), label: String(f.name || f.label || f.id), href: `/u/flows/${f.id}` }))); }, () => {});
    return () => { live = false; };
  }, [put]);
  return null;
}

/** The sections of Settings: what the owner moved under it (sidebar-ia). */
const SETTINGS: PanelItem[] = [
  { id: "spaces", label: "Space", href: "/u/spaces", icon: "space", group: "Space" },
  { id: "roles", label: "People and roles", href: "/u/settings/roles", icon: "users", group: "Space" },
  { id: "connections", label: "Connections", href: "/u/connections", icon: "link", group: "Space" },
  { id: "rules", label: "Rules", href: "/u/settings/rules", icon: "list", group: "Space" },
  { id: "tags", label: "Tags", href: "/u/tags", icon: "hash", group: "Space" },
  { id: "memory", label: "Memory", href: "/u/memory", icon: "memory", group: "Space" },
  { id: "sites", label: "Sites and publishing", href: "/u/sites", icon: "globe", group: "Space" },
  { id: "vault", label: "Vault", href: "/u/vault", icon: "vault", group: "Security" },
  { id: "devices", label: "Devices", href: "/u/settings/devices", icon: "devices", group: "Security" },
  { id: "permissions", label: "Permissions", href: "/u/settings/permissions", icon: "shield", group: "Security" },
  { id: "privacy", label: "Privacy", href: "/u/settings/privacy", icon: "eye", group: "Security" },
  { id: "system", label: "Servers", href: "/u/settings/system", icon: "server", group: "System" },
  { id: "updates", label: "Updates", href: "/u/settings/updates", icon: "refresh", group: "System" },
  { id: "backups", label: "Backups", href: "/u/settings/backups", icon: "storage", group: "System" },
  { id: "account", label: "Account", href: "/u/settings/account", icon: "person", group: "You" },
  { id: "appearance", label: "Appearance", href: "/u/appearance", icon: "wink", group: "You" },
  { id: "notifications", label: "Notifications", href: "/u/settings/notifications", icon: "bell", group: "You" },
];

const META: Record<string, { title: string; icon: PanelDef["icon"]; search?: string; empty: string }> = {
  projects: { title: "Projects", icon: "projects", search: "Search projects", empty: "No projects yet." },
  chats: { title: "Chat", icon: "chat", search: "Search chats", empty: "No chats yet." },
  records: { title: "Records", icon: "records", empty: "" },
  flows: { title: "Flows", icon: "flows", search: "Search flows", empty: "No flows yet." },
  settings: { title: "Settings", icon: "settings", search: "Search settings", empty: "" },
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
  const id = panelFor(path, search);
  const meta = id ? META[id] : undefined;
  if (!id || !meta) return { panel: null, id: null };
  const goBack = () => { const to = backTo(path, search); if (to) router.push(to as never); };
  const all = effective(base, mine) as any[];
  const edit = async (list: any[]) => { await saveList("me", space, list); await load(space); };
  const views = id === "records" ? (effective(base, mine) as any[]).filter((e) => e.kind === "view" && !e.hidden && String(e.href).startsWith("/u/records/")) : [];
  return {
    id,
    panel: {
      id, title: meta.title, icon: meta.icon, search: meta.search, empty: meta.empty, onBack: goBack, currentHref: path,
      items: id === "settings" ? SETTINGS : id === "records" ? [] : loaded[id] ?? [],
      before: id === "records" ? <><SidebarRow label="Contacts" icon="contacts" on={path === "/u/records/contact"} onPress={() => onNavigate("/u/records/contact")} />
        <PinnedViews entries={all} onOpen={onNavigate}
          onMove={(i, before) => void edit(reorderPinned(all, i, before))} onRename={(i, label) => void edit(renameView(all, i, label))} onUnpin={(i) => void edit(unpinList(all, i))} /></> : undefined,
      after: id === "records" ? <><SidebarRow label="All record types" icon="records" tone="label" onPress={() => onNavigate("/u/record-types")} /><SidebarRow label="New view" icon="plus" tone="label" onPress={() => onNavigate("/u/records/contact?newView=1")} /></> : undefined,
    },
  };
}
