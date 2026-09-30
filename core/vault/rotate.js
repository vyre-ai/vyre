// @ts-check
// rotate: make a credential's successor at its provider, using the credential itself.
//
// Four providers let a key make its own replacement over an API: AWS (IAM CreateAccessKey, signed
// here with Signature Version 4), GitLab (a PAT rotates itself), Cloudflare (a token rolls its own
// value) and Google Cloud (a service-account key makes another). Every other provider gets its key
// page and a sentence on doing it by hand. Twilio is one of those: a Standard API key may not
// manage keys, and a Main key can only be made in the Console.
//
// Order is the whole design. rotate() only creates: it hands back the new fields and a revoke()
// for the old credential, and the caller stores the new fields (a new version; history keeps the
// old one) before it calls revoke(). A crash between the two leaves two live keys and a vault
// holding the newer one, never a vault holding a dead key. GitLab and Cloudflare kill the old
// value in the same call that makes the new one, so for them the only risk is a lost response,
// which no ordering here can fix; their revoke() is a no-op that says so.
//
// Errors name the provider and what a person can do, and are built from fixed words only: never a
// key, a token, a header value or a response body, since a message may land in a log, a toast or a
// chat. revoke() never throws; it reports. Each request gets 20 s and no redirects (a redirect
// would carry the auth header somewhere else). No dependencies.

import crypto from "node:crypto";

const TIMEOUT_MS = 20_000;

/** Base URLs per provider; `endpoints` overrides any of them (tests point them at 127.0.0.1). */
export const DEFAULT_ENDPOINTS = Object.freeze({
  aws: "https://iam.amazonaws.com",
  gitlab: "https://gitlab.com",
  cloudflare: "https://api.cloudflare.com",
  gcp: "https://iam.googleapis.com",
  // Used only when the key JSON has no token_uri; an `endpoints.gcpToken` beats both.
  gcpToken: "https://oauth2.googleapis.com/token",
});

/**
 * @typedef {{ auto: boolean, url: string, steps: string }} Provider
 * @type {Record<string, Provider>}
 */
