import { useEffect, useState } from "react";
import { BoardView } from "@vyre/ui";
import { closingFilter } from "../../ui/views/board-stats.js";
import { recordsApi } from "./records-api";

/**
 * The board with its totals from records.stats, across every record the person may read, so a column is right once the loaded cards are only some of them. It asks again when the records change; a box
 * without the tool, or a type with nothing to add up, leaves the loaded rows to answer (BoardView falls back to them).
 */
export function BoardWithStats(p: Omit<React.ComponentProps<typeof BoardView>, "stats">) {
  const [stats, setStats] = useState<{ all?: { groups: any[] }; closing?: { groups: any[] } } | undefined>(undefined);
  const type = p.def.name as string;
  // a card added, moved or edited changes a version, so this asks again; a redraw with the same cards does not
  const sig = p.rows.map((r: any) => `${r.id}:${r.version}`).join(",");
  useEffect(() => {
    let live = true;
    void Promise.all([recordsApi.stats(type), recordsApi.stats(type, { filter: closingFilter(Date.now()) })]).then(([a, c]) => {
      if (live) setStats(a.error ? undefined : { all: a.data, closing: c.error ? undefined : c.data });
    });
    return () => { live = false; };
  }, [type, sig]);
  return <BoardView {...p} stats={stats} />;
}
