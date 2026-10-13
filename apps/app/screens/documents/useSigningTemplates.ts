import { useCallback, useEffect, useState } from "react";
import { tool } from "../../src/real/box";
import { appState, signingTemplates } from "./model.js";

/** The Documents app's state and its signing templates, for the Documents home and a record's Send for signature. Nothing is asked when `enabled` is false. */
export function useSigningTemplates(enabled: boolean) {
  const [app, setApp] = useState<ReturnType<typeof appState> | null>(null);
  const [signing, setSigning] = useState<ReturnType<typeof signingTemplates>>([]);
  const reload = useCallback(() => {
    if (!enabled) return;
    tool<any>("appmods.list").then((l) => {
      const s = appState(l);
      setApp(s);
      if (s.running) tool<any>("connectors.operation.run", { connection: "documents", operation: "templates.list", input: { query: { limit: 50 } } }).then((r) => setSigning(signingTemplates(r))).catch(() => setSigning([])); else setSigning([]);
    }).catch(() => setApp(appState(null)));
  }, [enabled]);
  useEffect(reload, [reload]);
  return { app, signing, reload };
}

/** The label a signing template carries in a picker. */
export const signingLabel = (x: { name: string; folder: string }) => (x.folder ? `${x.folder}: ${x.name}` : x.name);
