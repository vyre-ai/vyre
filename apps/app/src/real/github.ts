// Continue with GitHub, behind small doors. In MOCK it answers from flow-model.js. Otherwise it talks to the relay (relay/worker/github.js) and the escrow it fronts:
//   signInWithGithub()   the browser goes to GitHub and back with a one-use ticket; the relay says who GitHub says this is and which Vyre name, if any, is linked to that numeric id
//   enterWithGithub()    a returning person on a new device: this device makes its key, the escrow adds it to the name's list as a limited device and seals the Secret Key and home hint to this
//                        device's own agreement key; the device keeps them. The password then opens the vault. GitHub never opens it.
//   linkGithub()         a signed-in device ties the GitHub id to its name: it puts the relay's key on the list and sends the escrow the Secret Key and the home hint
// The Secret Key is read and written only through the vault tools below (`vaultSecretKey`), the seam wire-identity's export and import fill; until those tools exist the calls say so in words.

import { Platform } from "react-native";
import { MOCK, tool } from "../../src/real/box";
import { relayUrl } from "../../src/api/relay-url";
import { GITHUB_MOCK } from "../../screens/first-run/mock.js";
import { accountMessage, githubSay, homeHintText, linkMessage, newVerifier, openRelease, parseHomeHint, ticketId } from "../identity/github-core.js";
import type { GithubUser, Outcome } from "./github-types";
import * as C from "../../../../kernel/identity/chain.js";
import { openExternal } from "../shell/open-external";
import { shellKind } from "../shell/shell";
import { claimTicket, githubWay, parseReturn, rememberStart, returnWaiting, startUrl, takeReturn } from "../identity/github-return.js";