export const PROVIDERS = {
  // Automatic.
  aws: { auto: true, url: "https://console.aws.amazon.com/iam/home#/security_credentials",
    steps: "In IAM, open the user's Security credentials and create a new access key. Store it here, then deactivate and delete the old one." },
  gitlab: { auto: true, url: "https://gitlab.com/-/user_settings/personal_access_tokens",
    steps: "Open Access tokens in your user settings and use Rotate on this token. Store the new value here; the old one stops working at once." },
  cloudflare: { auto: true, url: "https://dash.cloudflare.com/profile/api-tokens",
    steps: "Open API Tokens in your profile and choose Roll on this token. Store the new value here; the old one stops working at once." },
  gcp: { auto: true, url: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    steps: "Open the service account, go to Keys, and add a new JSON key. Store the downloaded file here, then delete the old key." },
  // Guided.
  twilio: { auto: false, url: "https://console.twilio.com/us1/account/keys-credentials/api-keys",
    steps: "Create a new API key under API keys & tokens and store its SID and secret here. Then delete the old key." },
  github: { auto: false, url: "https://github.com/settings/tokens",
    steps: "Open Developer settings, Personal access tokens, and regenerate this token (or make a new one with the same scopes). Store it here, then delete the old one." },
  openai: { auto: false, url: "https://platform.openai.com/api-keys",
    steps: "Create a new secret key on the API keys page and store it here. Then revoke the old key." },
  anthropic: { auto: false, url: "https://console.anthropic.com/settings/keys",
    steps: "Create a new key under API keys in the Console and store it here. Then disable or delete the old key." },
  openrouter: { auto: false, url: "https://openrouter.ai/settings/keys",
    steps: "Create a new key on the Keys page and store it here. Then delete the old key." },
  stripe: { auto: false, url: "https://dashboard.stripe.com/apikeys",
    steps: "Use Roll key on this key in the Dashboard's API keys page, choosing when the old one expires. Store the new key here before that time." },
  slack: { auto: false, url: "https://api.slack.com/apps",
    steps: "Open the app, go to OAuth & Permissions, and regenerate or reinstall to get a new token. Store it here; revoke the old one if Slack did not." },
  supabase: { auto: false, url: "https://supabase.com/dashboard/project/_/settings/api-keys",
    steps: "Create a new secret API key in the project's API Keys settings and store it here. Then delete the old key." },
  google: { auto: false, url: "https://console.cloud.google.com/apis/credentials",
    steps: "On the Credentials page, rotate the API key or reset the OAuth client secret. Store the new value here, then remove the old one." },
  resend: { auto: false, url: "https://resend.com/api-keys",
    steps: "Create a new API key and store it here. Then delete the old key." },
  sendgrid: { auto: false, url: "https://app.sendgrid.com/settings/api_keys",
    steps: "Create a new API key with the same permissions and store it here. Then delete the old key." },
  mailgun: { auto: false, url: "https://app.mailgun.com/settings/api_security",
    steps: "Create a new API key under API security and store it here. Then delete the old key." },
  digitalocean: { auto: false, url: "https://cloud.digitalocean.com/account/api/tokens",
    steps: "Generate a new token with the same scopes on the API page and store it here. Then delete the old token." },
  vercel: { auto: false, url: "https://vercel.com/account/settings/tokens",
    steps: "Create a new token in your account settings and store it here. Then delete the old token." },
  railway: { auto: false, url: "https://railway.com/account/tokens",
    steps: "Create a new token on the Tokens page and store it here. Then delete the old token." },
  npm: { auto: false, url: "https://docs.npmjs.com/creating-and-viewing-access-tokens",
    steps: "On npmjs.com, open Access Tokens from your avatar menu and generate a new token. Store it here, then delete the old one." },
  pypi: { auto: false, url: "https://pypi.org/manage/account/#api-tokens",
    steps: "Add a new API token in your account settings with the same scope and store it here. Then remove the old token." },
  huggingface: { auto: false, url: "https://huggingface.co/settings/tokens",
    steps: "Use Invalidate and refresh on this token, or create a new one. Store the new value here." },
  tailscale: { auto: false, url: "https://login.tailscale.com/admin/settings/keys",
    steps: "Generate a new key on the Keys page with the same settings and store it here. Then revoke the old key." },
  deepgram: { auto: false, url: "https://console.deepgram.com/",
    steps: "Open the project's API Keys, create a new key and store it here. Then delete the old key." },
  elevenlabs: { auto: false, url: "https://elevenlabs.io/app/settings/api-keys",
    steps: "Create a new API key and store it here. Then delete the old key." },
  perplexity: { auto: false, url: "https://www.perplexity.ai/settings/api",
    steps: "Generate a new API key and store it here. Then delete the old key." },
  shopify: { auto: false, url: "https://admin.shopify.com/",
    steps: "In Settings, Apps and sales channels, Develop apps, open the app and rotate its Admin API access token or secret. Store the new value here." },
  square: { auto: false, url: "https://developer.squareup.com/apps",
    steps: "Open the application, then Credentials, and replace the access token or application secret. Store the new value here." },
  linear: { auto: false, url: "https://linear.app/settings/account/security",
    steps: "Create a new personal API key under Security & access and store it here. Then revoke the old key." },
  notion: { auto: false, url: "https://www.notion.so/my-integrations",
    steps: "Open the integration and refresh its secret. Store the new value here; the old one stops working." },
  airtable: { auto: false, url: "https://airtable.com/create/tokens",
    steps: "Regenerate this token on the Personal access tokens page and store the new value here." },
  hubspot: { auto: false, url: "https://app.hubspot.com/",
    steps: "In Settings, Integrations, Private Apps, open the app and rotate its access token. Store the new token here." },
  sentry: { auto: false, url: "https://sentry.io/settings/account/api/auth-tokens/",
    steps: "Create a new auth token with the same scopes and store it here. Then delete the old token." },
  pinecone: { auto: false, url: "https://app.pinecone.io/",
    steps: "Open the project's API Keys, create a new key and store it here. Then delete the old key." },
  jina: { auto: false, url: "https://jina.ai/api-dashboard/key-manager",
    steps: "Create a new key in the key manager and store it here. Then delete the old key." },
  apify: { auto: false, url: "https://console.apify.com/settings/integrations",
    steps: "Create a new API token under Settings, API & Integrations, and store it here. Then delete the old token." },
  telegram: { auto: false, url: "https://t.me/BotFather",
    steps: "Send /revoke to BotFather and pick the bot; it replies with a new token. Store it here." },
  discord: { auto: false, url: "https://discord.com/developers/applications",
    steps: "Open the application, go to Bot, and use Reset Token. Store the new token here." },
  azure: { auto: false, url: "https://portal.azure.com/",
    steps: "Regenerate the key or add a new client secret on the resource or app registration. Store it here, then delete the old one." },
  paypal: { auto: false, url: "https://developer.paypal.com/dashboard/applications",
    steps: "Open the app and generate a new secret. Store it here, then disable the old secret." },
  datadog: { auto: false, url: "https://app.datadoghq.com/organization-settings/api-keys",
    steps: "Create a new API or application key and store it here. Then revoke the old key." },
  postgres: { auto: false, url: "https://www.postgresql.org/docs/current/sql-alteruser.html",
    steps: "Set a new password with ALTER ROLE name PASSWORD, or at your database host's console. Store the new connection URL here." },
  mysql: { auto: false, url: "https://dev.mysql.com/doc/refman/8.4/en/alter-user.html",
    steps: "Set a new password with ALTER USER, or at your database host's console. Store the new connection URL here." },
  mongodb: { auto: false, url: "https://www.mongodb.com/docs/manual/reference/method/db.changeUserPassword/",
    steps: "Change the user's password with db.changeUserPassword, or in Atlas under Database Access. Store the new connection URL here." },
  redis: { auto: false, url: "https://redis.io/docs/latest/commands/acl-setuser/",
    steps: "Set a new password with ACL SETUSER, or at your Redis host's console. Store the new connection URL here." },
  amqp: { auto: false, url: "https://www.rabbitmq.com/docs/passwords",
    steps: "Change the user's password with rabbitmqctl change_password, or at your broker host's console. Store the new connection URL here." },
};

