// The one door the /u screens use to read and write the real box: the box's own tools through
// src/api/box (POST /v1/tools/<name> over the paths layer). The sample data stays for development:
// it is on only when EXPO_PUBLIC_VYRE_MOCK=1; otherwise a screen shows what the box answers, an empty
// state when it has nothing, and an error line when it cannot be reached. Never sample people.

import { REUSE_OPS } from "../../../../lib/one-yes-ops.js";
import { call } from "../api/box";
import { ACTIVE, peerCall, peerWanted } from "./peer";
import { claimBlocked } from "../../screens/shell/rc";
import { needsPerson, onPhoneFor, reasonLine, softwareKeyLine } from "./on-phone.js";
import { APPROVE_ON_PHONE, actWords, askPhone, endLine, heldAsk, phoneRoute, proofHeader, askYes } from "./approvals.js";
import { useApproval } from "./approval-state";
import { Platform } from "react-native";
import { isApprovalList, isEveryServer, urnSpace } from "./server-route.js";
import { NOT_FOR_MEMBERS_YET, SPACE_TOOLS, chatSpace, isTeamWork, memberChatWire, withSpace } from "./with-space.js";
import { phoneSigner } from "./phone-signer";
import { payloadHash } from "./payload-hash.js";
import { loadIdentity } from "../identity/store";
import { useSpaces } from "../../screens/shell/state";
import { mockTools } from "./mock-templates";
import { mockAgentTools } from "./mock-agents";
import { mockDocumentTools } from "./mock-documents";
import { mockMcpTools } from "./mock-mcp";

/** True only in a development build started with EXPO_PUBLIC_VYRE_MOCK=1. */
export const MOCK: boolean = typeof process !== "undefined" && process.env.EXPO_PUBLIC_VYRE_MOCK === "1";

export class BoxError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message || code);
    this.code = code;
  }
}

/** One tool call; resolves the data, throws BoxError with the box's own code and words. */
/** A reveal, a copy or a code asks for the five-minute reuse (lib/one-yes.js REUSE_OPS). */
const REUSE_TOOLS = new Set<string>(REUSE_OPS);
/** The words a screen shows while the phone is asked. */
export const WAITING_TITLE = APPROVE_ON_PHONE;
/**
 * A stand-in for the box, for the gallery's pictures of screens that read the real box (the Vault): it answers each tool from recorded answers (scripts/capture-vault-fixtures.mjs) so a screen is
 * shot with real shapes and no box behind it. Never set in the app itself; only the /gallery route sets it.
 */
let override: ((name: string, input: Record<string, unknown>) => Promise<unknown>) | null = null;
/** True while a stand-in box is set (the gallery's and the tests'): screens that call through the app's own connection use `tool` instead so the stand-in answers. */
export const hasBoxOverride = (): boolean => override !== null;
export function setBoxOverride(f: ((name: string, input: Record<string, unknown>) => Promise<unknown>) | null) { override = f; }

/**
 * A call that names its server: the Space-making calls (spaces.name-here, spaces.host-here) name a server and no Space yet. Where a device is paired to several servers `server` is the server's box id and the
 * call goes down that server's own wire; on the computer whose own daemon is the door it is the paired server's id, which the daemon's tool takes as `server`. Every other call follows the Space it is for.
 */
