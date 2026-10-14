// The onboarding prototype's flow map and its pretend answers. Pure: no screen code here, so a test can walk every path.
// Real answers will come from the box and the identity service; here a few typed values stand in for them, and each screen says which.

export const WORDS = ["river", "amber", "stone", "quiet"];
export const SIGNIN_WORDS = ["otter", "lantern", "maple"];
export const DEMO = {
  signInCode: "K7QM-4P2X",
  recoveryCode: "KIT-7QMK-4P2X-9TBN",
  master: "correct horse battery",
  spaceCode: "WINK-7QMK-4P2X",
};
const TAKEN = ["alex", "jordan", "harper", "admin", "vyre"];
const KNOWN = ["alex", "jordan", "harper"];

/** Every screen, its step name (null when it is not a step) and the screens it can lead to. The test walks this map. */
export const SCREENS = {
  start: { step: null, to: ["id.choice", "space.choice"] },
  "id.choice": { step: "Identity", to: ["id.signin", "id.new", "master.enter"] },
  "id.signin": { step: "Identity", to: ["id.approve"] },
  "id.approve": { step: "Identity", to: ["master.enter", "id.recover", "space.choice"] },
  "id.recover": { step: "Identity", to: ["master.enter", "master.set", "id.approve", "space.choice"] },
  "id.new": { step: "Identity", to: ["id.kit"] },
  "id.kit": { step: "Identity", to: ["vault.intro", "space.choice"] },
  "vault.intro": { step: "Vault", to: ["master.set"] },
  "master.set": { step: "Vault", to: ["master.confirm"] },
  "master.confirm": { step: "Vault", to: ["inf.pick"] },
  "master.enter": { step: "Vault", to: ["inf.pick", "id.recover"] },
  "inf.pick": { step: "Inference", to: ["inf.key", "space.choice", "compute", "ready"] },
  "inf.key": { step: "Inference", to: ["inf.pick"] },
  "space.choice": { step: "Space", to: ["create.name", "join.code"] },
  "create.name": { step: "Space", to: ["create.members"] },
  "create.members": { step: "Space", to: ["create.server"] },
  "create.server": { step: "Space", to: ["create.run"] },
  "create.run": { step: "Space", to: ["create.code"] },
  "create.code": { step: "Space", to: ["create.confirm"] },
  "create.confirm": { step: "Space", to: ["create.setup", "create.code"] },
  "create.setup": { step: "Space", to: ["compute", "ready", "vault.intro", "master.enter", "master.set"] },
  "join.code": { step: "Space", to: ["join.review"] },
  "join.review": { step: "Space", to: ["join.sealing"] },
  "join.sealing": { step: "Space", to: ["compute", "ready", "vault.intro", "master.enter", "master.set"] },
  compute: { step: "Compute", to: ["ready"] },
  ready: { step: "Ready", to: ["invite.who", "start"] },
  "invite.who": { step: null, to: ["invite.link"] },
  "invite.link": { step: null, to: ["invite.words", "invite.done"] },
  "invite.words": { step: null, to: ["invite.done"] },
  "invite.done": { step: null, to: ["ready", "invite.who"] },
};

