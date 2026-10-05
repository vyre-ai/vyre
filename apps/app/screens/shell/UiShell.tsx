import { SessionNotice } from "./SessionNotice";
import { ApprovalSheet } from "./ApprovalSheet";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { EmptyState, LoadingState, Shell, allowsMock, nowCount, useAppearance, useWorld } from "@vyre/ui";
import { NAV } from "./nav";
import { useShell } from "./shared";
import { loadReal } from "./real";
import { whoIsThere } from "./gate.js";
import { call, signIn } from "../../src/api/box";
import { startSpace } from "./real-model";
import { useSpaces } from "./state";
import { themeFor } from "./spaces.js";
import { FindHost, openFind } from "../find/FindHost";
import { startKeepingAppearance } from "../../src/state/keep-appearance";

/** The frame of /u: the rail or tab bar, the space switcher, and the showing space's look applied to the theme. */
export function UiShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { space, looks, setShowing } = useSpaces();
  const { data: DATA, set, fail } = useShell();
  useEffect(() => { startKeepingAppearance(); }, []);
  // Nobody signed in: ask once and show the sign-in state, instead of mounting screens that each get a refusal from the box.
  const [gate, setGate] = useState<"asking" | "in" | "out">(allowsMock() ? "in" : "asking");
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    whoIsThere(call).then((g) => { if (live) setGate(g); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (allowsMock() || gate !== "in") return;
    let live = true;
    loadReal().then((d) => { if (!live) return; set(d); if (!d.spaces.some((x) => x.id === useSpaces.getState().space)) setShowing(startSpace(d)); }).catch((e) => live && fail(e instanceof Error ? e.message : "The box did not answer."));
    return () => { live = false; };
  }, [set, fail, setShowing, gate]);
  // A browser or Windows window has no menu bar: Ctrl or Cmd with a comma opens Settings, with 1 to 4 the first four places. Lumen's own menu does this on a Mac.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || (window as unknown as { __vyreShell?: unknown }).__vyreShell) return;
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === ",") { e.preventDefault(); router.push("/u/settings" as never); return; }
      const n = Number(e.key);
      const to = n >= 1 && n <= 4 ? NAV.items[n - 1]?.href : undefined;
      if (to) { e.preventDefault(); router.push(to as never); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [router]);
  const setSpace = useAppearance((s) => s.setSpace);
  const world = useWorld();
  const waiting = world.data ? nowCount(world.data) : 0;
  const nav = { ...NAV, items: NAV.items.map((it) => (it.id === "now" && waiting ? { ...it, badge: waiting } : it)) };
  const look = looks[space === "all" ? "mine" : space];
  useEffect(() => { setSpace(themeFor(space, looks)); }, [space, look, looks, setSpace]);
  return (
    <Shell {...nav} current={path} onNavigate={(href) => (href === "/u/search" ? openFind() : router.push(href as never))} spaces={DATA.spaces} space={space} onSpace={setShowing} user={{ name: DATA.me.name, sub: DATA.me.vyreName }}>
      <SessionNotice />
      {gate === "asking" ? <LoadingState rows={3} /> : gate === "out" ? (
        <EmptyState title="Sign in to Vyre" body="Nobody is signed in on this device yet." action={{ label: "Sign in", onPress: () => { void signIn(); } }} />
      ) : children}
      <ApprovalSheet />
      <FindHost />
    </Shell>
  );
}
