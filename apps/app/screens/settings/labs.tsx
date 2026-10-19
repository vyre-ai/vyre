// Labs: the one switch that brings the archived Settings pages back (archived.js). Off by default, kept per device (localStorage where there is one; a phone without it starts off each run).
// The switch sits at the bottom of About; with it off, an archived route goes back to Settings instead of showing a half-built page.
import type { ReactNode } from "react";
import { Redirect } from "expo-router";
import { Card, Row, Switch } from "@vyre/ui";
import { create } from "zustand";
import { archivedAt } from "./archived.js";

const KEY = "vyre.settings.labs";
const store = () => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
const read = () => { try { return store()?.getItem(KEY) === "on"; } catch { return false; } };

export const useLabs = create<{ on: boolean; set: (on: boolean) => void }>((set) => ({
  on: read(),
  set: (on) => { try { if (on) store()?.setItem(KEY, "on"); else store()?.removeItem(KEY); } catch { /* kept for this run only */ } set({ on }); },
}));

/** An archived page opens only with Labs on; otherwise its address goes back to Settings. */
export function ArchivedGate({ href, children }: { href: string; children: ReactNode }) {
  const on = useLabs((s) => s.on);
  if (on || !archivedAt(href)) return <>{children}</>;
  return <Redirect href={"/u/settings" as never} />;
}

/** The Labs switch, for the bottom of About. */
export function LabsSwitch() {
  const { on, set } = useLabs();
  return (
    <Card flush>
      <Row title="Labs" sub="Show unfinished pages in Settings. Off unless you need one." end={<Switch label="Labs" on={on} onChange={set} />} />
    </Card>
  );
}
