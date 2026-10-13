// The data behind the nested @ and # pickers: the trees (src/chat/mention-tree.js) built from what the box has. Fetched the first time a trigger opens, not on every chat.
// # reads the records world (projects, objects, tags), the project templates (work.template.list) and the Drive's file list; @ reads the people and assistants the composer already has,
// plus the roles (roles.list). Anything that does not answer leaves its group empty; the pickers still work with what is there.
import { useEffect, useMemo, useState } from "react";
import { titleOf, useRecordsWorld } from "@vyre/ui";
import { tool } from "../real/box";
import { atTree, filesOf, hashTree, worldOfPicks } from "./mention-tree.js";
import type { NestNode } from "@vyre/ui/lib/nest-model.js";
import type { Person, RecordPick } from "./ChatComposer";

export function useMentionNodes(o: { wanted: boolean; people: readonly Person[]; records: readonly RecordPick[]; files: readonly { id: string; name: string; path: string }[]; ais: readonly string[] }) {
  const { data: world } = useRecordsWorld();
  const [templates, setTemplates] = useState<unknown>(null);
  const [roles, setRoles] = useState<unknown>(null);
  useEffect(() => {
    if (!o.wanted) return;
    let live = true;
    void tool("work.template.list", {}).then((r) => live && setTemplates(r)).catch(() => {});
    void tool("roles.list", {}).then((r) => live && setRoles(r)).catch(() => {});
    return () => { live = false; };
  }, [o.wanted]);
  const hash = useMemo((): NestNode[] => {
    const w = world && (world as { types?: unknown[] }).types?.length ? (world as never) : worldOfPicks(o.records);
    const f = filesOf(o.files);
    return hashTree({ world: w, titleOf: (d: unknown, r: unknown) => titleOf(d as never, r as never), templates, files: f.paths, names: f.names }) as NestNode[];
  }, [world, templates, o.files, o.records]);
  const at = useMemo((): NestNode[] => {
    const list = Array.isArray(roles) ? roles : Array.isArray((roles as { roles?: unknown[] } | null)?.roles) ? (roles as { roles: unknown[] }).roles : [];
    const teams = list.map((r) => r as { id?: string; label?: string }).filter((r) => r && (r.label || r.id)).map((r) => ({ name: String(r.label || r.id), kind: "role" }));
    return atTree({ people: o.people, teams, ais: o.ais }) as NestNode[];
  }, [o.people, roles, o.ais]);
  return { at, hash };
}