/** Names for messages. */
const LABEL = { aws: "AWS", gitlab: "GitLab", cloudflare: "Cloudflare", gcp: "Google Cloud" };

/**
 * @typedef {{ name?: string, kind: string, details?: Record<string, any>, fields: string[] }} Item
 * @typedef {{ revoked: boolean, reason?: string }} Revoked
 * @typedef {{ fields: Record<string, string>, expires?: number, revoke: () => Promise<Revoked> }} Rotated
 * @typedef {{ fetch?: typeof fetch, endpoints?: Record<string, string>, now?: number | (() => number) }} Options
 */

/** @param {Item} item @param {...string} names */
const has = (item, ...names) => names.every(n => Array.isArray(item.fields) && item.fields.includes(n));

/** Whether an item has the shape its provider's automatic rotation needs. */
const SHAPE = {
  /** @param {Item} i */ aws: i => i.kind === "cloud" && has(i, "access_key_id", "secret_access_key") && !has(i, "session_token"),
  /** @param {Item} i */ gitlab: i => i.kind === "pat" && has(i, "token"),
  /** @param {Item} i */ cloudflare: i => (i.kind === "api-key" && has(i, "value")) || (i.kind === "pat" && has(i, "token")),
  /** @param {Item} i */ gcp: i => i.kind === "cloud" && has(i, "json"),
};

/**
 * How an item is rotated: automatically, or by hand at `url`. Null when its details name no
 * provider, or one this file does not know. A known automatic provider whose item has the wrong
 * shape (AWS temporary credentials, a GitLab item that is not a PAT) comes back as guided.
 * @param {Item} item
 * @returns {{ provider: string, auto: boolean, url: string, steps: string } | null}
 */
export function rotationFor(item) {
  const provider = item && item.details && typeof item.details.provider === "string" ? item.details.provider : null;
  if (!provider || !Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) return null;
  const p = PROVIDERS[provider];
  const shape = SHAPE[/** @type {keyof typeof SHAPE} */ (provider)];
  return { provider, auto: p.auto && !!shape && shape(item), url: p.url, steps: p.steps };
}

/**
 * Create the item's successor at its provider with the current credential. Returns the fields to
 * store and a revoke() for the old credential; store first, then revoke.
 * @param {Item} item
 * @param {Record<string, string>} fields the opened values
 * @param {Options} [opts]
 * @returns {Promise<Rotated>}
 */
