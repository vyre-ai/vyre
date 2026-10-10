// @ts-check
// repo-create: making a new repo on GitHub for a folder (R032-06). Pure over an injected `fetch` and the account's token; the module wires the vault and the push.
// The owner is the account's own login or one of its organisations, the repo is private unless the person says public, and nothing here ever holds a token longer than the call.

import { httpFetch } from "../../lib/http.js";

export const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const fail = (/** @type {string} */ msg, /** @type {string} */ code = "bad_input") => Object.assign(new Error(msg), { code });
const headers = (/** @type {string} */ token) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" });

/** A repo name GitHub accepts and the path rules of git-safe allow: letters, digits, dot, dash, underscore; never `.` or `..`. */
export const REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
/** An owner is a login: letters, digits and single hyphens, up to 39. */
export const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Who can own a new repo for this account: the account itself and the organisations it belongs to.
 * @param {{ token: string, login: string, fetch?: typeof httpFetch }} p @returns {Promise<{ login: string, kind: "user" | "org" }[]>}
 */
export async function ownersOf({ token, login, fetch = httpFetch }) {
  const res = await fetch(`${API}/user/orgs?per_page=100`, { headers: headers(token), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401) throw fail("GitHub did not accept the saved sign-in; connect the account again", "no_account");
  if (!res.ok) throw fail(`GitHub answered ${res.status} listing organisations.`, "refused");
  const rows = await res.json();
  const orgs = (Array.isArray(rows) ? rows : []).map(o => String(o && o.login || "")).filter(l => OWNER.test(l));
  return [{ login, kind: "user" }, ...orgs.map(l => /** @type {const} */ ({ login: l, kind: "org" }))];
}

/**
 * Make an empty repo. `owner` is the account's own login or an organisation it belongs to; private unless `visibility` is "public".
 * @param {{ token: string, login: string, owner?: string, name: string, visibility?: "private" | "public", description?: string, fetch?: typeof httpFetch }} p
 * @returns {Promise<{ full_name: string, name: string, owner: string, private: boolean, html_url: string, clone_url: string }>}
 */
export async function createRepo({ token, login, owner, name, visibility = "private", description, fetch = httpFetch }) {
  if (!REPO_NAME.test(String(name || ""))) throw fail("a repo name is letters, digits, dot, dash and underscore, up to 100", "bad_input");
  if (!["private", "public"].includes(visibility)) throw fail("visibility is private or public", "bad_input");
  const who = owner ? String(owner) : login;
  if (!OWNER.test(who)) throw fail("that is not a GitHub account or organisation name", "bad_input");
  const own = who.toLowerCase() === login.toLowerCase();
  const res = await fetch(own ? `${API}/user/repos` : `${API}/orgs/${encodeURIComponent(who)}/repos`, {
    method: "POST", headers: headers(token), signal: AbortSignal.timeout(TIMEOUT_MS), retries: 0,
    body: JSON.stringify({ name, private: visibility !== "public", ...(description ? { description: String(description).slice(0, 350) } : {}), auto_init: false }),
  });
  if (res.status === 401) throw fail("GitHub did not accept the saved sign-in; connect the account again", "no_account");
  if (res.status === 404) throw fail(`${who} is not an organisation this account belongs to`, "not_found");
  if (res.status === 403) throw fail(`GitHub would not let this account make a repo under ${who}`, "denied");
  if (res.status === 422) throw fail(`${who} already has a repo called ${name}, or GitHub did not like the name; pick another`, "conflict");
  if (res.status !== 201) throw fail(`GitHub answered ${res.status} making the repo.`, "refused");
  const r = await res.json();
  return { full_name: String(r.full_name), name: String(r.name), owner: String(r.owner && r.owner.login || who), private: Boolean(r.private), html_url: String(r.html_url), clone_url: String(r.clone_url) };
}
