import { kindOf, type AvatarRef } from "../components/Avatar";
import { aid } from "../../src/vendor/deck/ui/kernel-view.js";
import { recordTitle, spaceName, who, type World } from "./model";

/** An actor as a mark reference. */
export function faceOf(world: World, id: string): AvatarRef {
  const a = who(world, id);
  return { kind: kindOf(a?.family), id: a?.id || id, name: a?.name || id, seed: a?.seed };
}

/** What the page header says for a task: its title, "Record · Space", and the doer's face. */
export function taskHeader(world: World, task: any): { title: string; context: string; faces: AvatarRef[] } {
  const rec = world.records.get(task.record);
  return {
    title: task.title,
    context: [rec ? recordTitle(world, rec) : "", spaceName(world, task.space)].filter(Boolean).join(" · "),
    faces: [faceOf(world, aid(task.doer))],
  };
}

/** For a project: the emblem, its title, and "Matter · Harlow Legal". */
export function projectHeader(world: World, def: any, row: any): { title: string; context: string; faces: AvatarRef[] } {
  const title = recordTitle(world, row);
  return {
    title,
    context: [def?.label, spaceName(world, row.labels?.source_spaces?.[0])].filter(Boolean).join(" · "),
    faces: [{ kind: "project", id: row.id, name: title, seed: row.data?.avatar_seed }],
  };
}