export async function rotate(item, fields, opts = {}) {
  const r = rotationFor(item);
  if (!r) throw new Error("this item names no provider Vyre knows, so it cannot be rotated automatically");
  const p = r.provider;
  if (p === "aws" && has(item, "session_token"))
    throw new Error("AWS: these are temporary credentials (they carry a session token); they expire on their own and cannot be rotated. Rotate the long-term key they came from.");
  if (!r.auto) throw new Error(`${LABEL[/** @type {keyof typeof LABEL} */ (p)] || p} cannot be rotated automatically: ${r.steps}`);
  const ctx = {
    fetch: opts.fetch || globalThis.fetch,
    base: /** @param {keyof typeof DEFAULT_ENDPOINTS} k */ k => String((opts.endpoints && opts.endpoints[k]) || DEFAULT_ENDPOINTS[k]).replace(/\/+$/, ""),
    endpoints: opts.endpoints || {},
    now: () => (typeof opts.now === "function" ? opts.now() : typeof opts.now === "number" ? opts.now : Date.now()),
  };
  if (p === "aws") return aws(fields, ctx);
  if (p === "gitlab") return gitlab(fields, ctx);
  if (p === "cloudflare") return cloudflare(item, fields, ctx);
  return gcp(fields, ctx);
}

/** @typedef {{ fetch: typeof fetch, base: (k: keyof typeof DEFAULT_ENDPOINTS) => string, endpoints: Record<string, string>, now: () => number }} Ctx */

// ---- shared ------------------------------------------------------------------------------------

/** @param {string} p @param {string} msg */
const fail = (p, msg) => new Error(`${LABEL[/** @type {keyof typeof LABEL} */ (p)] || p}: ${msg}`);

/** @param {string} p @param {Record<string, string>} f @param {string} name */
function need(p, f, name) {
  const v = f && f[name];
  if (typeof v !== "string" || !v) throw fail(p, `the item has no ${name} to rotate with`);
  return v;
}

/**
 * One request. Network trouble and timeouts become a provider-named error without the cause's
 * text, which can carry a URL or a header.
 * @param {string} p @param {Ctx} ctx @param {string} url @param {RequestInit} init
 */
async function call(p, ctx, url, init) {
  /** @type {Response} */
  let res;
  try { res = await ctx.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) {
    const name = e && typeof e === "object" && "name" in e ? e.name : "";
    throw fail(p, name === "TimeoutError" || name === "AbortError" ? `did not answer within ${TIMEOUT_MS / 1000} s; try again later` : "could not be reached (network error); check the connection and try again");
  }
  let text = "";
  try { text = await res.text(); } catch { throw fail(p, "sent a response that could not be read; try again later"); }
  return { status: res.status, ok: res.ok, text };
}

/** @param {string} text */
function jsonOf(text) { try { return JSON.parse(text); } catch { return null; } }

/**
 * Words for an HTTP status. `what` is "key" or "token"; `forbidden` says what a 403 means here.
 * @param {string} p @param {number} status @param {string} what @param {string} forbidden
 */
function statusError(p, status, what, forbidden) {
  if (status === 401) return fail(p, `the current ${what} was refused; it may already be revoked`);
  if (status === 403) return fail(p, forbidden);
  if (status === 404) return fail(p, `the ${what} or its account was not found (HTTP 404)`);
  if (status === 429) return fail(p, "too many requests; try again in a few minutes");
  if (status >= 500) return fail(p, `the provider had a server error (HTTP ${status}); try again later`);
  return fail(p, `the request was refused (HTTP ${status})`);
}

/** @param {string} p */
const unexpected = p => fail(p, "sent a response Vyre did not expect; nothing was changed here, check the provider's key page");

/**
 * Run a revoke step, turning any throw into a report, since the new key is already stored.
 * @param {() => Promise<Revoked>} f
 * @returns {() => Promise<Revoked>}
 */
const reporting = f => async () => {
  try { return await f(); } catch (e) { return { revoked: false, reason: e instanceof Error ? e.message : "the old credential could not be revoked" }; }
};

// ---- AWS ---------------------------------------------------------------------------------------

/** @param {string|Buffer} s */
const sha256hex = s => crypto.createHash("sha256").update(s).digest("hex");
/** @param {crypto.BinaryLike} k @param {string} s */
const hmac = (k, s) => crypto.createHmac("sha256", k).update(s).digest();
/** RFC 3986 encoding, as SigV4 wants it. @param {string} s */
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
/** @param {[string, string]} a @param {[string, string]} b */
const byPair = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

