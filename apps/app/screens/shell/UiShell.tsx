import { SessionNotice } from "./SessionNotice";
import { ApprovalSheet } from "./ApprovalSheet";
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { sectionOf, stepSection } from "../build/sections.js";
import { EmptyState, LoadingState, Shell, showToast, allowsMock, backTo, nowCount, useAppearance, useWorld } from "@vyre/ui";
import { useNavDef, useSidebar } from "./sidebar";
import { PanelLoader, usePanel } from "./panels";
import { NewViewHost } from "../records/NewViewHost";
import { useSpaceLogos } from "../../ui/marks/useSpaceLogos";
import { useShell } from "./shared";
import { loadReal } from "./real";
import { whoIsThere } from "./gate.js";
import { recentChats } from "./recent.js";
import { gatedPath } from "./basic.js";
import { SERVER_SETUP_ROUTE } from "../install/first-run.js";
import { NeedsServer } from "./NeedsServer";
import { call, listen, signIn, signOut } from "../../src/api/box";
import { viewCache } from "../../src/state/cache";
import { setNowScope } from "../../ui/tasks/scope";
import { spaceForKey } from "../../ui/shell/switcher-model.js";
import { GATE_BUDGET_MS, SHELL_KEY, packShell, unpackShell } from "./shell-cache.js";
import { useProfiles } from "../../src/state/profiles";
import { startSpace } from "./real-model";
import { useSpaces } from "./state";
import { themeFor } from "./spaces.js";
import { FindHost, openFind } from "../find/FindHost";
import { ComputerHost } from "../glass/ComputerHost";
import { startKeepingAppearance } from "../../src/state/keep-appearance";
import { startKeepingMyLook, useMyLook } from "../../src/state/my-look";
import { lockIdentity } from "../unlock/real.js";
import { lockChanged } from "../../src/shell/lock-setting";
import { setScheme } from "../settings/appearance";

