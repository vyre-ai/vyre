// @ts-check
// An AI provider's API key, from the setup screen or Settings (0.2.2 #20):
//
//   vault.apikey.check  one cheap call to the provider with the key, from this machine. { ok, status, models?, base_url }. The key is
//                       never echoed, stored or logged by it.
//   vault.apikey.save   checks the key the same way, refuses a key that fails, then stores it as an api-credential named
//                       ai-<kind>[-<host>] whose only host is the provider's own, so only vault.request can use it and nobody is shown it
//                       again. Needs a person's proof, like every other way a secret enters the vault.
//
// Both are the person's own surfaces only (reach person). An agent cannot make an api-credential at all (core/vault/api-credential.test.js),
// so there is no agent form of save yet.

import { callerAllowed } from "../../modules/index.js";
import { normalize } from "../api-request.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule", "mobile", "tailnet"];
const KINDS = ["openai", "anthropic", "openrouter"];
const CHECK_MS = 10_000;

/** What each kind is called, where it lives by default, and the one cheap authenticated GET that proves a key. */
export const PROVIDERS = {
  openai: { base: "https://api.openai.com/v1", probe: "/models", auth: { type: "bearer" }, headers: {} },
  anthropic: { base: "https://api.anthropic.com", probe: "/v1/models", auth: { type: "api-key", header: "x-api-key" }, headers: { "anthropic-version": "2023-06-01" } },
  // OpenRouter's /models is public; /key needs the key.
  openrouter: { base: "https://openrouter.ai/api/v1", probe: "/key", auth: { type: "bearer" }, headers: {} },
};

/**
 * The base URL as an origin plus a path prefix: https, or http only for this machine; no login in the URL, no query, nothing link-local.
 * @param {string} kind @param {unknown} given
 */
export function baseOf(kind, given) {
  const raw = given === undefined || given === null || given === "" ? PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (kind)].base : String(given);
  let u;
  try { u = new URL(raw); } catch { throw new Error("the base URL is not a URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("the base URL must be https (http only for a server on this machine)");
  if (u.username || u.password) throw new Error("the base URL must not carry a login");
  if (u.search || u.hash) throw new Error("the base URL must not carry a query");
  if (/^(169\.254\.|\[fe80:)/i.test(u.hostname)) throw new Error("that address is not a provider");
  return { origin: u.origin, host: u.hostname, prefix: u.pathname.replace(/\/+$/, ""), href: u.origin + u.pathname.replace(/\/+$/, "") };
}

/**
 * One cheap authenticated GET. No redirect is followed (a redirect would carry the key somewhere else), the answer is read for a count
 * only, and nothing about the key goes into the result or an error.
 * @param {{ kind: string, key: string, base_url?: string }} a @param {typeof globalThis.fetch} fetch
 */
export async function checkKey({ kind, key, base_url }, fetch = globalThis.fetch) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  if (typeof key !== "string" || key.length < 8 || key.length > 4096 || /[\s\u0000-\u001f]/.test(key)) throw new Error("that does not look like an API key");
  const p = PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (kind)];
  const b = baseOf(kind, base_url);
  const headers = { accept: "application/json", ...p.headers, ...(p.auth.type === "bearer" ? { authorization: `Bearer ${key}` } : { [/** @type {string} */ (p.auth.header)]: key }) };
  let res;
  try { res = await fetch(b.href + p.probe, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(CHECK_MS) }); }
  catch { return { ok: false, status: 0, base_url: b.href, why: "could not reach the provider" }; }
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, base_url: b.href, why: "the provider did not accept this key" };
  if (!res.ok) return { ok: false, status: res.status, base_url: b.href, why: `the provider answered ${res.status}` };
  let models;
  try { const j = /** @type {any} */ (await res.json()); if (j && Array.isArray(j.data)) models = j.data.length; } catch { /* a count is a nicety */ }
  return { ok: true, status: res.status, ...(models !== undefined ? { models } : {}), base_url: b.href };
}

/** @param {{ ctx: any, vault: import("../vault.js").Vault, fetch?: typeof globalThis.fetch }} deps */
export function register({ ctx, vault, fetch = globalThis.fetch }) {
  const shape = { kind: { type: "string", enum: KINDS }, key: str, base_url: { type: "string", description: "for a compatible provider: z.ai, DeepSeek, a local server; the default is the provider's own" } };

  ctx.tool("vault.apikey.check", {
    description: "Check an AI provider's API key with one cheap call from this machine: { ok, status, models?, base_url }. The key is not stored.",
    input: obj(shape, ["kind", "key"]),
    callers: PEOPLE,
    run: async (input, { caller }) => {
      if (!callerAllowed(PEOPLE, caller)) throw new Error("vault.apikey.check is for people");
      return checkKey(input, fetch);
    },
  });

  ctx.tool("vault.apikey.save", {
    description: "Check an AI provider's API key, then keep it in the vault where only vault.request can use it, and never show it again. A key that fails the check is refused. Returns { name }.",
    input: obj({ ...shape, name: str }, ["kind", "key"]),
    callers: PEOPLE,
    presence: { summary: input => `Keep your ${input && input.kind} API key in the vault${input && input.base_url ? ` for ${(() => { try { return new URL(input.base_url).hostname; } catch { return "that server"; } })()}` : ""}` },
    run: async (input, { caller }) => {
      if (!callerAllowed(PEOPLE, caller)) throw new Error("vault.apikey.save is for people");
      const checked = await checkKey(input, fetch);
      if (!checked.ok) throw Object.assign(new Error(checked.why || "the key did not pass the check"), { code: "key_refused", detail: { status: checked.status } });
      const b = baseOf(input.kind, input.base_url);
      const p = PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (input.kind)];
      const name = typeof input.name === "string" && input.name ? input.name : `ai-${input.kind}${input.base_url && b.href !== p.base ? `-${b.host.replace(/[^A-Za-z0-9.-]/g, "-")}` : ""}`;
      const config = normalize({ auth: p.auth, hosts: [b.host], endpoints: [{ method: "GET", path: "/*", kind: "read" }] });
      await vault.put({ name, kind: "api-credential", description: `${input.kind} API key (${b.host})`, fields: { config: JSON.stringify(config), secret: input.key } }, caller);
      return { name, base_url: b.href, models: checked.models };
    },
  });
}
