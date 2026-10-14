import { useCallback, useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Card, Divider, FlowStep, Row, Segmented, Switch } from "@vyre/ui";
import { MOCK } from "../../src/real/box";
import { shellKind } from "../../src/shell/shell";
import { SCREENS, resumeAt, route, stepLabels } from "./flow-model.js";
import { hasServer, keptName } from "./has-server";
import { IdApprove, IdChoice, IdKit, IdNew, IdRecover, IdSignin } from "./IdentityScreens";
import { InfKey, InfPick, MasterConfirm, MasterEnter, MasterSet, VaultIntro } from "./VaultInferenceScreens";
import { Compute, CreateCode, CreateConfirm, CreateMembers, CreateName, CreateRun, CreateServer, CreateSetup, InviteDone, InviteLink, InviteWho, InviteWords, JoinCode, JoinReview, JoinSealing, Ready, SpaceChoice } from "./SpaceScreens";
import type { Ctx, ScreenProps } from "./types";

const FRESH: Ctx = { device: "computer", allowed: true, later: false, name: "", master: "", reset: false, ai: {}, aiSkipped: false, spaceName: "", server: "cloud", created: false, runHere: false, role: "member", inviteName: "", inviteRole: "member", inviteProjects: [], inviteLevels: {}, inviteDays: "7" };

function Start({ ctx, set, go }: ScreenProps) {
  return (
    <FlowStep hero mark="intro" title="Try the new setup" lead="A click-through of how a person gets into Vyre. Nothing is saved and no server is called. Choose what to look at, then start."
      primary={{ label: "Start", onPress: () => go(ctx.later ? "space.choice" : "id.choice") }}>
      <Segmented label="Which path" fill options={[["first", "First time on a device"], ["later", "Add a space later"]]} value={ctx.later ? "later" : "first"} onChange={(v) => set({ later: v === "later" })} />
      <Segmented label="This device" fill options={[["computer", "Computer"], ["phone", "Phone or browser"]]} value={ctx.device} onChange={(v) => set({ device: v })} />
      <Card flush>
        <Row dense title="The space you join lets people use their own computers" sub="Turn it off to see the flow without the Compute step." end={<Switch label="The space you join lets people use their own computers" on={ctx.allowed} onChange={(v) => set({ allowed: v })} />} />
        <Divider />
        <Row dense title="Back is on every screen" sub="Except this one. Failures are reachable on each screen, with a hint." />
      </Card>
      <Banner tone="plain" icon="info">Phone and browser skip Compute. Adding a space later skips Identity, Vault and Inference.</Banner>
    </FlowStep>
  );
}

const VIEWS: Record<string, (p: ScreenProps) => React.JSX.Element> = {
  start: Start,
  "id.choice": IdChoice, "id.signin": IdSignin, "id.approve": IdApprove, "id.recover": IdRecover, "id.new": IdNew, "id.kit": IdKit,
  "vault.intro": VaultIntro, "master.set": MasterSet, "master.confirm": MasterConfirm, "master.enter": MasterEnter,
  "inf.pick": InfPick, "inf.key": InfKey,
  "space.choice": SpaceChoice, "create.name": CreateName, "create.members": CreateMembers, "create.server": CreateServer, "create.run": CreateRun, "create.code": CreateCode, "create.confirm": CreateConfirm, "create.setup": CreateSetup,
  "join.code": JoinCode, "join.review": JoinReview, "join.sealing": JoinSealing,
  compute: Compute, ready: Ready,
  "invite.who": InviteWho, "invite.link": InviteLink, "invite.words": InviteWords, "invite.done": InviteDone,
};

/** The onboarding prototype: one state machine over the flow map (flow-model.js). A screen asks to go to another by id; Back pops. Mock mode only. */
export function OnboardFlow() {
  const { path } = useLocalSearchParams<{ path?: string | string[] }>();
  const router = useRouter();
  const entry = Array.isArray(path) ? path[0] : path;
  // The first-run flow. A join link or "Add a space" opens at the Space step; the mock build opens on its setup screen; a real first run opens on Identity.
  // On a Mac or Windows shell this is a computer (it asks Compute); a phone or a browser is not.
  const [stack, setStack] = useState<string[]>(entry === "join" ? ["space.choice", "join.code"] : entry === "create" ? ["space.choice", "create.name"] : MOCK ? ["start"] : ["id.choice"]);
  const [ctx, setCtx] = useState<Ctx>({ ...FRESH, device: MOCK || shellKind() ? "computer" : "phone", allowed: MOCK, later: entry === "join" || entry === "create" });
  const set = useCallback((p: Partial<Ctx> | ((c: Ctx) => Partial<Ctx>)) => setCtx((c) => ({ ...c, ...(typeof p === "function" ? p(c) : p) })), []);
  // A new device with no server goes Identity, Space, Vault (the personal vault lives on a server): read once whether it has one, and flow-model.js route() orders the steps from that.
  useEffect(() => {
    if (MOCK) return;
    // Reopened with a name kept but no server (stopped at the Vault): open on the Space step, with the Vault held for after it.
    void Promise.all([hasServer(), keptName()]).then(([has, identityName]) => {
      setCtx((c) => ({ ...c, paired: has }));
      const resume = resumeAt({ hasServer: has, identityName, entry });
      if (resume) { setCtx((c) => ({ ...c, ...resume.patch })); setStack((s) => (s.length === 1 && s[0] === "id.choice" ? resume.stack : s)); }
    });
  }, [entry]);
  const go = useCallback((want: string) => {
    // "start" is the mock's setup screen; in a real run it is the end of the flow, and the app opens.
    if (want === "start") { if (MOCK) { setStack(["start"]); setCtx(FRESH); } else router.replace("/u/now" as never); return; }
    const { to: id, patch } = route(ctx, want);
    if (Object.keys(patch).length) setCtx((c) => ({ ...c, ...patch }));
    setStack((s) => (VIEWS[id] ? [...s, id] : s));
  }, [router, ctx]);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const id = stack[stack.length - 1];
  const View = VIEWS[id];
  const labels = stepLabels(ctx);
  const step = SCREENS[id as keyof typeof SCREENS]?.step;
  const at = step ? labels.indexOf(step) : -1;
  return (
    <>
      <View key={`${id}:${stack.length}`} ctx={ctx} set={set} go={go} back={stack.length > 1 ? back : undefined} steps={at >= 0 ? { labels, current: at } : undefined} />
    </>
  );
}