/**
 * AWS Signature Version 4. `headers` must include host and x-amz-date; every header given is
 * signed. Returns the Authorization value and the parts, for tests.
 * @param {{ method: string, url: string, headers: Record<string, string>, body?: string, accessKeyId: string, secretAccessKey: string, region: string, service: string, amzDate: string }} a
 */
export function signV4({ method, url, headers, body = "", accessKeyId, secretAccessKey, region, service, amzDate }) {
  const u = new URL(url);
  const h = Object.entries(headers).map(([k, v]) => /** @type {[string, string]} */ ([k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")])).sort(byPair);
  const signedHeaders = h.map(([k]) => k).join(";");
  const query = [...u.searchParams].map(([k, v]) => /** @type {[string, string]} */ ([enc(k), enc(v)])).sort(byPair).map(([k, v]) => `${k}=${v}`).join("&");
  const path = u.pathname.split("/").map(s => enc(decodeURIComponent(s))).join("/") || "/";
  const canonicalRequest = [method.toUpperCase(), path, query, h.map(([k, v]) => `${k}:${v}\n`).join(""), signedHeaders, sha256hex(body)].join("\n");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, date), region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(stringToSign).digest("hex");
  return { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, signature, canonicalRequest, stringToSign };
}

/** @param {number} ms */
const amzDateOf = ms => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** @param {string} xml @param {string} tag */
function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]{1,4096})</${tag}>`).exec(xml);
  return m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim() : "";
}

/** IAM error codes that mean something a person can act on. The code itself is a fixed word. */
const AWS_CODES = {
  InvalidClientTokenId: "the current access key was refused; it may already be deleted or deactivated",
  SignatureDoesNotMatch: "the secret key does not match the access key id; check both fields",
  AccessDenied: "this key's user may not manage its own access keys (it needs iam:CreateAccessKey and iam:DeleteAccessKey on itself)",
  LimitExceeded: "the user already has two access keys, the most AWS allows; delete the unused one in the IAM console, then try again",
  ExpiredToken: "the credentials have expired",
};

/**
 * One signed IAM Query API call.
 * @param {Ctx} ctx @param {{ id: string, secret: string }} key @param {Record<string, string>} params
 */
async function iam(ctx, key, params) {
  const url = ctx.base("aws") + "/";
  const body = new URLSearchParams({ ...params, Version: "2010-05-08" }).toString();
  const amzDate = amzDateOf(ctx.now());
  const headers = { "content-type": "application/x-www-form-urlencoded; charset=utf-8", host: new URL(url).host, "x-amz-date": amzDate };
  const { authorization } = signV4({ method: "POST", url, headers, body, accessKeyId: key.id, secretAccessKey: key.secret, region: "us-east-1", service: "iam", amzDate });
  const { host: _h, ...sent } = headers;
  const res = await call("aws", ctx, url, { method: "POST", headers: { ...sent, authorization }, body });
  return { ...res, code: /^[A-Za-z.]{1,64}$/.test(xmlText(res.text, "Code")) ? xmlText(res.text, "Code") : "" };
}

/** @param {{ status: number, code: string }} res */
function awsError(res) {
  const known = AWS_CODES[/** @type {keyof typeof AWS_CODES} */ (res.code)];
  if (known) return fail("aws", known);
  return statusError("aws", res.status, "access key", AWS_CODES.AccessDenied);
}

/** @param {Record<string, string>} f @param {Ctx} ctx @returns {Promise<Rotated>} */
async function aws(f, ctx) {
  const old = { id: need("aws", f, "access_key_id"), secret: need("aws", f, "secret_access_key") };
  const res = await iam(ctx, old, { Action: "CreateAccessKey" });
  if (!res.ok) throw awsError(res);
  const next = { id: xmlText(res.text, "AccessKeyId"), secret: xmlText(res.text, "SecretAccessKey") };
  if (!/^[A-Z0-9]{16,128}$/.test(next.id) || !next.secret) throw unexpected("aws");
  return {
    fields: { ...f, access_key_id: next.id, secret_access_key: next.secret },
    // The old key is deleted with the new one, which proves the new one works before the old goes.
    revoke: reporting(async () => {
      const del = await iam(ctx, next, { Action: "DeleteAccessKey", AccessKeyId: old.id });
      if (del.ok) return { revoked: true };
      if (del.code === "NoSuchEntity") return { revoked: true, reason: "the old key was already deleted" };
      // IAM takes a few seconds to accept a brand new key everywhere.
      if (del.code === "InvalidClientTokenId") return { revoked: false, reason: "AWS: the new key is not active everywhere yet (this takes a few seconds); revoke again in a minute" };
      return { revoked: false, reason: awsError(del).message };
    }),
  };
}

// ---- GitLab ------------------------------------------------------------------------------------

// With no expires_at GitLab gives the new token one week, which would quietly shorten a long-lived
// token; 90 days stays under every lifetime cap GitLab ships with.
const GITLAB_DAYS = 90;

/** @param {Record<string, string>} f @param {Ctx} ctx @returns {Promise<Rotated>} */
async function gitlab(f, ctx) {
  const token = need("gitlab", f, "token");
  const expiresAt = new Date(ctx.now() + GITLAB_DAYS * 86400_000).toISOString().slice(0, 10);
  const res = await call("gitlab", ctx, `${ctx.base("gitlab")}/api/v4/personal_access_tokens/self/rotate`, {
    method: "POST", headers: { "PRIVATE-TOKEN": token, "content-type": "application/json" }, body: JSON.stringify({ expires_at: expiresAt }),
  });
  if (res.status === 400) throw fail("gitlab", `the instance refused a ${GITLAB_DAYS}-day expiry; its token lifetime limit may be shorter, so rotate by hand`);
  if (res.status === 404) throw fail("gitlab", "this GitLab has no self-rotation (it needs GitLab 16.10 or later), so rotate by hand");
  if (!res.ok) throw statusError("gitlab", res.status, "token", "the token may not rotate itself; it needs the api or self_rotate scope");
  const body = jsonOf(res.text);
  if (!body || typeof body.token !== "string" || !body.token) throw unexpected("gitlab");
  /** @type {Rotated} */
  const out = { fields: { ...f, token: body.token }, revoke: async () => ({ revoked: true, reason: "GitLab revoked the old token when it made the new one" }) };
  const exp = typeof body.expires_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.expires_at) ? Date.parse(`${body.expires_at}T00:00:00Z`) : NaN;
  if (Number.isFinite(exp)) out.expires = exp;
  return out;
}

// ---- Cloudflare --------------------------------------------------------------------------------

/** @param {Item} item @param {Record<string, string>} f @param {Ctx} ctx @returns {Promise<Rotated>} */
async function cloudflare(item, f, ctx) {
  const field = item.kind === "pat" ? "token" : "value";
  const token = need("cloudflare", f, field);
  const base = `${ctx.base("cloudflare")}/client/v4/user/tokens`;
  const auth = { authorization: `Bearer ${token}` };
  const who = await call("cloudflare", ctx, `${base}/verify`, { method: "GET", headers: auth });
  if (who.status === 400 || who.status === 401) throw fail("cloudflare", "the current token was refused; it may already be revoked");
  if (!who.ok) throw statusError("cloudflare", who.status, "token", "the token may not look itself up");
  const v = jsonOf(who.text);
  const id = v && v.success === true && v.result && typeof v.result.id === "string" ? v.result.id : "";
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw unexpected("cloudflare");
  if (v.result.status && v.result.status !== "active") throw fail("cloudflare", "the current token is not active; roll it by hand or make a new one");
  const res = await call("cloudflare", ctx, `${base}/${id}/value`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw statusError("cloudflare", res.status, "token", "the token may not roll itself; it needs the API Tokens Write permission, so roll it by hand");
  const body = jsonOf(res.text);
  if (!body || body.success !== true || typeof body.result !== "string" || !body.result) throw unexpected("cloudflare");
  /** @type {Rotated} */
  const out = { fields: { ...f, [field]: body.result }, revoke: async () => ({ revoked: true, reason: "Cloudflare stopped the old value when it rolled the token" }) };
  // Rolling keeps the token's settings, its end date among them.
  const exp = typeof v.result.expires_on === "string" ? Date.parse(v.result.expires_on) : NaN;
  if (Number.isFinite(exp)) out.expires = exp;
  return out;
}

// ---- Google Cloud ------------------------------------------------------------------------------

/**
 * A service-account key file, checked for what rotation needs.
 * @param {string} text
 * @returns {{ client_email: string, private_key: string, private_key_id: string, token_uri?: string }}
 */
function saKey(text) {
  const k = jsonOf(text);
  if (!k || typeof k !== "object" || typeof k.client_email !== "string" || typeof k.private_key !== "string" || typeof k.private_key_id !== "string")
    throw fail("gcp", "the json field is not a service-account key file (it needs client_email, private_key and private_key_id)");
  if (!/^[^\s/@]{1,128}@[^\s/@]{1,253}$/.test(k.client_email) || !/^[\w-]{1,128}$/.test(k.private_key_id))
    throw fail("gcp", "the key file's client_email or private_key_id is not in the usual form");
  return k;
}

/**
 * An access token for a key, from a self-signed JWT (RFC 7523).
 * @param {Ctx} ctx @param {ReturnType<typeof saKey>} k
 */
async function gcpToken(ctx, k) {
  let uri = ctx.endpoints.gcpToken || k.token_uri || DEFAULT_ENDPOINTS.gcpToken;
  // A key file's token_uri is data; the signed assertion goes only to an https endpoint.
  if (!ctx.endpoints.gcpToken && !/^https:\/\//.test(uri)) uri = DEFAULT_ENDPOINTS.gcpToken;
  const iat = Math.floor(ctx.now() / 1000);
  /** @param {object} o */
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT", kid: k.private_key_id })}.${b64({ iss: k.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: uri, iat, exp: iat + 3600 })}`;
  let sig;
  try { sig = crypto.sign("sha256", Buffer.from(unsigned), k.private_key).toString("base64url"); }
  catch { throw fail("gcp", "the key file's private_key could not sign; the file may be damaged"); }
  const res = await call("gcp", ctx, uri, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }).toString(),
  });
  // Google answers a deleted or disabled key with 400 invalid_grant.
  if (res.status === 400 || res.status === 401) throw fail("gcp", "the current key was refused; it may already be deleted or disabled");
  if (!res.ok) throw statusError("gcp", res.status, "key", "the service account may not get tokens");
  const body = jsonOf(res.text);
  if (!body || typeof body.access_token !== "string" || !body.access_token) throw unexpected("gcp");
  return /** @type {string} */ (body.access_token);
}

