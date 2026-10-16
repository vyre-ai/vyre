// The Space step's real calls. Everything here is an existing piece of the app: the add-a-server run (add-server-bind.ts), the typed-code pairing (devices/TypeCode.tsx), the space on the
// paired server (install.ts makeServerSpace), the vault tools, the invite pieces (team-join.ts, devices/invite.js) and the space's own-compute rule. No new server logic. The screens call these only when MOCK is off.
// What a flow keeps between screens (the server run, the space just made or joined) lives here, because the prototype's ctx has no field for it.

import { useEffect, useState } from "react";
import { MOCK, said, tool } from "../../src/real/box";
import { startAddServer, type AddServerState } from "../../src/real/add-server-bind";
import { addressOf } from "./flow-model.js";
import { allowedOf, refusal } from "../spaces/computers-model.js";
import { emailIt, madeNote } from "../devices/invite.js";

export const LIVE = !MOCK;

/** The words for a failure: a code the app knows, else what the box said. */
export const whyNot = (e: unknown): string => said(e);

// ---- one small store, so a screen can read what an earlier screen started ----

function store<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => { value = v; subs.forEach((f) => f()); },
    use: (): T => { const [, n] = useState(0); useEffect(() => { const f = () => n((x) => x + 1); subs.add(f); return () => { subs.delete(f); }; }, []); return value; },
  };
}

// ---- the server: the add-a-server run (one install line, then the pairing) ----

const runState = store<AddServerState | null>(null);
let run: Awaited<ReturnType<typeof startAddServer>> | null = null;

/** Starts the run for a Linux server or a Mac. A run already going is kept, so a screen coming back does not throw the line away. */
export async function beginServerRun(kind: "cloud" | "mac") {
  const place = kind === "mac" ? "mac" : "linux";
  const opened = await tool<{ command?: string }>("onboard.space.open", { kind: place });
  run?.stop();
  run = null;
  runState.set({ stage: "install", choice: place, installLine: String(opened?.command || ""), code: "", lines: [], box: null, memoryMb: null, note: null, error: null, expiresAt: 0 });
}
export const useServerRun = () => runState.use();
export const confirmServerWords = () => run?.confirmWords();
export const denyServerWords = () => run?.denyWords();
export const stopServerRun = () => { run?.stop(); run = null; };

/** A server joins from the install command (onboard.space.open). There is no code to type. */
export async function pairByCode(_code: string, _onAck: (ack: string, expires?: number) => void) {
  throw Object.assign(new Error("The install command is how a server joins. There is no code to type."), { code: "bad_input" });
}

// ---- the space on that server ----

export type ActiveSpace = { id: string; slug: string; name: string };
const active = store<ActiveSpace | null>(null);
export const useActiveSpace = () => active.use();

/**
 * Make the space on the paired server, then its vault, then say whether members may use their own computers.
 * The space vault has no password of its own: vault.vaults.create makes the shared vault with this person as its owner, and it opens with their own master password.
 */
export async function setUpSpace(o: { spaceName: string; membersOwnComputers: boolean }, onStep: (i: number) => void): Promise<ActiveSpace> {
  const slug = addressOf(o.spaceName);
  const { makeServerSpace } = await import("../../src/real/install");
  onStep(0);
  const id = await makeServerSpace(slug, o.spaceName.trim());
  const made = { id, slug, name: o.spaceName.trim() };
  active.set(made);
  onStep(1);
  const v = await tool<{ locked?: boolean }>("vault.state").catch(() => null);
  if (v?.locked) throw Object.assign(new Error("Your vault is locked here. Unlock it with your master password, then try again."), { code: "vault_locked" });
  await tool("vault.vaults.create", { name: slug });
  onStep(2);
  await tool("spaces.members.computers", { space: id, allow: o.membersOwnComputers });
  return made;
}

// ---- joining ----

/** `role` is what the screens branch on (admin or member); `roleWord` is the invite's own role, shown as it is. */
export type JoinCard = { link: string; space: string; label: string; role: "member" | "admin"; roleWord: string; words: string[] };
const card = store<JoinCard | null>(null);
export const useJoinCard = () => card.use();
export const joinCard = () => card.get();

