import { useCallback, useState } from "react";
import { Banner, Card, Divider, EmptyState, FlowStep, Row, Segmented, Switch, ToastHost } from "@vyre/ui";
import { MOCK } from "../../src/real/box";
import { SCREENS, stepLabels } from "./flow-model.js";
import { IdApprove, IdChoice, IdKit, IdNew, IdRecover, IdSignin } from "./IdentityScreens";
import { InfKey, InfPick, MasterEnter, MasterSet } from "./VaultInferenceScreens";
import { Compute, CreateCode, CreateConfirm, CreateName, CreateRun, CreateServer, CreateSetup, CreateVault, InviteDone, InviteLink, InviteWho, InviteWords, JoinCode, JoinReview, JoinSealing, Ready, SpaceChoice } from "./SpaceScreens";
import type { Ctx, ScreenProps } from "./types";

const FRESH: Ctx = { device: "computer", allowed: true, later: false, name: "", master: "", reset: false, ai: {}, aiSkipped: false, spaceName: "", server: "cloud", created: false, runHere: true, role: "member", inviteName: "", inviteRole: "member" };

function Start({ ctx, set, go }: ScreenProps) {
  return (
    <FlowStep title="Try the new setup" lead="A click-through of how a person gets into Vyre. Nothing is saved and no server is called. Choose what to look at, then start."
      primary={{ label: "Start", onPress: () => go(ctx.later ? "space.choice" : "id.choice") }}>
      <Segmented label="Which path" fill options={[["first", "First time on a device"], ["later", "Add a space later"]]} value={ctx.later ? "later" : "first"} onChange={(v) => set({ later: v === "later" })} />
      <Segmented label="This device" fill options={[["computer", "Computer"], ["phone", "Phone or browser"]]} value={ctx.device} onChange={(v) => set({ device: v })} />
      <Card flush>
        <Row dense title="The space allows sessions on computers" sub="Turn it off to skip the Compute step." end={<Switch label="The space allows sessions on computers" on={ctx.allowed} onChange={(v) => set({ allowed: v })} />} />
        <Divider />
        <Row dense title="Back is on every screen" sub="Except this one. Failures are reachable on each screen, with a hint." />
      </Card>
      <Banner tone="plain" icon="info">Phone and browser skip Compute. Adding a space later skips Identity, Master password and Inference.</Banner>
    </FlowStep>
  );
}

const VIEWS: Record<string, (p: ScreenProps) => React.JSX.Element> = {
  start: Start,
  "id.choice": IdChoice, "id.signin": IdSignin, "id.approve": IdApprove, "id.recover": IdRecover, "id.new": IdNew, "id.kit": IdKit,
  "master.set": MasterSet, "master.enter": MasterEnter,
  "inf.pick": InfPick, "inf.key": InfKey,
  "space.choice": SpaceChoice, "create.name": CreateName, "create.server": CreateServer, "create.run": CreateRun, "create.code": CreateCode, "create.confirm": CreateConfirm, "create.vault": CreateVault, "create.setup": CreateSetup,
  "join.code": JoinCode, "join.review": JoinReview, "join.sealing": JoinSealing,
  compute: Compute, ready: Ready,
  "invite.who": InviteWho, "invite.link": InviteLink, "invite.words": InviteWords, "invite.done": InviteDone,
};

/** The onboarding prototype: one state machine over the flow map (flow-model.js). A screen asks to go to another by id; Back pops. Mock mode only. */
export function OnboardFlow() {
  const [stack, setStack] = useState<string[]>(["start"]);
  const [ctx, setCtx] = useState<Ctx>(FRESH);
  const set = useCallback((p: Partial<Ctx> | ((c: Ctx) => Partial<Ctx>)) => setCtx((c) => ({ ...c, ...(typeof p === "function" ? p(c) : p) })), []);
  const go = useCallback((id: string) => {
    if (id === "start") { setStack(["start"]); setCtx(FRESH); return; }
    setStack((s) => (VIEWS[id] ? [...s, id] : s));
  }, []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  if (!MOCK) return <EmptyState title="This page is a prototype" body="It only opens in the mock build. Run npm run export:web:mock and open that build." />;
  const id = stack[stack.length - 1];
  const View = VIEWS[id];
  const labels = stepLabels(ctx);
  const step = SCREENS[id as keyof typeof SCREENS]?.step;
  const at = step ? labels.indexOf(step) : -1;
  return (
    <>
      <View key={`${id}:${stack.length}`} ctx={ctx} set={set} go={go} back={stack.length > 1 ? back : undefined} steps={at >= 0 ? { labels, current: at } : undefined} />
      <ToastHost />
    </>
  );
}