/** @param {Record<string, string>} f @param {Ctx} ctx @returns {Promise<Rotated>} */
async function gcp(f, ctx) {
  const old = saKey(need("gcp", f, "json"));
  const keys = `${ctx.base("gcp")}/v1/projects/-/serviceAccounts/${encodeURIComponent(old.client_email)}/keys`;
  const token = await gcpToken(ctx, old);
  const res = await call("gcp", ctx, keys, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE" }),
  });
  if (res.status === 400) throw fail("gcp", "Google would not make a new key; an organization policy may block service-account keys, or the account already has 10 keys");
  if (!res.ok) throw statusError("gcp", res.status, "key", "the service account may not create its own keys (it needs iam.serviceAccountKeys.create on itself, as in Service Account Key Admin)");
  const body = jsonOf(res.text);
  if (!body || typeof body.privateKeyData !== "string") throw unexpected("gcp");
  const json = Buffer.from(body.privateKeyData, "base64").toString("utf8");
  let next;
  try { next = saKey(json); } catch { throw unexpected("gcp"); }
  if (next.client_email !== old.client_email) throw unexpected("gcp");
  /** @type {Rotated} */
  const out = {
    fields: { ...f, json },
    revoke: reporting(async () => {
      let t;
      // A new key can take a minute before Google accepts it.
      try { t = await gcpToken(ctx, next); }
      catch { return { revoked: false, reason: "Google Cloud: the new key is not accepted yet (this can take a minute); revoke again shortly" }; }
      const del = await call("gcp", ctx, `${keys}/${encodeURIComponent(old.private_key_id)}`, { method: "DELETE", headers: { authorization: `Bearer ${t}` } });
      if (del.ok) return { revoked: true };
      if (del.status === 404) return { revoked: true, reason: "the old key was already deleted" };
      return { revoked: false, reason: statusError("gcp", del.status, "key", "the service account may not delete its own keys; delete the old one by hand in the console").message };
    }),
  };
  const exp = typeof body.validBeforeTime === "string" && !body.validBeforeTime.startsWith("9999") ? Date.parse(body.validBeforeTime) : NaN;
  if (Number.isFinite(exp)) out.expires = exp;
  return out;
}