/** The two people GitHub can be in the prototype: one already linked to the name alex, one new to Vyre. */
export const GITHUB_MOCK = {
  linked: { id: 4242, login: "alex-gh", displayName: "Alex Rivera", avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4", linkedName: "alex" },
  fresh: { id: 9001, login: "sam-builds", displayName: "Sam Okafor", avatarUrl: "https://avatars.githubusercontent.com/u/9001?v=4" },
};
/** A name for a new person from their GitHub login: the form the directory takes, or empty when the login does not fit. */
export const nameFromLogin = (login) => { const n = String(login ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 20); return /^[a-z][a-z0-9-]{2,19}$/.test(n) ? n : ""; };
/** Where Continue with GitHub leads: a linked id goes to the master password, a new one to choosing a name. */
export const afterGithub = (user) => (user && user.linkedName ? "master.enter" : "id.new");

/** Whether this device and this space run sessions here: a computer, and a space that allows it. */
export const asksCompute = (ctx) => ctx.device === "computer" && ctx.allowed;
/** The screen after the Space step. */
export const afterSpace = (ctx) => (asksCompute(ctx) ? "compute" : "ready");
/**
 * A new device with no server yet (no pairing). The personal vault lives on a server, so Vault cannot come before one exists: such a device goes Identity, Space, Vault, Inference, and then on. A device that
 * already has a pairing (`paired` true or not said) keeps the order Identity, Vault, Inference, Space. Adding a space later is always paired.
 */
export const isUnpaired = (ctx) => ctx.paired === false && !ctx.later;
const VAULT_ENTRIES = ["vault.intro", "master.enter", "master.set"];
/**
 * Where a move to `to` really goes, and what to remember. Pure: OnboardFlow calls it for every move. Paired devices are never redirected. On an unpaired one: the first move into the Vault is held (the screen is
 * remembered in `vaultEntry`) and the person is taken to the Space step; leaving the Space step for Compute or Ready goes to the held Vault screen instead; reaching Inference marks the Vault done; and leaving
 * Inference (which leads back to the Space step in the paired order) goes on to Compute or Ready.
 * @param {{ paired?: boolean, later?: boolean, vaultEntry?: string, vaultDone?: boolean, spaceDone?: boolean, device?: string, allowed?: boolean }} ctx
 * @param {string} to @returns {{ to: string, patch: Record<string, unknown> }}
 */
export function route(ctx, to) {
  if (!isUnpaired(ctx)) return { to, patch: {} };
  if (VAULT_ENTRIES.includes(to) && !ctx.spaceDone && !ctx.vaultEntry) return { to: "space.choice", patch: { vaultEntry: to } };
  if ((to === "compute" || to === "ready") && ctx.vaultEntry && !ctx.vaultDone) return { to: ctx.vaultEntry, patch: { spaceDone: true } };
  if (to === "inf.pick" && !ctx.vaultDone) return { to, patch: { vaultDone: true } };
  if (to === "space.choice" && ctx.spaceDone && ctx.vaultDone) return { to: afterSpace(ctx), patch: {} };
  return { to, patch: {} };
}
/**
 * Opening setup again on a device that already holds an identity but has no server (the person stopped at the Vault): there is nothing left to do in Identity and the vault cannot be made without a server, so
 * setup opens on the Space step, with the Vault held for after it. `null` when this does not apply (a server exists, no identity is kept, or a join or create link chose the entry itself).
 * @param {{ hasServer: boolean, identityName: string, entry?: string }} o @returns {{ stack: string[], patch: Record<string, unknown> } | null}
 */
export function resumeAt({ hasServer, identityName, entry }) {
  if (hasServer || !identityName || entry) return null;
  return { stack: ["space.choice"], patch: { paired: false, name: identityName, vaultEntry: "vault.intro" } };
}
/** The steps of the flow this person is in: all six on a new device, three when adding a space later, Compute only where it is asked. A device with no server puts Space before Vault. */
export function stepLabels(ctx) {
  const all = ctx.later ? ["Space", "Compute", "Ready"] : isUnpaired(ctx) ? ["Identity", "Space", "Vault", "Inference", "Compute", "Ready"] : ["Identity", "Vault", "Inference", "Space", "Compute", "Ready"];
  return asksCompute(ctx) ? all : all.filter((s) => s !== "Compute");
}

/** What the Vault step says when the box cannot be reached: a device with no server has none to reach, which is not a connection problem. */
export const NO_SERVER_SAY = "Vyre keeps your vault on a server, and this device has none yet. Add a server first.";
export const NO_BOX_SAY = "Vyre cannot reach your vault yet, so nothing was saved. Check your connection, then try again.";
/** @param {boolean} paired */
export const unreachableSay = (paired) => (paired ? NO_BOX_SAY : NO_SERVER_SAY);

// Pretend answers. Each returns the word the screen turns into a sentence.
export const nameStatus = (n) => { const s = String(n ?? "").trim().toLowerCase(); return !s ? "empty" : !/^[a-z][a-z0-9-]{2,19}$/.test(s) ? "invalid" : TAKEN.includes(s) ? "taken" : "free"; };
export const knownName = (n) => KNOWN.includes(String(n ?? "").trim().toLowerCase());
export const recoveryStatus = (c) => (c === DEMO.recoveryCode ? "ok" : "wrong");
export const masterStatus = (pw, expected) => (pw === (expected || DEMO.master) ? "ok" : "wrong");
export const apiKeyStatus = (k) => (/^sk-[A-Za-z0-9_-]{8,}$/.test(String(k ?? "").trim()) ? "ok" : "bad");
export const spaceCodeStatus = (c) => (c === DEMO.spaceCode ? "ok" : c === "WINK-0000-0000" ? "expired" : "wrong");
export const inviteStatus = (t) => { const s = String(t ?? "").trim(); return s.length < 8 ? "short" : /expired/i.test(s) ? "expired" : "ok"; };
export const wordsMatch = (typed) => String(typed ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean).join(" ") === WORDS.join(" ");
/** The subdomain a space name makes: "Harlow Legal" is harlow-legal. */
export const addressOf = (n) => String(n ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);

/** Every screen reachable from `from`, by breadth first. */
export function reach(from = "start") {
  const seen = new Set([from]);
  const q = [from];
  while (q.length) for (const t of SCREENS[q.shift()]?.to ?? []) if (!seen.has(t)) { seen.add(t); q.push(t); }
  return seen;
}
