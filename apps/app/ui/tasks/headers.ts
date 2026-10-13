import { kindOf, type AvatarRef } from "../components/Avatar";
import { aid, stageFieldOf, stageNames } from "../../src/store-core/kernel-view.js";
import { templateNoun, templateStage } from "./template-stage.js";
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

/** For a project: the emblem, its title, and "Matter · Juniper Studio". */
export function projectHeader(world: World, def: any, row: any): { title: string; context: string; faces: AvatarRef[] } {
  const title = recordTitle(world, row);
  return {
    title,
    context: [(def?.name === "project" ? templateNoun(row.data) : null) || def?.label, spaceName(world, row.labels?.source_spaces?.[0])].filter(Boolean).join(" · "),
    faces: [{ kind: "project", id: row.id, name: title, seed: row.data?.avatar_seed }],
  };
}

/** Where a project is in its stages ("Stage 2 of 5") and who is on it (its actor fields: the owner), from the record alone, the same reading the Projects list uses. */
export function projectStrip(world: World, def: any, row: any): { stage: { name: string; at: number; of: number } | null; people: string[] } {
  const pinned = templateStage(row.data);
  const sf = def ? stageFieldOf(def) : null;
  const stages: string[] = pinned ? pinned.stages : sf ? stageNames(def, sf) : [];
  const at = pinned ? pinned.at : sf ? stages.indexOf(String(row.data?.[sf.name] ?? "")) : -1;
  const people = (def?.fields ?? []).filter((x: any) => x.kind === "actor").map((f: any) => who(world, aid(row.data?.[f.name]?.actor))?.name).filter(Boolean) as string[];
  return { stage: at >= 0 && stages.length ? { name: stages[at], at: at + 1, of: stages.length } : null, people: [...new Set(people)] };
}
