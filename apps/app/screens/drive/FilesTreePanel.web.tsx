// Files' own tree as the sidebar's panel (the same drill-in as Chat, Settings and Build): Space, Shared, Linked, On your server and On your computer, each folder opening beneath it. Picking one
// opens it in the page (files-nav.ts); a linked folder's files can be dragged to another folder in the same linked folder.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useWindowDimensions } from "react-native";
import { Tree, type NodeRendererProps } from "react-arborist";
import { Chip, Icon, Text, showToast } from "@vyre/ui";
import { rootsOf, parsePlace, type TreeNode } from "./files-model.ts";
import { linked } from "./real";
import { tool } from "../../src/real/box";
import { useFilesNav } from "./files-nav";
import { linkedRefusal } from "./linked-model";
import { spaceDriveRefusal } from "./space-model";
import { driveRefusal } from "./real-model";
import { placeGroups } from "./files-places.js";
import { startThread } from "./new-thread";
import { list as listDeployments } from "../sites/real";
import { sites as siteList } from "../sites/real-model";

const say = (e: unknown) => { const x = e as { code?: string }; const m = e instanceof Error ? e.message : ""; return x.code === "conflict" || x.code === "unsupported" ? linkedRefusal(x.code, m) : spaceDriveRefusal(x.code, m) || driveRefusal(x.code, m); };
const ROOT_ICON: Record<string, string> = { space: "drive", shared: "share", linked: "link", box: "server", computer: "laptop" };

/** The places above the folder tree: All files, Recent, Shared with me, and the Sites section (published sites, drafts and New site). Picking one opens it in the page (files-nav.ts). */
function Places() {
  const router = useRouter();
  const { place, go } = useFilesNav();
  const [sites, setSites] = useState<{ id: string; name: string; live?: boolean }[]>([]);
  const [folders, setFolders] = useState<{ projects: { name: string; path: string }[]; agents: { name: string; path: string }[] }>({ projects: [], agents: [] });
  // the projects and agents this person can see, each with the Drive folder it opens (files.places, under their own chain)
  useEffect(() => { tool<{ projects?: { name: string; path: string }[]; agents?: { name: string; path: string }[] }>("files.places", {}).then((r) => setFolders({ projects: r?.projects ?? [], agents: r?.agents ?? [] })).catch(() => setFolders({ projects: [], agents: [] })); }, []);
  useEffect(() => { listDeployments().then((d) => setSites(siteList(d).map((s) => ({ id: s.name, name: s.name, live: Boolean(s.live) })))).catch(() => setSites([])); }, []);
  const groups = placeGroups({ sites, projects: folders.projects, agents: folders.agents });
  const target = (id: string) => (id === "all" ? "space" : id === "shared-links" ? "shared" : id.startsWith("project:") || id.startsWith("agent:") ? `space:${id.slice(id.indexOf(":") + 1)}` : id);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingBottom: 8 }}>
      {groups.map((g) => (
        <div key={g.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {g.heading ? <div style={{ padding: "10px 8px 4px" }}><Text size="caption" tone="label">{g.heading}</Text></div> : null}
          {g.places.map((p) => {
            const on = p.kind !== "newsite" && place === target(p.id);
            return (
              <div key={p.id} role="button" onClick={() => { if (p.kind === "newsite") void startThread(router, "engineer", "Build me a new site: ", "New site"); else go(target(p.id)); }}
                style={{ display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 8px", borderRadius: 10, cursor: "pointer", background: on ? "var(--surface-3)" : "transparent" }}>
                <Icon name={(p.kind === "all" ? "drive" : p.kind === "recent" ? "clock" : p.kind === "shared" ? "users" : p.kind === "newsite" ? "plus" : p.kind === "project" ? "projects" : p.kind === "agent" ? "agents" : "globe") as never} size={16 as never} tone={on ? "text" : "text-2"} />
                <div style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Text size="caption" strong={on}>{p.label}</Text></div>
                {p.live ? <Chip tone="ok">Live</Chip> : p.draft ? <Text size="caption" tone="faint">draft</Text> : null}
              </div>
            );
          })}
        </div>
      ))}
      <div style={{ padding: "10px 8px 4px" }}><Text size="caption" tone="label">Folders</Text></div>
    </div>
  );
}

export function FilesTreePanel() {
  const { height } = useWindowDimensions();
  const { place, folders, status, kids, go, loadRoots, openNode, invalidate } = useFilesNav();
  useEffect(() => { loadRoots(); }, [loadRoots]);
  useEffect(() => { if (!kids.space) openNode("space"); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    const roots = rootsOf({ linked: folders, shares: status?.shares ?? [] });
    const withKids = (n: TreeNode): TreeNode => {
      const list = kids[n.id] ?? n.kids ?? (n.root === "space" || n.id.includes(":") ? [] : undefined);
      return list ? { ...n, kids: list.map(withKids) } : n;
    };
    return roots.map((r) => (r.id === "space" ? { ...r, kids: (kids.space ?? []).map(withKids) } : withKids(r)));
  }, [folders, status, kids]);

  const onMove = ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null }) => {
    const to = parentId ? parsePlace(parentId) : null;
    if (!to || to.root !== "linked" || !to.link) { showToast("Only linked folders move files."); return; }
    Promise.all(dragIds.map((id) => {
      const f = parsePlace(id);
      if (!f || f.root !== "linked" || f.link !== to.link) return Promise.reject(new Error("Files move within one linked folder."));
      const name = f.path.split("/").pop()!;
      return linked.rename(to.link!, f.path, to.path ? `${to.path}/${name}` : name);
    })).then(() => { showToast("Moved at the source."); invalidate(); }).catch((e) => showToast(say(e)));
  };

  return (
    <>
    <Places />
    <Tree<TreeNode> data={data} childrenAccessor="kids" idAccessor="id" width="100%" height={Math.max(200, height - 190 - 290)} rowHeight={36} indent={14} openByDefault={false} selection={place}
      disableDrag={(n) => n.root !== "linked" || !n.id.includes(":")} disableDrop={(a) => !(a.parentNode?.data?.root === "linked" && a.parentNode.data.id.includes(":"))} disableEdit
      onSelect={(ns) => { if (ns[0]) go(ns[0].id); }} onToggle={(id) => openNode(id)} onMove={onMove}>
      {TreeRow}
    </Tree>
    </>
  );
}

function TreeRow({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  const top = !node.id.includes(":") && ROOT_ICON[node.id];
  return (
    <div ref={dragHandle} style={{ ...style, display: "flex", alignItems: "center", gap: 8, paddingRight: 8, background: node.isSelected ? "var(--surface-3)" : "transparent", borderRadius: 10, cursor: "pointer" }}>
      <span onClick={(e) => { e.stopPropagation(); node.toggle(); }} style={{ width: 16, display: "inline-flex", justifyContent: "center", opacity: node.isLeaf && !node.data.kids ? 0 : 0.7 }}><Icon name={(node.isOpen ? "chevron-down" : "chevron") as never} size={14 as never} tone="label" /></span>
      <Icon name={(top ? ROOT_ICON[node.id] : "folder") as never} size={16 as never} tone={node.isSelected ? "text" : "text-2"} />
      <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Text size="caption" strong={node.isSelected || !!top}>{node.data.label}</Text></div>
    </div>
  );
}
