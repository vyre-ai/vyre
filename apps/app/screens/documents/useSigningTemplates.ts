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
    // A list that did not answer says nothing about the app: keep what the card showed (it used to turn into "Not installed" with an Install button for an app that was up)
    }).catch(() => {});
  }, [enabled]);
  useEffect(reload, [reload]);
  // While the app is installing, ask again every few seconds, so the card turns to Running by itself (an install outlasts the call that started it)
  const installing = Boolean(app && app.installing);
  useEffect(() => {
    if (!installing) return undefined;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [installing, reload]);
  return { app, signing, reload };
}

/** The label a signing template carries in a picker. */
export const signingLabel = (x: { name: string; folder: string }) => (x.folder ? `${x.folder}: ${x.name}` : x.name);
