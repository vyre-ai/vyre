// Continue with GitHub, behind small doors. In MOCK it answers from flow-model.js. Otherwise it talks to the relay (relay/worker/github.js) and the escrow it fronts:
//   signInWithGithub()   the browser goes to GitHub and back with a one-use ticket; the relay says who GitHub says this is and which Vyre name, if any, is linked to that numeric id
//   enterWithGithub()    a returning person on a new device: this device makes its key, the escrow adds it to the name's list as a limited device and seals the Secret Key and home hint to this
//                        device's own agreement key; the device keeps them. The master password then opens the vault. GitHub never opens it.
//   linkGithub()         a signed-in device ties the GitHub id to its name: it puts the relay's key on the list and sends the escrow the Secret Key and the home hint
// The Secret Key is read and written only through the vault tools below (`vaultSecretKey`), the seam wire-identity's export and import fill; until those tools exist the calls say so in words.

import { Platform } from "react-native";
import { MOCK, tool } from "../../src/real/box";
import { relayUrl } from "../../src/api/relay-url";
import { GITHUB_MOCK } from "./flow-model.js";
import { accountMessage, githubSay, homeHintText, linkMessage, newVerifier, openRelease, parseHomeHint, ticketId } from "./github-core.js";
import type { GithubUser } from "./types";
import type { Outcome } from "./real-identity";
import * as C from "../../../../kernel/identity/chain.js";

const DIRECTORY = (process.env.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY || "https://names.vyre.run").replace(/\/+$/, "");
const base = () => (process.env.EXPO_PUBLIC_VYRE_RELAY_HTTP || relayUrl().replace(/^ws/, "http")).replace(/\/+$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (code: string): { ok: false; say: string; code: string } => ({ ok: false, say: githubSay(code), code });
const RETURN_KEY = "vyre.gh.return";

export type GithubSession = { ticket: string; cv: string };

const post = async (path: string, body: unknown) => {
  try {
    const r = await fetch(`${base()}/v1/github${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  } catch { return { status: 0, json: null as any }; }
};

/** The app's own origin, which the relay sends the browser back to: matched exactly there. */
const appOrigin = () => (Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "vyreapp://box");

/** Go to GitHub and wait for the ticket. On the web a window opens and the app's /github-return page hands the ticket back; on a phone the system browser session does. */
async function ticketFromGithub(cc: string): Promise<string | { code: string }> {
  const url = `${base()}/v1/github/start?cc=${encodeURIComponent(cc)}&app=${encodeURIComponent(appOrigin())}`;
  const parse = (hash: string) => { const p = new URLSearchParams(hash.replace(/^#/, "")); return p.get("ticket") ?? ({ code: p.get("error") === "denied" ? "denied" : "failed" } as const); };
  if (Platform.OS === "web") {
    try { localStorage.removeItem(RETURN_KEY); } catch { /* none */ }
    const w = window.open(url, "vyre-github", "width=520,height=720");
    if (!w) return { code: "popup" };
    for (let i = 0; i < 600; i++) {
      await sleep(500);
      let got: string | null = null;
      try { got = localStorage.getItem(RETURN_KEY); } catch { /* none */ }
      if (got) {
        try { localStorage.removeItem(RETURN_KEY); } catch { /* none */ }
        try { w.close(); } catch { /* closed */ }
        return parse(got);
      }
      if (w.closed && i > 4) return { code: "denied" };
    }
    return { code: "timeout" };
  }
  const WebBrowser = await import("expo-web-browser");
  const res = await WebBrowser.openAuthSessionAsync(url, "vyreapp://box/github-return");
  if (res.type !== "success" || !res.url) return { code: "denied" };
  return parse(res.url.includes("#") ? res.url.slice(res.url.indexOf("#")) : "");
}

/** Sign in with GitHub: who GitHub says this is, and the Vyre name already linked to that numeric id, if any. */
export async function signInWithGithub(opts: { signin: boolean }): Promise<Outcome<{ user: GithubUser; session: GithubSession | null }>> {
  if (MOCK) return { ok: true, user: opts.signin ? GITHUB_MOCK.linked : GITHUB_MOCK.fresh, session: null };
  const { cv, cc } = await newVerifier();
  const t = await ticketFromGithub(cc);
  if (typeof t !== "string") return fail(t.code);
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