const DIRECTORY = (process.env.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY || "https://names.vyre.run").replace(/\/+$/, "");
const base = () => (process.env.EXPO_PUBLIC_VYRE_RELAY_HTTP || relayUrl().replace(/^ws/, "http")).replace(/\/+$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (code: string): { ok: false; say: string; code: string } => ({ ok: false, say: githubSay(code), code });

export type GithubSession = { ticket: string; cv: string };

const post = async (path: string, body: unknown) => {
  try {
    const r = await fetch(`${base()}/v1/github${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  } catch { return { status: 0, json: null as any }; }
};

/** The app's own origin, which the relay sends the browser back to: matched exactly there. */
const appOrigin = () => (Platform.OS === "web" && typeof window !== "undefined" && shellKind() !== "mac" ? window.location.origin : "vyreapp://box");

/** This page's storage, or null where there is none (a phone, a private window that refuses it). */
const pageStore = () => { try { return Platform.OS === "web" && typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } };

/** A sign-in came back from GitHub to this page and waits to be finished (the screen that started it calls its GitHub step again, which takes it). */
export function githubReturnWaiting(): boolean {
  return !MOCK && returnWaiting(pageStore(), Date.now());
}

/**
 * Go to GitHub and come back with a ticket and the verifier it was started with (see identity/github-return.js). In a browser the tab itself goes to GitHub, with no popup to block,
 * and this answers `redirect` while it leaves; back on the page, the same step runs again and takes the ticket. The Mac app opens the person's browser and claims the ticket from
 * the relay; a phone uses the system's sign-in sheet.
 */
async function ticketFromGithub(): Promise<{ ticket: string; cv: string } | { code: string }> {
  const way = githubWay({ web: Platform.OS === "web" && typeof window !== "undefined", mac: shellKind() === "mac" });
  if (way === "redirect") {
    const store = pageStore();
    const back = takeReturn(store, Date.now());
    if (back) return back;
    const { cv, cc } = await newVerifier();
    if (!store || !rememberStart(store, { cv, back: `${window.location.pathname}${window.location.search}`, now: Date.now() })) return { code: "no_storage" };
    window.location.assign(startUrl(base(), cc, appOrigin(), false));
    return { code: "redirect" };
  }
  const { cv, cc } = await newVerifier();
  if (way === "claim") {
    const opened = await openExternal(startUrl(base(), cc, appOrigin(), true));
    if (!opened.opened) return { code: "failed" };
    const t = await claimTicket((v) => post("/claim", { cv: v }), cv, { sleep });
    return typeof t === "string" ? { ticket: t, cv } : t;
  }
  const WebBrowser = await import("expo-web-browser");
  const res = await WebBrowser.openAuthSessionAsync(startUrl(base(), cc, appOrigin(), false), "vyreapp://box/github-return");
  if (res.type !== "success" || !res.url) return { code: "denied" };
  const t = parseReturn(res.url.includes("#") ? res.url.slice(res.url.indexOf("#")) : "");
  return typeof t === "string" ? { ticket: t, cv } : t;
}

/** Sign in with GitHub: who GitHub says this is, and the Vyre name already linked to that numeric id, if any. */
export async function signInWithGithub(opts: { signin: boolean }): Promise<Outcome<{ user: GithubUser; session: GithubSession | null }>> {
  if (MOCK) return { ok: true, user: opts.signin ? GITHUB_MOCK.linked : GITHUB_MOCK.fresh, session: null };
  const got = await ticketFromGithub();
  if (!("ticket" in got)) return fail(got.code);
  const { ticket: t, cv } = got;
  const r = await post("/me", { ticket: t, cv });
  if (r.status === 0 || r.status >= 500) return fail("unreachable");
  if (r.status !== 200 || !r.json?.github) return fail("expired");
  const g = r.json.github;
  return { ok: true, session: { ticket: t, cv }, user: { id: g.id, login: g.login, displayName: g.name ?? undefined, avatarUrl: g.avatarUrl ?? undefined, ...(r.json.linked ? { linkedName: r.json.linked.name } : {}) } };
}

/** The vault's Secret Key, through the tools wire-identity adds (vault.account.export-secret-key, import-secret-key). Until they exist the answer is `no_vault_tool`. */
const vaultSecretKey = {
  async export(): Promise<string | null> {
    try { const r = await tool<{ secretKey?: string }>("vault.account.export-secret-key", {}); return r?.secretKey ?? null; } catch { return null; }
  },
  async import(sk: string): Promise<boolean> {
    try { await tool("vault.account.import-secret-key", { secretKey: sk }); return true; } catch { return false; }
  },
};

const directoryList = async (name: string) => {
  const res = await fetch(`${DIRECTORY}/v1/ids/resolve?name=${encodeURIComponent(name)}`, { headers: { accept: "application/json" }, cache: "no-store" });
  const j: any = await res.json().catch(() => null);
  const ops: any[] = j?.data && Array.isArray(j.data.ops) ? j.data.ops : [];
  const st = await C.verifyChain(ops, { now: Date.now() + C.SKEW_MS });
  return { ops, id: st.id, state: st, pin: C.pinOf(st) };
};

/** A returning person on a new device. Keeps nothing until the name's list holds this device. */
export async function enterWithGithub(session: GithubSession | null, name: string): Promise<Outcome> {
  if (MOCK) { await sleep(500); return { ok: true }; }
  if (!session) return fail("expired");
  const { generateDeviceKey } = await import("../../src/identity/keys.js");
  const { agreePublic, agree } = await import("../../src/identity/agree");
  const { saveIdentity, loadIdentity } = await import("../../src/identity/store");
  if (await loadIdentity().catch(() => null)) return { ok: false, say: "This device already holds a name." };
  const agreePoint = await agreePublic();
  if (!agreePoint) return fail("no_agree_key");
  const key = await generateDeviceKey();
  const r = await post("/enter", { ...session, device: { eid: key.eid, pub: key.publicKey, agree: agreePoint } });
  if (r.status === 0 || r.status >= 500) return fail("unreachable");
  if (r.status === 404) return fail("not_linked");
  if (r.status !== 200 || !r.json?.sealed) return { ok: false, say: r.json?.error ? `GitHub sign-in could not add this device: ${r.json.error}.` : githubSay(undefined) };
  let bundle;
  try { bundle = await openRelease(r.json.sealed, agree); } catch { return fail("bad_bundle"); }
  const linked = String(r.json.name || name).trim().toLowerCase();
  let list;
  try { list = await directoryList(linked); } catch { return fail("unreachable"); }
  if (!list.state.entries.some((e: any) => e.eid === key.eid)) return fail("unreachable");
  await saveIdentity({ name: linked, id: list.id, eid: key.eid, ops: list.ops, pin: list.pin, key });
  const home = parseHomeHint(bundle.home);
  if (home) {
    const { afterPaired } = await import("../../src/real/pairing");
    await afterPaired({ relay: home.relay, route: home.route, box: home.box, name: home.name || linked, device: key.eid }).catch(() => {});
  }
  if (!(await vaultSecretKey.import(bundle.sk))) return fail("no_vault_tool");
  return { ok: true };
}

/** Link GitHub to the name this device holds. Needs a ticket from a sign-in made in the last half hour. */
export async function linkGithub(session: GithubSession | null, user: GithubUser): Promise<Outcome> {
  if (MOCK) { await sleep(400); return { ok: true }; }
  if (!session) return fail("expired");
  const { loadIdentity } = await import("../../src/identity/store");
  const me = await loadIdentity();
  if (!me) return { ok: false, say: "This device does not hold a name yet." };
  const ts = Date.now();
  const sig = C.b64u(await me.key.sign(linkMessage({ ghid: user.id, identity: me.id, tid: await ticketId(session.ticket), ts, host: new URL(base()).host })));
  const l = await post("/link", { ...session, name: me.name, eid: me.eid, ts, sig });
  if (l.status === 409) return { ok: false, say: l.json?.error ?? "That GitHub account or this name is already linked." };
  if (l.status !== 200 || !l.json?.relay) return { ok: false, say: l.json?.error ?? githubSay(undefined) };
  // The relay's key goes on the list, signed by this device.
  const state = await C.verifyChain(me.ops as any[], { now: ts + C.SKEW_MS });
  const op = await C.makeOp(state, { type: "add", entry: { eid: l.json.relay.eid, kind: "device", pub: l.json.relay.pub, held: "relay" } }, { by: me.eid, ts, sign: me.key.sign });
  const ap = await fetch(`${DIRECTORY}/v1/ids/append`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: me.name, ops: [op] }) }).catch(() => null);
  if (!ap || !ap.ok) return { ok: false, say: "GitHub was linked, but your name's list did not take the relay's key, so sign-in with GitHub will not work yet. Unlink and try again." };
  const sk = await vaultSecretKey.export();
  if (!sk) return fail("no_vault_tool");
  const { loadPairing } = await import("../../src/api/relay");
  const put = await fetch(`${String(l.json.escrow.origin).replace(/\/+$/, "")}/v1/escrow/put`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: l.json.escrow.token, bundle: { sk, home: homeHintText(await loadPairing().catch(() => null)) } }) }).catch(() => null);
  return put && put.ok ? { ok: true } : { ok: false, say: "GitHub was linked, but your Secret Key was not stored, so sign-in with GitHub cannot open your vault yet. Try again from Settings." };
}

/** Settings > Account: the linked login, refresh the stored Secret Key after a reset, or unlink. Each is signed by this device over a fresh nonce from the relay. */
export async function githubAccount(action: "status" | "unlink" | "refresh"): Promise<Outcome<{ linked: { login: string; since: number } | null }>> {
  if (MOCK) return { ok: true, linked: action === "unlink" ? null : { login: GITHUB_MOCK.linked.login, since: Date.now() - 86_400_000 } };
  const { loadIdentity } = await import("../../src/identity/store");
  const me = await loadIdentity();
  if (!me) return { ok: false, say: "This device does not hold a name yet." };
  const c = await post("/challenge", { name: me.name });
  if (c.status !== 200 || !c.json?.nonce) return fail("unreachable");
  const ts = Date.now();
  const sig = C.b64u(await me.key.sign(accountMessage({ action, identity: me.id, nonce: c.json.nonce, ts, host: new URL(base()).host })));
  const r = await post("/account", { name: me.name, action, nonce: c.json.nonce, eid: me.eid, ts, sig });
  if (r.status !== 200) return { ok: false, say: r.json?.error ?? githubSay(undefined) };
  if (action === "refresh") {
    const sk = await vaultSecretKey.export();
    if (!sk) return fail("no_vault_tool");
    const { loadPairing } = await import("../../src/api/relay");
    await fetch(`${String(r.json.escrow.origin).replace(/\/+$/, "")}/v1/escrow/put`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: r.json.escrow.token, bundle: { sk, home: homeHintText(await loadPairing().catch(() => null)) } }) }).catch(() => null);
    return { ok: true, linked: null };
  }
  if (action === "unlink") {
    // The relay's entry leaves the list in this device's own signed op, after the escrow has dropped the key.
    const state = await C.verifyChain(me.ops as any[], { now: ts + C.SKEW_MS });
    const relayEntry = state.entries.find((e: any) => e.held === "relay");
    if (relayEntry) {
      const op = await C.makeOp(state, { type: "remove", target: relayEntry.eid }, { by: me.eid, ts: Date.now(), sign: me.key.sign });
      await fetch(`${DIRECTORY}/v1/ids/append`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: me.name, ops: [op] }) }).catch(() => null);
    }
    return { ok: true, linked: null };
  }
  return { ok: true, linked: r.json.linked ?? null };
}

/** After the vault's Secret Key changed (vault.secretkey-changed): store the new one with the escrow if GitHub is linked. Silent when it is not, or when this build cannot do it. */
export async function reEscrowSecretKey(): Promise<void> {
  if (MOCK) return;
  try { await githubAccount("refresh"); } catch { /* the next change or Settings tries again */ }
}

export type GithubDevice = { eid: string; since: number; confirmed: boolean };

/** Devices the relay added after a GitHub sign-in, read from the verified list. They are limited until a device of yours confirms them. */
export async function githubDevices(): Promise<GithubDevice[]> {
  if (MOCK) return [{ eid: "mockeid1", since: Date.now() - 3_600_000, confirmed: false }];
  const { loadIdentity } = await import("../../src/identity/store");
  const me = await loadIdentity();
  if (!me) return [];
  try { return (await directoryList(me.name)).state.entries.filter((e: any) => e.via === "github").map((e: any) => ({ eid: e.eid, since: e.since, confirmed: Boolean(e.confirmed) })); } catch { return []; }
}

/** Confirm (it becomes an ordinary device) or remove a device that signed in with GitHub: one op signed by this device. */
export async function changeGithubDevice(action: "confirm" | "remove", eid: string): Promise<Outcome> {
  if (MOCK) { await sleep(300); return { ok: true }; }
  const { loadIdentity } = await import("../../src/identity/store");
  const me = await loadIdentity();
  if (!me) return { ok: false, say: "This device does not hold a name yet." };
  try {
    const list = await directoryList(me.name);
    const ts = Date.now();
    const op = await C.makeOp(list.state, { type: action, target: eid }, { by: me.eid, ts, sign: me.key.sign });
    const r = await fetch(`${DIRECTORY}/v1/ids/append`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: me.name, ops: [op] }) });
    if (!r.ok) return { ok: false, say: action === "confirm" ? "The list did not take the confirmation. Only a device that is a day old or more can confirm." : "The list did not take that. Nothing changed." };
    return { ok: true };
  } catch { return fail("unreachable"); }
}
