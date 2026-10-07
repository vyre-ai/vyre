// Flows and Kits: sample data in the shapes of the kernel's canvas and Kit APIs (kernel/flows canvas.js graph and paintRun, kits.js installCard and diffKits).
// `flowsRepo` is the one place a real source replaces; nothing else in the screens knows these are samples.
import type { Scope } from "../places/scope";
export type { Scope };

export type Step = { id: string; kind: string; label: string; who?: string; outward?: boolean; sealed?: boolean; code?: boolean; waits?: boolean; args?: string; then?: Step[]; else?: Step[]; each?: Step[] };
export type Def = { id: string; name: string; trigger: string; triggerCode: string; steps: Step[]; v: number; last: string; state: "On" | "Off"; from: string; hash: string };
export type Run = { id: string; title: string; started: string; state: "waiting" | "done"; at: string | null; note: string; tone: "accent" | "ok" };

const JUNO = "juno, assistant";
const ATTORNEY = "An attorney (a role)";

const payment: Def = { id: "payment", name: "On payment", trigger: "A payment is received", triggerCode: "on: 'event', event: 'payment.received'", v: 2, last: "2 h ago", state: "On", from: "Estate planning matter", hash: "b7e21c",
  steps: [
    { id: "find", kind: "find", label: "Find or create the matter for the payer", who: "Vyre", args: "type: 'matter', where: 'record.client == trigger.client'" },
    { id: "stage", kind: "stage", label: "Set its stage to Intake", who: "Vyre", args: "type: 'matter', to: 'Intake'" },
  ] };
const intake: Def = { id: "intake", name: "Intake", trigger: "A matter enters Intake", triggerCode: "on: 'stage', type: 'matter', stage: 'Intake'", v: 3, last: "Today 8:40", state: "On", from: "Estate planning matter", hash: "0d95a3",
  steps: [
    { id: "assign", kind: "assign", label: "Assign @Intake to collect the facts", who: JUNO, args: "to: 'teammate:intake', title: 'Collect the facts'" },
    { id: "wait", kind: "wait", label: "Wait until the facts are marked done", who: "Vyre", args: "event: 'task.completed'" },
    { id: "stage", kind: "stage", label: "Set its stage to Engagement", who: "Vyre", args: "type: 'matter', to: 'Engagement'" },
  ] };
const engagement: Def = { id: "engagement", name: "Engagement", trigger: "A matter enters Engagement", triggerCode: "on: 'stage', type: 'matter', stage: 'Engagement'", v: 3, last: "Today 9:12", state: "On", from: "Estate planning matter", hash: "4c1e9a",
  steps: [
    { id: "ask", kind: "ask", label: "Ask an attorney to approve the engagement letter", who: ATTORNEY, args: "to: 'role:attorney', title: 'Approve the engagement letter'" },
    { id: "send", kind: "call", label: "Send the letter for signature, waiting for approval", who: "Vyre", outward: true, args: "action: 'docs.send_for_signature'" },
    { id: "sign", kind: "wait", label: "Wait until the document is signed", who: "Vyre", args: "event: 'document.signed'" },
    { id: "stage", kind: "stage", label: "Set its stage to Drafting", who: "Vyre", args: "type: 'matter', to: 'Drafting'" },
  ] };
const engineer: Def = { id: "engineer", name: "Client payment to Drafting", trigger: "A payment is received", triggerCode: "on: 'event', event: 'payment.received'", v: 1, last: "Not run yet", state: "On", from: "@Engineer", hash: "e82f60",
  steps: [
    { id: "find", kind: "find", label: "Find or create the matter", who: "Vyre", args: "type: 'matter'" },
    { id: "repeat", kind: "decide", label: "Is this a repeat client?", who: "Vyre", args: "if: 'len(steps.find.rows) > 1'",
      then: [{ id: "tell", kind: "assign", label: "Tell the manager it is a repeat client", who: "A manager (a role)", args: "to: 'role:manager', title: 'Repeat client'" }] },
    { id: "assign", kind: "assign", label: "Assign @Intake to collect the facts", who: JUNO, args: "to: 'teammate:intake', title: 'Collect the facts'" },
    { id: "ask", kind: "ask", label: "Ask an attorney to approve the letter", who: ATTORNEY, args: "to: 'role:attorney', title: 'Approve the letter'" },
    { id: "send", kind: "call", label: "Send the engagement letter, waiting for approval", who: "Vyre", outward: true, sealed: true, args: "action: 'docs.send_for_signature'" },
    { id: "sign", kind: "wait", label: "Wait until it is signed", who: "Vyre", args: "event: 'document.signed'" },
    { id: "stage", kind: "stage", label: "Set its stage to Drafting", who: "Vyre", args: "type: 'matter', to: 'Drafting'" },
  ] };

