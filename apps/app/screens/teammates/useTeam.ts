// One project's team (or every team) read on open, after each action, and on the team's events. Nothing polls.
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "../../src/api/box";
import { errWords, type Teammate } from "./model";
import { teammates } from "./teammates";

export const TEAM_EVENTS = /^(teammate\.|team\.)/;

export function useTeam(project: string | null) {
  const [rows, setRows] = useState<Teammate[] | null>(null);
  const [error, setError] = useState("");
  const [steer, setSteer] = useState<boolean | null>(null);
  const live = useRef(true);
  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([project ? teammates.list(project) : teammates.all(), project ? teammates.steer(project) : Promise.resolve(null)]);
      if (!live.current) return;
      setRows(r); setSteer(s); setError("");
    } catch (e) { if (live.current) { setRows([]); setError(errWords(e)); } }
  }, [project]);
  useEffect(() => { live.current = true; void load(); const off = listen((e: { type?: string }) => { if (TEAM_EVENTS.test(String(e?.type || ""))) void load(); }); return () => { live.current = false; off(); }; }, [load]);
  return { rows, error, steer, reload: load };
}
