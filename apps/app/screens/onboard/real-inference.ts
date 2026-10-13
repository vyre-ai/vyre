// The Inference screens' real calls: signing an AI account in (Claude through onboard.claude, Codex and Grok through sessions.accounts.signin, as Settings does) and adding an API key
// (sessions.accounts.key). The provider's own page does the sign-in; Vyre shows its link and takes back the code it shows, and never sees a password or token. In MOCK every call answers
// from flow-model.js, so the prototype's pretend failure still shows.

import { MOCK, tool } from "../../src/real/box";
import { aiRefusal, claudeOf, codeInput, safeLink, startInput } from "../../src/real/ai-connect.js";
import { callT } from "../../src/real/call-tool";
import { accountsSource } from "../settings/accounts-source";
import { keepFollowing, safeUrl } from "../settings/accounts-model";
import { apiKeyStatus } from "./flow-model.js";
import type { Outcome } from "./real-identity";

/** Where a sign-in stands: the provider's page to open (and the code it may show), done, or failed with the words. */
export type Step = { step: "open"; link: string; code?: string; paste: boolean } | { step: "waiting" } | { step: "done" } | { step: "retry"; say: string } | { step: "failed"; say: string };

const accounts = accountsSource(callT);
const code = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;
const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };
const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));

const failed = (provider: string, e: unknown): Step => {
  const c = code(e);
  const name = NAMES[provider] ?? "That account";
  if (c === "offline" || c === "unreachable" || c === "timeout" || c === "error" || !c) return { step: "failed", say: `Vyre could not reach your home, so ${name} was not signed in. Check your connection, then try again, or add an API key instead.` };
  if (provider === "claude") return { step: "failed", say: aiRefusal(c, "") };
  if (c === "presence_required" || c === "needs_presence") return { step: "failed", say: "That needs you. Approve on this device, then try again." };
  if (c === "denied" || c === "not_allowed") return { step: "failed", say: `${name} was not signed in. Only the owner of this home signs in an AI account. Ask them, or add an API key instead.` };
  return { step: "failed", say: `${name} did not finish signing in. Check that you are signed in to it in your browser, then try again, or add an API key instead.` };
};

/** A live sign-in, so the code the person brings back reaches the same flow. */
export type Flow = { provider: string; id: string };

/** Start a sign-in. Claude and the others differ in the calls, not in what the screen shows. */
export async function startSignIn(provider: string, tries = 0): Promise<{ flow: Flow; step: Step }> {
  const flow: Flow = { provider, id: "" };
  if (MOCK) { await slow(900); return { flow, step: provider === "grok" && tries === 0 ? { step: "failed", say: "Grok did not finish signing in. Check that you are signed in to it in your browser, then try again, or add an API key instead." } : { step: "done" } }; }
  try {
    if (provider === "claude") {
      const d = await tool<{ url?: string }>("onboard.claude", startInput());
      const link = safeLink(d?.url);
      return link ? { flow, step: { step: "open", link, paste: true } } : { flow, step: failed(provider, { code: "bad_response" }) };
    }
    const f = await accounts.start(provider);
    return { flow: { provider, id: f.id }, step: stepOf(provider, f) };
  } catch (e) { return { flow, step: failed(provider, e) }; }
}

const stepOf = (provider: string, f: { step: string; url?: string; code?: string }): Step => {
  if (f.step === "done") return { step: "done" };
  if (f.step === "failed") return failed(provider, { code: "failed" });
  if (f.url && safeUrl(f.url)) return { step: "open", link: f.url, ...(f.code ? { code: f.code } : {}), paste: f.step === "url" };
  return { step: "waiting" };
};

/** Wait on a sign-in that needs no pasted code (the person approves in the provider's page): the box holds each status call open, so this is one call per turn. */
export async function followSignIn(flow: Flow, alive: () => boolean): Promise<Step> {
  if (MOCK || !flow.id) return { step: "done" };
  try {
    for (;;) {
      const f = await accounts.follow(flow.id, flow.provider);
      if (!alive()) return { step: "waiting" };
      if (!keepFollowing(f)) return stepOf(flow.provider, f);
    }
  } catch (e) { return failed(flow.provider, e); }
}

/** The code the provider's page showed, brought back. */
export async function finishSignIn(flow: Flow, pasted: string): Promise<Step> {
  if (MOCK) return { step: "done" };
  try {
    if (flow.provider === "claude") { await tool("onboard.claude", codeInput(pasted)); return { step: "done" }; }
    await accounts.paste(flow.id, pasted);
    return { step: "waiting" };
  } catch (e) {
    if (code(e) === "bad_code" || code(e) === "invalid_code" || code(e) === "bad_input") return { step: "retry", say: "That code did not work. Copy it again from the provider's page and paste it here. Nothing was connected." };
    return failed(flow.provider, e);
  }
}

/** Is Claude already signed in on this home? Read so a person who connected earlier sees it. */
export async function claudeConnected(): Promise<boolean> {
  if (MOCK) return false;
  try { const c = claudeOf(await tool("onboard.status")); return Boolean(c?.signedIn || c?.state === "done"); } catch { return false; }
}

const KINDS: Record<string, string> = { Anthropic: "anthropic-compatible", OpenAI: "openai-compatible", OpenRouter: "openrouter" };

/** Save an API key: the box checks it with one cheap call and keeps it in the vault; it is never returned. The form is checked here first. */
export async function saveKey(kind: string, key: string): Promise<Outcome> {
  if (MOCK) { await slow(500); return apiKeyStatus(key) === "ok" ? { ok: true } : { ok: false, say: `That does not look like a ${kind} key. Keys start with sk-. Copy it again from the provider's page, or go back and sign in instead.` }; }
  const k = key.trim();
  if (k.length < 12 || /[\s\u0000-\u001f\u007f]/.test(k)) return { ok: false, say: `That does not look like a ${kind} key. Copy it again from the provider's page, with no spaces, or go back and sign in instead.` };
  try {
    await tool("sessions.accounts.key", { kind: KINDS[kind] ?? "openrouter", key: k });
    return { ok: true };
  } catch (e) {
    const c = code(e);
    if (c === "presence_required" || c === "needs_presence") return { ok: false, say: "That needs you. Approve on this device, then try again." };
    if (c === "denied") return { ok: false, say: "Only the owner of this home saves a key here. Ask them, or sign in to an account instead." };
    if (c === "offline" || c === "unreachable" || c === "timeout" || c === "error" || !c) return { ok: false, say: "Vyre could not reach your home, so the key was not saved. Check your connection, then try again." };
    return { ok: false, say: `The ${kind} key did not work, so it was not saved. Check that it is the right key and has credit, then try again.` };
  }
}