export type Proposal = { title: string; diff: { t: "a" | "d" | "c"; s: string }[]; sim: { runs: number; asks: number; letters: number; matters: number }; tests: string; asked: string; reply: string };
export type KitCard = { id: string; name: string; v: number; blurb: string; adds: { types: number; flows: number; views: number; roles: number }; notes: string[]; space: string };
export type KitUpdate = { id: string; name: string; from: number; to: number; diff: { t: "a" | "d" | "c"; s: string }[]; people: string[]; widenings: { part: string; what: string }[]; sim: string };

export const flowsRepo = {
  flows(): Def[] { return [payment, intake, engagement]; },
  engineerFlow(): Def { return engineer; },
  /** Runs of a Flow, newest first. `at` is the step a run waits at, or null when it finished. */
  runs(flow: string): Run[] {
    if (flow !== "engagement") return [{ id: "run-a", title: "Run 12, Roe succession plan", started: "Yesterday", state: "done", at: null, note: "Done", tone: "ok" }];
    return [
      { id: "r41", title: "Run 41, Doe estate plan", started: "Today 9:12", state: "waiting", at: "ask", note: "Waiting on you", tone: "accent" },
      { id: "r40", title: "Run 40, Roe succession plan", started: "Yesterday", state: "done", at: null, note: "Done", tone: "ok" },
      { id: "r39", title: "Run 39, Lee trust amendment", started: "Mon 28 Sep", state: "done", at: null, note: "Done", tone: "ok" },
    ];
  },
  simulation(): string { return "This Flow would have run 14 times and asked for 3 approvals. It would have sent 14 letters through the Gate."; },
  proposal(): Proposal {
    return {
      title: "Proposal 7: Client payment to Drafting",
      asked: "When a client pays, make the matter, have Intake collect the facts, ask an attorney to approve the letter, send it for signature, and move the matter to Drafting when it is signed. Add a signed-on date to Matter.",
      reply: "I read that as one new Flow and one new field on Matter. Nothing goes live until you approve it.",
      diff: [
        { t: "c", s: "kit \"estate-planning\" v3 -> v3.1" },
        { t: "a", s: "flow \"Client payment to Drafting\"" },
        { t: "a", s: "  when payment.received" },
        { t: "a", s: "  find or create Matter, stage = Intake" },
        { t: "a", s: "  assign @Intake \"Collect facts\", wait done" },
        { t: "a", s: "  ask role:attorney \"Approve letter\"" },
        { t: "a", s: "  call docs.send_for_signature, wait document.signed" },
        { t: "a", s: "  stage = Drafting" },
        { t: "d", s: "flow \"On payment\" (replaced)" },
        { t: "a", s: "type Matter: engagement_signed: date" },
      ],
      sim: { runs: 14, asks: 3, letters: 14, matters: 14 },
      tests: "6 of 6 passed",
    };
  },
  kits(): { installed: KitCard[]; available: KitCard[] } {
    return {
      installed: [{ id: "estate", name: "Estate planning matter", v: 3, blurb: "Matters, stages, the engagement Flows and the letter templates.", adds: { types: 2, flows: 3, views: 4, roles: 1 }, notes: [], space: "Juniper Studio" }],
      available: [
        { id: "pi", name: "PI intake", v: 2, blurb: "Personal injury intake, medical records and liens.", adds: { types: 2, flows: 3, views: 3, roles: 1 }, notes: ["Some Flows send or publish. Each one still asks, or a person approves each run, according to your rules.", "Sealed fields are in play: assistants only ever see placeholders."], space: "Juniper Studio" },
        { id: "re", name: "Real estate deals", v: 1, blurb: "Deals by stage, closings and escrow tasks.", adds: { types: 2, flows: 2, views: 3, roles: 0 }, notes: ["Assistants start from this Kit's own instructions, which count as outside text until you have read them."], space: "Juniper Studio" },
      ],
    };
  },
  kitUpdate(id: string): KitUpdate | null {
    if (id !== "estate") return null;
    return {
      id, name: "Estate planning matter", from: 3, to: 4,
      diff: [
        { t: "c", s: "kit \"estate-planning\" v3 -> v4" },
        { t: "c", s: "  type Matter" },
        { t: "a", s: "    funding_date: date" },
        { t: "c", s: "    stage: Stage[Intake, Engagement, Drafting, Signing, Funding, Closed]" },
        { t: "c", s: "  flow \"Engagement\"" },
        { t: "c", s: "    ask role:attorney \"Approve letter\"" },
        { t: "a", s: "    ask role:paralegal \"Check conflicts\"" },
        { t: "c", s: "  view \"Matters board\"" },
        { t: "a", s: "    card: funding_date" },
        { t: "a", s: "role \"Paralegal\"" },
      ],
      people: ["1 new field on 6 matters", "1 more approval in Engagement", "Nothing is removed"],
      widenings: [{ part: "role Paralegal", what: "a new role holding 2 abilities" }, { part: "flow Engagement", what: "now asks the Paralegal role to check conflicts" }],
      sim: "14 more approvals would have been asked, from the new Paralegal role.",
    };
  },
};