/** A pasted invite link, checked the same way onboard.space.join checks it. There is no code to type. */
export async function linkFromInput(text: string, _onAck: (ack: string, expires?: number) => void): Promise<string> {
  const { parseInvite } = await import("../../../../lib/first-run-shape.js");
  const parsed = parseInvite(text.trim());
  if (!parsed) throw Object.assign(new Error("That link does not open a space. Ask for a new invite."), { code: "bad_input" });
  return parsed.link;
}

/** The card for an invite: the space, the role and the space's four words. The inviter's name is not on the card the server gives, so the screen shows none. */
export async function readInvite(link: string): Promise<JoinCard> {
  const c = await tool<{ link?: string; role?: string; space?: string | null }>("onboard.join.read", { link });
  const role = c.role === "admin" || c.role === "owner" ? "admin" : "member";
  const made: JoinCard = { link: String(c.link || link), space: String(c.space || ""), label: String(c.space || ""), role, roleWord: String(c.role || "member"), words: [] };
  card.set(made);
  return made;
}

/** The person's yes. Then the space's rule for their own computer is read, so the Compute step shows only where the space allows it. */
export async function joinSpace(link: string): Promise<{ allowed: boolean }> {
  const { acceptInvite } = await import("../../src/real/install");
  const r = await acceptInvite(link);
  const id = String(r?.space ?? "");
  const c = card.get();
  active.set({ id, slug: addressOf(c?.label ?? ""), name: c?.label ?? "" });
  return { allowed: await membersMayUseOwnComputers(id) };
}

// ---- compute ----

/** Whether the space lets members run sessions on their own computers. False when the space does not say, so the step is skipped rather than shown for nothing. */
export async function membersMayUseOwnComputers(space: string): Promise<boolean> {
  try { return allowedOf(await tool("spaces.members.computers", { space })) === true; } catch { return false; }
}

/** This person's choice for this computer (spaces.devices.lend). Off needs nothing. Rejects with words. */
export async function lendThisComputer(space: string, on: boolean) {
  const { loadPairing } = await import("../../src/api/relay");
  const device = (await loadPairing())?.device;
  if (!device) throw Object.assign(new Error("This computer is not paired to the space's server yet, so it cannot run sessions for it. Choose the server for now. You can change it in Settings."), { code: "no_device" });
  try { await tool("spaces.devices.lend", { space, device, on }); } catch (e) { throw Object.assign(new Error(refusal((e as { code?: string }).code, whyNot(e))), { code: (e as { code?: string }).code }); }
}

// ---- invites ----

export type MadeInvite = { id: string; link: string; code: string | null; needsConfirm: boolean };

/** Makes the invite the way the Invite screen does: this app when it keeps the name, else the box. The name is only for the inviter's list (the box takes none), so the link is for anyone who holds it. */
export async function makeInvite(role: string, _projects: string[] = [], days = 7, _levels: Record<string, string> = {}): Promise<MadeInvite> {
  const s = active.get();
  if (!s?.id) throw Object.assign(new Error("There is no space to invite people to yet. Create or join one first."), { code: "no_space" });
  const r = await tool("onboard.member.link", { space: s.id, role: role === "temp" ? "guest" : role, ttlDays: days });
  const n = madeNote(r);
  return { id: n.id, link: n.link, code: n.code, needsConfirm: n.needsConfirm };
}

/** The inviter types the four words the invitee read out (an admin invite waits for this). */
export async function confirmInviteWords(id: string, words: string) {
  const s = active.get();
  if (!s?.id) throw Object.assign(new Error("There is no space to invite people to yet."), { code: "no_space" });
  const t = await import("../../src/real/team-join");
  // The words are checked against the space's own before any confirm path, as Settings' invite does (b153908ff), then confirmed on the team wire or by the home's tool.
  await t.checkInviteWordsFor(s.id, id, words.trim(), s.name);
  return (await t.invitesHere()) ? t.confirmTeamInviteWords(s.id, id, words.trim(), s.name) : tool("spaces.invites.confirm", { space: s.id, id, words: words.trim() });
}


/** The invite just made, kept from the Invite screen to the screens that show it. */
const made = store<MadeInvite | null>(null);
export const useMadeInvite = () => made.use();
export const keepMadeInvite = (m: MadeInvite | null) => made.set(m);

/** The mail app's ready email for an invite (a mailto link; Vyre sends nothing). */
export const inviteEmail = (link: string) => emailIt(activeSpaceName(), link).mailto;
const activeSpaceName = () => active.get()?.name || "the space";