/** The frame of /u: the rail or tab bar, the space switcher, and the showing space's look applied to the theme. */
export function UiShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { space, looks, setShowing } = useSpaces();
  const { data: DATA, set, fail, loaded } = useShell();
  useEffect(() => { startKeepingAppearance(); }, []);
  const myLook = useMyLook((x) => x.look);
  useEffect(() => { startKeepingMyLook(); }, []);
  // The sidebar: the arrangement for the showing Space, loaded when the box is reached and again whenever the box says it changed (this device or another).
  const arranged = useNavDef(space);
  const loadSidebar = useSidebar((x) => x.load);
  // Nobody signed in: ask once and show the sign-in state, instead of mounting screens that each get a refusal from the box.
  const lastSpace = useRef("");
  const [gate, setGate] = useState<"asking" | "in" | "out">(allowsMock() ? "in" : "asking");
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    // Open from the kept copy: a device that was signed in last time shows the shell at once and is checked behind it; the check has a time limit, and a box that does not answer is "in" (the screens say what is wrong).
    void viewCache.get(SHELL_KEY).then((raw) => {
      const k = unpackShell(raw);
      if (!live || !k) return;
      lastSpace.current = k.space;
      if (!useShell.getState().loaded) { set(k.data as never); if (k.space && k.data.spaces.some((x: { id: string }) => x.id === k.space) && !useSpaces.getState().space) setShowing(k.space); }
      setGate((g) => (g === "asking" ? "in" : g));
    }).catch(() => {});
    const limit = setTimeout(() => { if (live) setGate((g) => (g === "asking" ? "in" : g)); }, GATE_BUDGET_MS);
    whoIsThere(call).then((g) => { if (live) setGate(g); });
    return () => { live = false; clearTimeout(limit); };
  }, []);
  // What the shell last knew (the Spaces, the person's line, the Space showing) is kept for the next open.
  useEffect(() => {
    if (allowsMock() || gate !== "in" || !loaded) return;
    void viewCache.set(SHELL_KEY, packShell(DATA, space));
  }, [gate, loaded, DATA, space]);
  useEffect(() => {
    if (allowsMock() || gate !== "in") return;
    let live = true;
    loadReal().then((d) => { if (!live) return; set(d); if (!d.spaces.some((x) => x.id === useSpaces.getState().space)) setShowing(startSpace(d, lastSpace.current)); }).catch((e) => live && fail(e instanceof Error ? e.message : "The box did not answer."));
    return () => { live = false; };
  }, [set, fail, setShowing, gate]);
  useEffect(() => {
    if (allowsMock() || gate !== "in") return;
    void loadSidebar(space);
    return listen((e) => { if (e.type === "sidebar.changed" || e.type === "settings.changed") void loadSidebar(space); });
  }, [gate, space, loadSidebar]);
  // A browser or Windows window has no menu bar: Ctrl or Cmd with a comma opens Settings, with 1 to 4 the first four places. Lumen's own menu does this on a Mac.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || (window as unknown as { __vyreShell?: unknown }).__vyreShell) return;
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === ",") { e.preventDefault(); router.push("/u/spaces" as never); return; }
      if (e.key.toLowerCase() === "l" && !allowsMock()) { e.preventDefault(); void lockIdentity().then((r: { ok: boolean; message?: string }) => { if (r.ok) lockChanged(); else showToast(r.message ?? "That did not go through."); }); return; }
      // Cmd N is a new chat with your assistant, in every place
      if (e.key.toLowerCase() === "n") { e.preventDefault(); router.push("/u/chats/new-thread" as never); return; }
      // Cmd 1 to Cmd 9 pick the Space in that place of the footer menu
      const to = spaceForKey(DATA.spaces, e.key);
      if (to) { e.preventDefault(); setShowing(to); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [router, DATA.spaces, setShowing]);
  // Inside Build, up and down move through its list and Escape folds back to the main sidebar, as in Settings.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || sectionOf(path) === null) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return;
      if (e.key === "Escape") { const to = backTo(path, ""); if (to) { e.preventDefault(); router.push(to as never); } return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { const to = stepSection(sectionOf(path), e.key === "ArrowDown" ? 1 : -1); if (to) { e.preventDefault(); router.replace(to as never); } }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [path, router]);
  // On a Basic personal space (no server) the places that need a server say so, and offer the team spaces and a server of the person's own.
  const showing = DATA.spaces.find((x) => x.id === space);
  const teams = DATA.spaces.filter((x) => !x.basic);
  const needsServer = Boolean(showing?.basic) && gatedPath(path, teams.length > 0);
  const setSpace = useAppearance((s) => s.setSpace);
  const world = useWorld();
  const waiting = world.data ? nowCount(world.data) : 0;
  const nav = { ...arranged, items: arranged.items.map((it) => (it.id === "now" && waiting ? { ...it, badge: waiting } : it)) };
  const look = looks[space || "mine"];
  useEffect(() => { useSpaceLogos.getState().set(Object.fromEntries(Object.entries(looks).filter(([, l]) => l.logo).map(([id, l]) => [id, l.logo as string]))); }, [looks]);
  // Recent: the latest chats under the places, read again when the person moves and the last read is over 20 s old.
  const [recent, setRecent] = useState<{ id: string; label: string; href: string }[]>([]);
  const [recentAt, setRecentAt] = useState(0);
  useEffect(() => {
    if (allowsMock() || gate !== "in" || Date.now() - recentAt < 20_000) return;
    setRecentAt(Date.now());
    void call<unknown>("threads.list", { all: true }).then((r) => { if (!r.error) setRecent(recentChats(r.data)); }).catch(() => {});
  }, [gate, path, recentAt]);
  // The showing Space's profiles: your face here is the look you chose in this Space's profile, and the people of the Space are drawn with theirs.
  const loadProfiles = useProfiles((x) => x.load);
  const ownLook = useProfiles((x) => { const e = x.bySpace[space]; return e && e.me ? e.byPerson[e.me]?.look ?? "" : ""; });
  useEffect(() => { if (!allowsMock() && gate === "in") void loadProfiles(space); }, [gate, space, loadProfiles]);
  const go = (href: string) => router.push(href as never);
  const { panel, id: panelId } = usePanel(go);
  useEffect(() => { setNowScope(space); }, [space]);
  useEffect(() => { setSpace(themeFor(space, looks)); }, [space, look, looks, setSpace]);
  return (
    <Shell {...nav} onNewChat={() => router.push("/u/chats/new-thread" as never)} recent={recent} current={path} onNavigate={(href) => (href === "/u/search" ? openFind() : go(href))} onSearch={openFind} onTheme={(v) => { if (!allowsMock()) setScheme(v).catch(() => showToast("The theme changed here, but it could not be saved.")); }} onLock={() => { void lockIdentity().then((r: { ok: boolean; message?: string }) => { if (r.ok) lockChanged(); else showToast(r.message ?? "That did not go through."); }); }} onSignOut={allowsMock() ? undefined : () => { void signOut(); }} panel={panel} spaces={DATA.spaces} space={space} onSpace={setShowing} user={{ name: DATA.me.name, sub: DATA.me.vyreName, look: ownLook || myLook || undefined }}>
      <SessionNotice />
      {gate === "asking" ? <LoadingState rows={3} /> : gate === "out" ? (
        <EmptyState title="Sign in to Vyre" body="Nobody is signed in on this device yet." action={{ label: "Sign in", onPress: () => { void signIn(); } }} />
      ) : needsServer ? <NeedsServer teams={teams} onOpenTeam={(id) => { setShowing(id); }} onAddServer={() => router.push(SERVER_SETUP_ROUTE as never)} /> : children}
      <ApprovalSheet />
      <FindHost />
      <ComputerHost />
      <PanelLoader id={panelId} />
      <NewViewHost />
    </Shell>
  );
}
