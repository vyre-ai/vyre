import { useEffect } from "react";
import { usePathname, useRouter } from "expo-router";
import { Shell, nowCount, useAppearance, useWorld } from "@vyre/ui";
import { NAV } from "./nav";
import { loadShell } from "./data";
import { useSpaces } from "./state";
import { themeFor } from "./spaces.js";

const DATA = loadShell();

/** The frame of /u: the rail or tab bar, the space switcher, and the showing space's look applied to the theme. */
export function UiShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { space, looks, setShowing } = useSpaces();
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