/** The chat id out of what work.chat.create answered (its id, chat or urn). */
const chatIdOfAnswer = (r: unknown): string => { const x = r as { chat?: unknown; id?: unknown; urn?: unknown } | null; const v = [x?.chat, x?.id, x?.urn].find((y) => typeof y === "string") as string | undefined; const m = v ? /\/chat\/([^/?#]+)$/.exec(v) : null; return m ? m[1] : v ?? ""; };

export type ToolOptions = { server?: string };

export async function tool<T = unknown>(name: string, given: Record<string, unknown> = {}, opts: ToolOptions = {}): Promise<T> {
  if (MOCK && mockTools[name]) return mockTools[name](given) as T; // the sample build answers the template tools from memory (mock-templates.ts)
  if (MOCK && mockAgentTools[name]) return mockAgentTools[name](given) as T; // and the agent page's (mock-agents.ts)
  if (MOCK && mockDocumentTools[name]) return mockDocumentTools[name](given) as T; // and the record page's Documents bar (mock-documents.ts)
  if (MOCK && mockMcpTools[name]) return mockMcpTools[name](given) as T; // and the AI keys screen's (mock-mcp.ts)
  if (override) return (await override(name, given)) as T;
  // A team member has no session of their own on the team's server: their chats go through the Space's own door (the chat service, kernel/remote), with their own chain there.
  const wire = memberChatWire(name);
  if (wire) {
    const space = chatSpace(given, useSpaces.getState().space);
    const team = space ? await import("./team-join") : null;
    if (space && team && (await team.joinedHere(space))) {
      const { space: _named, ...rest } = given;
      try { return (await team.teamCall(space, wire, [rest])) as T; }
      catch (e) { const x = e as { code?: string; message?: string }; throw new BoxError(x.code ?? "error", x.message ?? ""); }
    }
  }
  // A team the person joined is showing and this is the team's own work with no door call for her: it never goes to her own home as if it were the team's.
  if (!wire && isTeamWork(name)) {
    const space = chatSpace(given, useSpaces.getState().space);
    if (space && (await (await import("./team-join")).joinedHere(space))) throw new BoxError("not_allowed", NOT_FOR_MEMBERS_YET);
  }
  // Every call that acts in a space names it: the one the screen gave, else the one showing (nothing under All spaces).
  let input = withSpace(name, given, useSpaces.getState().space);
  // A device paired to its server over the relay (device-first install) calls it over the peer wire: the server runs the call as this device with its paired session.
  if (peerWanted()) {
    // With several servers paired, the call goes to the one that hosts its Space (or the one it names); one pairing goes where it always went.
    const { routeCall, listAllSpaces, listAllChats, noteChat, noteItems } = await import("./space-servers");
    // The list of Spaces is every server's, so the switcher shows them all (each row says which server it is on).
    if (name === "spaces.list" && !opts.server) { const all = await listAllSpaces(); if (all) return all as T; }
    // The approvals inbox is every server's, and the phone's push token goes to every server (one that was down is named by pushMissed).
    if (isApprovalList(name) && !opts.server) { const all = await (await import("./space-servers")).listAllApprovals(name, input); if (all) return all as T; }
    if (isEveryServer(name) && !opts.server && (await import("../api/relay").then((m) => m.listPairings())).length > 1) return (await import("./space-servers")).callEvery<T>(name, input);
    const route = await routeCall({ tool: name, input: given, showing: useSpaces.getState().space, server: opts.server });
    if (route.error) throw new BoxError(route.error.code, route.error.message);
    const to = route.box;
    // an id-only action goes with the Space its id was seen in, not the one that happens to be showing
    if (route.space && SPACE_TOOLS.has(name)) input = { ...input, space: route.space };
    // a record address names its own Space: that is the one the call carries, not the one that happens to be showing
    else if (urnSpace(given) && SPACE_TOOLS.has(name) && !given.space) input = { ...input, space: urnSpace(given) };
    // The chats list is every server's under All spaces. A new chat belongs to a Space on one server, so with several servers it is made only when a Space is showing (never guessed onto the active one).
    if (name === "work.chat.list" && !to && !opts.server) { const all = await listAllChats(input); if (all) return all as T; }
    if (name === "work.chat.create" && !to && !opts.server && (await import("../api/relay").then((m) => m.listPairings())).length > 1) throw new BoxError("pick_a_space", "Pick the Space this chat is for first, then start it. A chat belongs to one Space on one server. Nothing was made.");
    try { const out = await peerCall<T>(name, input, to ?? ACTIVE); if (name === "work.chat.create") noteChat(chatIdOfAnswer(out), to); else noteItems(out, typeof input.space === "string" ? input.space : undefined); return out; }
    catch (e) {
      const x = e as { code?: string; message?: string; detail?: unknown };
      // An act held for the owner's yes: the phone approves it, the server runs it, and the result comes back here (no proof is carried by this browser).
      const held = heldAsk(x, name, input);
      // The same act again with the approval id beside it, as an extra input key on the peer wire (the door strips it before the tool sees it).
      if (held) return yesThenRetry<T>(held, (t, i) => peerCall<any>(t, i ?? {}, to ?? ACTIVE), (approval) => peerCall<T>(name, { ...input, approval }, to ?? ACTIVE));
      throw new BoxError(x.code ?? "error", x.message ?? "");
    }
  }
  // On the computer whose own daemon is the door, a call that names a server hands it on as `server` (the daemon asks that paired server).
  if (opts.server) input = { ...input, server: opts.server };
  let r = await call<T>(name, input).catch((e: Error) => ({ error: { code: "offline", message: e.message } }) as const);
  // The relay says the owner removed this device: it forgets everything it held and pairs again.
  if (r.error?.code === "relay_removed") await (await import("../identity/removed")).ifRemoved("relay_removed");
  // A kernel act a person signs (a rule, say), asked from the web app: the paired phone approves it ("Approve on your phone"), then the act goes again with the proof it signed.
  if (r.error && Platform.OS === "web" && phoneRoute(name, r.error, input)) {
    const space = typeof input.space === "string" && input.space ? input.space : String(((await call<{ space?: string }>("records.me")).data as { space?: string } | undefined)?.space ?? "");
    const st = useApproval.getState();
    const ask = (t: string, i?: Record<string, unknown>) => call<any>(t, i ?? {}).then((x) => { if (x.error) throw new BoxError(x.error.code ?? "error", x.error.message ?? ""); return x.data; });
    st.show(actWords(name));
    try {
      const out = await askPhone(ask, { tool: name, input, space, signal: st.signal });
      if ("ended" in out) throw new BoxError("not_approved", endLine(out.ended));
      r = await call<T>(name, input, { kernelProof: proofHeader(out.proof) }).catch((e: Error) => ({ error: { code: "offline", message: e.message } }) as const);
    } finally { useApproval.getState().hide(); }
  }
  // On the phone, whose own key is the person's: a signed yes over exactly the act the box named (x-vyre-yes). A device cannot answer its own card, so the phone says yes itself. The key asks Face ID or the
  // fingerprint; a reveal, a copy or a code signs the wish to reuse it for five minutes too.
  if (r.error?.code === "presence_required" && Platform.OS !== "web") {
    const sg = (r.error as { sign?: { op: string; space: string; fields: Record<string, unknown> } }).sign;
    const signer = sg ? await phoneSigner() : null;
    const person = signer ? (await loadIdentity())?.id : undefined;
    if (signer && sg && person) {
      const fields = REUSE_TOOLS.has(name) ? { ...sg.fields, reuse: true } : sg.fields;
      let header: string;
      try {
        const proof = await signer.signPresence({ op: sg.op, space: sg.space, fields: fields as Record<string, any>, payload_hash: payloadHash(sg.op, sg.space, fields), prompt: actWords(name), person });
        header = proofHeader(proof);
      } catch (e) { throw new BoxError("cancelled", (e as Error).message || "Nothing was approved."); }
      r = await call<T>(name, input, { yes: header }).catch((e: Error) => ({ error: { code: "offline", message: e.message } }) as const);
    }
  }
  // An act that needs the person's yes (the box answers presence_required with the moment and the exact request): ask a card, the person's phone (or this device's passkey, or this computer's Touch ID)
  // says yes, then the act is sent again with the approval id in the x-vyre-approval header (never inside the tool's own input).
  if (r.error && (r.error.code === "held" || r.error.code === "presence_required")) {
    const held = heldAsk(r.error, name, input);
    if (held) {
      const raw = async (t: string, i?: Record<string, unknown>) => { const x = await call<any>(t, i ?? {}); if (x.error) throw Object.assign(new Error(x.error.message), { code: x.error.code }); return x.data; };
      return yesThenRetry<T>(held, raw, async (approval) => { const x = await call<T>(name, input, { approval }); if (x.error) throw Object.assign(new Error(x.error.message), { code: x.error.code }); return x.data as T; });
    }
  }
  // RC1: a browser does not answer a person-only ask (vault secrets, pairing a device, an outbound send): the person does it in Vyre on their phone.
  if (r.error && claimBlocked() && needsPerson(r.error)) throw new BoxError("on_phone", onPhoneFor(name));
  // A presence proof made with a software key (a computer's key file) is refused on a release server: the person approves it on their phone, in our words.
  if (r.error?.code === "software_key") throw new BoxError("software_key", softwareKeyLine());
  // A refused proof on an approval says why in error.detail.reason (expired, replayed, wrong request...): each has its own sentence.
  if (r.error?.code === "needs_presence") {
    const line = reasonLine((r.error as { detail?: { reason?: string } }).detail?.reason);
    if (line) throw new BoxError("needs_presence", line);
  }
  if (r.error) throw new BoxError(r.error.code ?? "error", r.error.message ?? "");
  return r.data as T;
}

/**
 * A browser whose identity key is a passkey is its own person's device: it says its yes itself, by signing the card it just opened with the passkey (the proof is the kernel's, shaped like a phone's).
 * Anything else, or any failure, leaves the ask for the owner's phone.
 */
async function answerWithPasskey(ask: (tool: string, input?: Record<string, unknown>) => Promise<any>, id: string): Promise<void> {
  if (Platform.OS !== "web") return;
  const { passkeySelf } = await import("./passkey-self");
  await passkeySelf(ask, id);
}

/** On the person's own computer (the Mac window), Touch ID gives the yes at once; anywhere else this refuses and the card stays for the phone. */
async function answerHere(ask: (tool: string, input?: Record<string, unknown>) => Promise<any>, id: string): Promise<void> {
  await ask("approvals.local-yes", { id }).catch(() => {});
}

/** An act that needs the owner's yes: ask the phone, wait with "Approve this in Vyre on your phone" and Stop waiting, then send the act again with the approval id (spent once). */
async function yesThenRetry<T>(held: { moment: string; request: unknown }, ask: (tool: string, input?: Record<string, unknown>) => Promise<any>, retry: (approval: string) => Promise<T>): Promise<T> {
  const st = useApproval.getState();
  st.show(softwareKeyLine());
  try {
    const out = await askYes(ask, { moment: held.moment, request: held.request, signal: st.signal, onAsked: async (id) => { await answerHere(ask, id); await answerWithPasskey(ask, id); }, onWaiting: (line) => { if (line) useApproval.getState().show(line); } });
    if ("ended" in out) throw new BoxError("not_approved", endLine(out.ended));
    return await retry(out.approval);
  } catch (e) {
    if (e instanceof BoxError) throw e;
    const x = e as { code?: string; message?: string };
    throw new BoxError(x.code ?? "error", x.message ?? "");
  } finally { useApproval.getState().hide(); }
}

/** The words to show for a failed call. */
export const said = (e: unknown): string => (e instanceof Error && !(e instanceof BoxError) && typeof (e as { code?: unknown }).code === "string" ? e.message : e instanceof BoxError ? (e.code === "offline" || /no JSON/i.test(e.message) ? "Cannot reach your server right now." : /anonymous callers/i.test(e.message) ? "This browser is not signed in to your server yet. Pair it first." : e.message) : "Something went wrong.");
