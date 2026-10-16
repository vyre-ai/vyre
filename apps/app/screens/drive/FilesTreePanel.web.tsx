// Files' own tree as the sidebar's panel (the same drill-in as Chat, Settings and Build): Space, Shared, Linked and On your server, each folder opening beneath it. Picking one
// opens it in the page (files-nav.ts); a linked folder's files can be dragged to another folder in the same linked folder.
import { useEffect, useMemo } from "react";
import { useWindowDimensions } from "react-native";
import { Tree, type NodeRendererProps } from "react-arborist";
import { Icon, Text, showToast } from "@vyre/ui";
import { rootsOf, parsePlace, type TreeNode } from "./files-model.ts";
import { linked } from "./real";
import { useFilesNav } from "./files-nav";
import { linkedRefusal } from "./linked-model";
import { spaceDriveRefusal } from "./space-model";
import { driveRefusal } from "./real-model";

const say = (e: unknown) => { const x = e as { code?: string }; const m = e instanceof Error ? e.message : ""; return x.code === "conflict" || x.code === "unsupported" ? linkedRefusal(x.code, m) : spaceDriveRefusal(x.code, m) || driveRefusal(x.code, m); };
const ROOT_ICON: Record<string, string> = { space: "drive", shared: "share", linked: "link", box: "server" };

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
    <Tree<TreeNode> data={data} childrenAccessor="kids" idAccessor="id" width="100%" height={Math.max(240, height - 190)} rowHeight={36} indent={14} openByDefault={false} selection={place}
      disableDrag={(n) => n.root !== "linked" || !n.id.includes(":")} disableDrop={(a) => !(a.parentNode?.data?.root === "linked" && a.parentNode.data.id.includes(":"))} disableEdit
      onSelect={(ns) => { if (ns[0]) go(ns[0].id); }} onToggle={(id) => openNode(id)} onMove={onMove}>
      {TreeRow}
    </Tree>
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
