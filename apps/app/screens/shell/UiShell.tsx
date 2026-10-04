import { useEffect } from "react";
import { usePathname, useRouter } from "expo-router";
import { Shell, allowsMock, nowCount, useAppearance, useWorld } from "@vyre/ui";
import { NAV } from "./nav";
import { useShell } from "./shared";
import { loadReal } from "./real";
import { startSpace } from "./real-model";
import { useSpaces } from "./state";
import { themeFor } from "./spaces.js";

/** The frame of /u: the rail or tab bar, the space switcher, and the showing space's look applied to the theme. */
export function UiShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { space, looks, setShowing } = useSpaces();
  const { data: DATA, set, fail } = useShell();
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    loadReal().then((d) => { if (!live) return; set(d); if (!d.spaces.some((x) => x.id === useSpaces.getState().space)) setShowing(startSpace(d)); }).catch((e) => live && fail(e instanceof Error ? e.message : "The box did not answer."));
    return () => { live = false; };
  }, [set, fail, setShowing]);
  const setSpace = useAppearance((s) => s.setSpace);
  const world = useWorld();
  const waiting = world.data ? nowCount(world.data) : 0;
  const nav = { ...NAV, items: NAV.items.map((it) => (it.id === "now" && waiting ? { ...it, badge: waiting } : it)) };
  const look = looks[space === "all" ? "mine" : space];
  useEffect(() => { setSpace(themeFor(space, looks)); }, [space, look, looks, setSpace]);
  return (
    <Shell {...nav} current={path} onNavigate={(href) => router.push(href as never)} spaces={DATA.spaces} space={space} onSpace={setShowing} user={{ name: DATA.me.name, sub: DATA.me.vyreName }}>
      {children}
    </Shell>
  );
}
