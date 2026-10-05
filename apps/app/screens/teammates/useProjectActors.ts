// The actor ids of one project's teammates for the Assign to picker, read only while the picker is open and the task names a project. A task without a project, or a box that cannot answer, gives no list and the picker behaves as before.
import { useEffect, useState } from "react";
import { projectActorIds } from "./model";
import { teammates } from "./teammates";

export function useProjectActors(project: string, open: boolean): string[] {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    if (!open || !project) { setIds([]); return; }
    let live = true;
    teammates.list(project).then((rows) => { if (live) setIds(projectActorIds(rows)); }).catch(() => { if (live) setIds([]); });
    return () => { live = false; };
  }, [project, open]);
  return ids;
}
