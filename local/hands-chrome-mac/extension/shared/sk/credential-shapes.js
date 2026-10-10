// GENERATED from lib/credential-shapes.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// credential-shapes: what a credential LOOKS LIKE, in one place (consolidation inventory item 3, R031-00c). Folds lib/secret-detect.js, lib/secret-shapes.js, lib/secret-text.js and core/vault/detect.js
// (a re-export) into one module, and is the one list of vendor key shapes the rest of the repo reads: lib/sanitize.js (transcripts), core/sync/scrub.js (session files), core/memory/write.js (memory writes),
// core/github/git.js (outgoing pushes), core/artifacts (public links), core/work/memory/scrub.js, the recall indexer, site knowledge and the Vault's .env import all take their vendor patterns from SHAPES.
//
// One row per vendor shape. `value` is the whole-value form (anchored: "is this variable's value an Anthropic key?"). `find` is the form that finds one inside text (broad: a recorded transcript, a
// session file, a push). `scan` (optional) is `find` without an overlap with another vendor's shape, for the callers that report WHICH shape matched; `share` is the narrower, high-confidence form used where a false hit refuses something the person asked for (a public artifact link): `true` means `find` is already that. `name`
// is what a message calls it; `label` is the short word the transcript redactor puts in its marker. A new vendor key is ONE row here (test/credential-shapes-single.test.js fails when a vendor prefix is
// typed anywhere else).
//
// Not here: recognising a sealed PERSONAL-data class (kernel/seal/classes.js) and removing a KNOWN value (lib/scrub.js).

/**
 * @typedef {"api-key"|"pat"|"oauth"|"cloud"|"db-url"|"private-key"|"cert"|"jwt"|"webhook"|"password"|"secret"|"config"} Type
 * @typedef {{ secret: boolean, type: Type, provider?: string, mode?: "live"|"test", expires?: number, public?: true }} Classification
 */


/**
 * @typedef {{ id: string, provider?: string, type?: Type, mode?: "live"|"test", secret?: boolean, name?: string, label?: string, shareName?: string, value?: RegExp, find?: RegExp, scan?: RegExp, share?: RegExp | true, noPrefix?: boolean, prefixExtra?: string[], noClassify?: boolean }} Shape
 */

/** @type {readonly Shape[]} */
export const SHAPES = Object.freeze([
  { id: "anthropic", provider: "anthropic", type: "api-key", value: /^sk-ant-[\w-]{20,}$/, name: "Anthropic key", label: "Anthropic key", find: /\bsk-ant-[A-Za-z0-9_\-]{20,}/g, share: true },
  { id: "anthropic-oat", provider: "anthropic", type: "oauth", noClassify: true, noPrefix: true, name: "Anthropic setup token", value: /^sk-ant-oat[A-Za-z0-9_-]{20,}$/, find: /sk-ant-oat01-[A-Za-z0-9_-]{20,}/ },
  { id: "openrouter", provider: "openrouter", type: "api-key", value: /^sk-or-[\w-]{20,}$/ },
  { id: "openai", provider: "openai", type: "api-key", value: /^sk-(proj|svcacct|admin)-[\w-]{20,}$/, name: "OpenAI key", label: "API key", scan: /\bsk-(?!ant-)[A-Za-z0-9_\-]{16,}/g, find: /\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_\-]{20,}/g, share: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: "openai-2", provider: "openai", type: "api-key", value: /^sk-[A-Za-z0-9]{48,}$/ },
  { id: "stripe", prefixExtra: ["sk_", "rk_"], provider: "stripe", type: "api-key", mode: "live", value: /^(sk|rk)_live_[A-Za-z0-9]{16,}$/, name: "Stripe key", label: "Stripe key", find: /\b[prs]k_(?:live|test)_[A-Za-z0-9]{20,}/g, share: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/, shareName: "Stripe secret key" },
  { id: "stripe-2", provider: "stripe", type: "api-key", mode: "test", value: /^(sk|rk)_test_[A-Za-z0-9]{16,}$/ },
  { id: "stripe-3", provider: "stripe", type: "config", mode: "live", secret: false, value: /^pk_live_[A-Za-z0-9]{16,}$/ },
  { id: "stripe-4", provider: "stripe", type: "config", mode: "test", secret: false, value: /^pk_test_[A-Za-z0-9]{16,}$/ },
  { id: "stripe-5", provider: "stripe", type: "webhook", value: /^whsec_[A-Za-z0-9+/=]{16,}$/ },
  { id: "github", provider: "github", type: "pat", value: /^ghp_[A-Za-z0-9]{30,}$/, name: "GitHub token", label: "GitHub token", find: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, share: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: "github-2", provider: "github", type: "pat", value: /^github_pat_[A-Za-z0-9_]{40,}$/ },
  { id: "github-3", provider: "github", type: "oauth", value: /^(gho|ghu|ghr)_[A-Za-z0-9]{30,}$/ },
  { id: "github-4", provider: "github", type: "api-key", value: /^ghs_[A-Za-z0-9]{30,}$/ },
  { id: "gitlab", provider: "gitlab", type: "pat", value: /^glpat-[\w-]{20,}$/ },
  { id: "slack", provider: "slack", type: "oauth", value: /^xox[pare]-[A-Za-z0-9-]{10,}$/, name: "Slack token", label: "Slack token", find: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, share: true },
  { id: "slack-2", provider: "slack", type: "api-key", value: /^xoxb-[A-Za-z0-9-]{10,}$/ },
  { id: "slack-3", provider: "slack", type: "api-key", value: /^xapp-[A-Za-z0-9-]{10,}$/ },
  { id: "aws", provider: "aws", type: "cloud", value: /^(AKIA|ASIA)[A-Z0-9]{16}$/, name: "AWS access key", label: "AWS key id", find: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, share: true },
  { id: "google", provider: "google", type: "api-key", value: /^AIza[\w-]{35}$/, name: "Google API key", label: "Google key", find: /\bAIza[0-9A-Za-z_\-]{30,}/g, share: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "google-2", provider: "google", type: "oauth", value: /^GOCSPX-[\w-]{20,}$/ },
  { id: "google-3", provider: "google", type: "oauth", value: /^ya29\.[\w.-]{20,}$/ },
  { id: "google-4", noPrefix: true, provider: "google", type: "oauth", value: /^1\/\/[\w-]{20,}$/ },
  { id: "sendgrid", provider: "sendgrid", type: "api-key", value: /^SG\.[\w-]{16,}\.[\w-]{16,}$/, name: "SendGrid key", label: "SendGrid key", find: /\bSG\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/g },
  { id: "resend", noPrefix: true, provider: "resend", type: "api-key", value: /^re_[A-Za-z0-9_]{16,}$/ },
  { id: "mailgun", noPrefix: true, provider: "mailgun", type: "api-key", value: /^key-[0-9a-f]{32}$/ },
  { id: "twilio", noPrefix: true, provider: "twilio", type: "api-key", value: /^SK[0-9a-f]{32}$/ },
  { id: "twilio-2", noPrefix: true, provider: "twilio", type: "config", secret: false, value: /^AC[0-9a-f]{32}$/ },
  { id: "npm", provider: "npm", type: "api-key", value: /^npm_[A-Za-z0-9]{36}$/, name: "npm token", label: "npm token", find: /\bnpm_[A-Za-z0-9]{36}\b/g, share: true },
  { id: "pypi", provider: "pypi", type: "api-key", value: /^pypi-[\w-]{50,}$/ },
  { id: "huggingface", provider: "huggingface", type: "api-key", value: /^hf_[A-Za-z0-9]{30,}$/ },
  { id: "digitalocean", provider: "digitalocean", type: "pat", value: /^dop_v1_[a-f0-9]{64}$/, name: "DigitalOcean token", label: "DO token", find: /\bdop_v1_[a-f0-9]{32,}/gi },
  { id: "digitalocean-2", provider: "digitalocean", type: "oauth", value: /^do[or]_v1_[a-f0-9]{64}$/ },
  { id: "perplexity", provider: "perplexity", type: "api-key", value: /^pplx-[A-Za-z0-9]{40,}$/ },
  { id: "shopify", provider: "shopify", type: "api-key", value: /^shp(at|ca|pa)_[a-fA-F0-9]{32}$/ },
  { id: "shopify-2", provider: "shopify", type: "api-key", value: /^shpss_[a-fA-F0-9]{32}$/ },
  { id: "square", provider: "square", type: "api-key", value: /^sq0atp-[\w-]{20,}$/ },
  { id: "square-2", provider: "square", type: "oauth", value: /^sq0csp-[\w-]{20,}$/ },
  { id: "linear", provider: "linear", type: "api-key", value: /^lin_api_[A-Za-z0-9]{32,}$/ },
  { id: "linear-2", provider: "linear", type: "oauth", value: /^lin_oauth_[A-Za-z0-9]{32,}$/ },
  { id: "notion", provider: "notion", type: "api-key", value: /^(ntn|secret)_[A-Za-z0-9]{40,}$/ },
  { id: "airtable", noPrefix: true, provider: "airtable", type: "pat", value: /^pat[A-Za-z0-9]{14}\.[a-f0-9]{64}$/ },
  { id: "hubspot", provider: "hubspot", type: "pat", value: /^pat-(na|eu)\d-[a-f0-9-]{36}$/ },
  { id: "sentry", provider: "sentry", type: "api-key", value: /^sntry[su]_[A-Za-z0-9+/=_]{40,}$/ },
  { id: "pinecone", provider: "pinecone", type: "api-key", value: /^pcsk_[A-Za-z0-9_]{20,}$/ },
  { id: "jina", provider: "jina", type: "api-key", value: /^jina_[A-Za-z0-9_]{20,}$/ },
  { id: "apify", provider: "apify", type: "api-key", value: /^apify_api_[A-Za-z0-9]{20,}$/ },
  { id: "supabase", provider: "supabase", type: "api-key", value: /^sb_secret_[\w-]{16,}$/ },
  { id: "supabase-2", provider: "supabase", type: "config", secret: false, value: /^sb_publishable_[\w-]{16,}$/ },
  { id: "telegram", noPrefix: true, provider: "telegram", type: "api-key", value: /^\d{8,10}:[\w-]{35}$/ },
  { id: "discord", noPrefix: true, provider: "discord", type: "api-key", value: /^[MNO][A-Za-z0-9_-]{23,27}\.[\w-]{6,7}\.[\w-]{27,}$/ },
  { id: "aws-secret", name: "AWS secret", label: "AWS secret", find: /\b(?<=aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{40}/gi },
  { id: "slack-app", name: "Slack app token", label: "Slack app token", find: /\bxapp-[0-9]-[A-Za-z0-9]+-[0-9]+-[A-Za-z0-9]{16,}/g },
  { id: "slack-refresh", name: "Slack refresh token", label: "Slack refresh token", find: /\bxoxe(?:\.xoxp)?-[0-9]-[A-Za-z0-9-]{20,}/g },
  { id: "jwt", name: "JSON web token", label: "JWT", find: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{6,}/g },
  { id: "bearer", name: "bearer token", label: "bearer token", find: /\bBearer\s+[A-Za-z0-9._\-]{24,}/g },
  { id: "tailscale", name: "Tailscale key", label: "Tailscale key", find: /\btskey-[a-z]+-[A-Za-z0-9]{10,}/g },
  { id: "deepgram", name: "Deepgram key", label: "Deepgram key", find: /\b(?<=deepgram[_-]?(?:api[_-]?)?key\s*[=:]\s*["']?)[a-f0-9]{32,}/gi },
]);

/** One shape by id. @param {string} id */
const shapeOf = id => SHAPES.find(s => s.id === id);

/**
 * The text-finding rules for the shapes named, as `[id, regex, label]` in the order asked (a fresh regex each time, so no caller shares `lastIndex` with another). The transcript redactor takes its vendor
 * rules from here.
 * @param {string[]} ids @returns {Array<[string, RegExp, string]>}
 */
export function findRules(ids) {
  return ids.map(id => {
    const s = shapeOf(id);
    if (!s || !s.find) throw new Error(`credential-shapes: no text rule ${id}`);
    return /** @type {[string, RegExp, string]} */ ([s.id, new RegExp(s.find.source, s.find.flags), s.label || s.name || s.id]);
  });
}

/** Which shapes each use looks for. Every use also looks for a private key header. */
const USES = {
  share: ["aws", "github", "slack", "stripe", "anthropic", "openai", "google", "npm"],   // a public artifact link: high confidence only
  ingest: ["anthropic", "openai", "github", "slack", "aws", "google", "stripe", "npm"],          // a session file arriving through sync
  memory: ["anthropic", "openai", "github", "slack", "aws", "google", "stripe", "npm"],          // a memory write
  push: ["aws", "github", "slack"],                                                       // the added lines of an outgoing push
};
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
// The private-key forms, written once. A key is recognised by its first line (PEM, OpenSSH and PuTTY all say so), found as a whole block, or as a block whose END line was clipped (to the end of the text).
const PK_BEGIN = "-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----", PK_END = "-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----";
/** The first line of a private key file (PEM, OpenSSH) or a PuTTY key's, for a file sniff. */
export const PRIVATE_KEY_HEAD = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-/;
/** Does the text hold a private key header? @param {unknown} text */
export const hasPrivateKey = text => PRIVATE_KEY.test(String(text ?? ""));
/** A fresh global regex for a whole private key block, or one whose END line is missing (a clipped paste), through to the end of the text. @param {"whole"|"clipped"} [form] */
export const privateKeyBlock = (form = "whole") => new RegExp(form === "whole" ? `${PK_BEGIN}[\\s\\S]*?${PK_END}` : `${PK_BEGIN}[\\s\\S]*`, "g");
/**
 * Which Anthropic credential a token is: "subscription" (a setup token, sk-ant-oat...), "api-key" (sk-ant-...), or null. The shapes are the table's own.
 * @param {unknown} token @returns {"subscription"|"api-key"|null}
 */
export function anthropicKind(token) {
  const t = String(token ?? "");
  const oat = shapeOf("anthropic-oat"), key = shapeOf("anthropic");
  if (oat && oat.value && oat.value.test(t)) return "subscription";
  return key && key.value && key.value.test(t) ? "api-key" : null;
}

/**
 * The matchers for one use: `{ name, re }` per shape (no `g` flag, so `.test` is stateless), private key last. Names, never matches, are what a caller reports.
 * @param {"share"|"ingest"|"memory"|"push"} use @returns {Array<{ name: string, re: RegExp }>}
 */
export function finders(use) {
  /** @type {Array<{ name: string, re: RegExp }>} */ const out = [];
  for (const id of USES[use]) {
    const s = shapeOf(id);
    /** @type {RegExp | undefined} */ const src = !s ? undefined : use === "share" ? (s.share === true ? s.find : s.share instanceof RegExp ? s.share : undefined) : (s.scan || s.find);
    if (!s || !src) throw new Error(`credential-shapes: ${use} has no rule for ${id}`);
    out.push({ name: (use === "share" && s.shareName) || s.name || s.id, re: new RegExp(src.source, src.flags.replace("g", "")) });
  }
  out.push({ name: "private key", re: PRIVATE_KEY });
  return out;
}

/** The name of the first credential shape of this use in the text, or null. Never the match. @param {string} text @param {"share"|"ingest"|"memory"|"push"} use */
export function credentialIn(text, use) {
  const s = String(text ?? "");
  for (const f of finders(use)) if (f.re.test(s)) return f.name;
  return null;
}

/** The leading literal text(s) of a shape's regex: `^sk-ant-[...]` gives "sk-ant-", `^(sk|rk)_live_` gives both, `\\bxox[abprs]-` gives five. Stops at the first thing that is not plain text. @param {RegExp} re */
function leadingLiterals(re) {
  const s = re.source.replace(/^\^/, "").replace(/^\\b/, "");
  let outs = [""], i = 0;
  const quant = (/** @type {string} */ c) => /[?*+{]/.test(c || "");
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && /[./-]/.test(s[i + 1] || "")) { outs = outs.map(o => o + s[i + 1]); i += 2; continue; }
    if (/[A-Za-z0-9_.-]/.test(c) && !quant(s[i + 1])) { outs = outs.map(o => o + c); i++; continue; }
    if (c === "(") { const j = s.indexOf(")", i); const alts = s.slice(i + 1, j).replace(/^\?:/, "").split("|"); if (!alts.every(a => /^[A-Za-z0-9_.-]+$/.test(a)) || quant(s[j + 1])) break; outs = outs.flatMap(o => alts.map(a => o + a)); i = j + 1; continue; }
    if (c === "[") { const j = s.indexOf("]", i); const body = s.slice(i + 1, j); if (!/^[A-Za-z0-9]+$/.test(body) || quant(s[j + 1])) break; outs = outs.flatMap(o => [...body].map(b => o + b)); i = j + 1; continue; }
    break;
  }
  return outs;
}

/** Every vendor key prefix the table implies (three characters or more), from the whole-value and find forms of the rows that have a whole-value form. A row marked noPrefix is too short or generic to stand as a prefix on its own. */
export const CREDENTIAL_PREFIXES = Object.freeze([...new Set(SHAPES.flatMap(s => s.noPrefix || !s.value ? [] : [...leadingLiterals(s.value), ...(s.find ? leadingLiterals(s.find) : []), ...(s.prefixExtra || [])]).filter(p => p.length >= 3))]);

/** Does this value merely START like a vendor key (even a short or cut one)? Looser than a shape on purpose: the caller refuses on a hint. @param {string} v */
export const startsLikeCredential = v => CREDENTIAL_PREFIXES.some(p => String(v).startsWith(p));

/** Does this text carry a vendor key prefix or a PEM header ANYWHERE? The blunt check for lines that must not be shown at all. @param {string} t */
export const mentionsCredentialPrefix = t => { const s = String(t); return s.includes("-----BEGIN") || CREDENTIAL_PREFIXES.some(p => s.includes(p)); };

/** Is this whole value one of the table's vendor shapes? @param {string} v */
export const isKnownShape = v => SHAPES.some(s => s.value && s.value.test(String(v)));

/**
 * Does the text hold a vendor key that begins a TOKEN (not inside a longer word or a random id, where a prefix turns up by chance)? The kernel's event-payload guard.
 * @param {string} text
 */
export function credentialAtTokenStart(text) {
  const t = String(text);
  for (const f of finders("ingest")) {
    const re = new RegExp(f.re.source, f.re.flags + "g");
    let m;
    while ((m = re.exec(t))) {
      const prev = m.index > 0 ? t[m.index - 1] : "";
      if (!/[A-Za-z0-9_-]/.test(prev)) return true;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return false;
}

/** A whole-value pattern STRING for a form field, from the table: `^(?:a|b)$` over the named shapes' value forms. @param {...string} ids */
export function valuePattern(...ids) {
  const parts = ids.map(id => { const s = shapeOf(id); if (!s || !s.value) throw new Error(`credential-shapes: no value shape ${id}`); return s.value.source.replace(/^\^/, "").replace(/\$$/, ""); });
  return parts.length === 1 ? `^${parts[0]}$` : `^(?:${parts.join("|")})$`;
}

/** A fresh copy of a shape's find-in-text regex. @param {string} id */
export function findRegExp(id) { const s = shapeOf(id); if (!s || !s.find) throw new Error(`credential-shapes: no text rule ${id}`); return new RegExp(s.find.source, s.find.flags); }


const MAX = 8192;

/** @type {Array<[RegExp, Omit<Classification, "secret"> & { secret?: boolean }]>} The anchored vendor shapes, in the order the table lists them. */
const PREFIXES = SHAPES.flatMap(s => (s.value && !s.noClassify ? [/** @type {[RegExp, Omit<Classification, "secret"> & { secret?: boolean }]} */ ([s.value, { type: /** @type {Type} */ (s.type), provider: s.provider, ...(s.mode ? { mode: s.mode } : {}), ...(s.secret === false ? { secret: false } : {}) }])] : []));

/** @type {Record<string, string>} */
const DB_SCHEMES = {
  "postgres:": "postgres", "postgresql:": "postgres",
  "mysql:": "mysql", "mysql2:": "mysql",
  "mongodb:": "mongodb", "mongodb+srv:": "mongodb",
  "redis:": "redis", "rediss:": "redis",
  "amqp:": "amqp", "amqps:": "amqp",
};

/** @type {Record<string, string>} Name segments that name a provider on their own. */
const NAME_PROVIDERS = {
  STRIPE: "stripe", OPENAI: "openai", ANTHROPIC: "anthropic", CLAUDE: "anthropic", OPENROUTER: "openrouter",
  GITHUB: "github", GH: "github", GITLAB: "gitlab", SLACK: "slack", AWS: "aws", GCP: "gcp", GCLOUD: "gcp",
  GOOGLE: "google", AZURE: "azure", TWILIO: "twilio", SENDGRID: "sendgrid", RESEND: "resend",
  MAILGUN: "mailgun", SUPABASE: "supabase", CLOUDFLARE: "cloudflare", DIGITALOCEAN: "digitalocean",
  RAILWAY: "railway", VERCEL: "vercel", NPM: "npm", PYPI: "pypi", HF: "huggingface",
  HUGGINGFACE: "huggingface", DEEPGRAM: "deepgram", ELEVENLABS: "elevenlabs", PERPLEXITY: "perplexity",
  PPLX: "perplexity", POSTGRES: "postgres", POSTGRESQL: "postgres", MYSQL: "mysql", MONGO: "mongodb",
  MONGODB: "mongodb", REDIS: "redis", RABBITMQ: "amqp", AMQP: "amqp", SENTRY: "sentry",
  DISCORD: "discord", TELEGRAM: "telegram", SHOPIFY: "shopify", SQUARE: "square", PAYPAL: "paypal",
  DATADOG: "datadog", LINEAR: "linear", NOTION: "notion", AIRTABLE: "airtable", HUBSPOT: "hubspot",
  PINECONE: "pinecone", JINA: "jina", APIFY: "apify",
};
const PG_NAMES = new Set(["PGPASSWORD", "PGHOST", "PGUSER", "PGDATABASE", "PGPORT"]);

const PUBLIC_NAME = /^(NEXT_PUBLIC_|VITE_|REACT_APP_PUBLIC_|EXPO_PUBLIC_|PUBLIC_)/;
const PLAIN_NAMES = new Set(["PORT", "HOST", "HOSTNAME", "NODE_ENV", "LOG_LEVEL", "TZ", "ENV", "APP_ENV",
  "ENVIRONMENT", "DEBUG", "LANG", "PATH", "HOME", "SHELL", "USER", "CI"]);
const CONFIG_SUFFIX = /_(URL|URI|ENDPOINT|HOST|HOSTNAME|PORT|ENABLED|DISABLED|REGION|BUCKET|ID|NAME|ENV|MODE|LEVEL|PATH|DIR|FILE|TIMEOUT|TTL|VERSION|EMAIL|USER|USERNAME|LOCALE|ZONE|PROJECT)$/;
const PASSWORD_NAME = /(PASSWORD|PASSWD|(^|_)(PASS|PWD))$/;
const SECRET_NAME = /(SECRET|PRIVATE_KEY|SIGNING_KEY|ENCRYPTION_KEY|SALT)/;
const TOKEN_NAME = /(TOKEN|API_KEY|APIKEY|ACCESS_KEY|AUTH)/;
const PAT_NAME = /((^|_)PAT(_|$)|PERSONAL_ACCESS)/;
const DB_NAME = /(DATABASE_URL|DB_URL|_DSN$)/;
const BOOL = /^(true|false|yes|no|on|off)$/i;

/**
 * Classify one environment variable. Never throws; unreadable input comes back as a secret, since
 * the safe mistake is vaulting a config value, not leaving a key in plain text.
 * @param {unknown} name
 * @param {unknown} value
 * @returns {Classification}
 */
export function classify(name, value) {
  try {
    return run(String(name ?? "").trim().toUpperCase(), unquote(String(value ?? "").slice(0, MAX)));
  } catch {
    return { secret: true, type: "secret" };
  }
}

/** @param {string} v */
function unquote(v) {
  let s = v.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) s = s.slice(1, -1).trim();
  return s;
}

/**
 * @param {string} name upper-cased
 * @param {string} value
 * @returns {Classification}
 */
function run(name, value) {
  const provider = nameProvider(name);
  const byValue = value ? fromValue(name, value) : null;
  if (PUBLIC_NAME.test(name)) {
    if (byValue && byValue.secret) return withProvider({ ...byValue, public: true }, provider);
    return withProvider(byValue ?? { secret: false, type: "config" }, provider);
  }
  if (byValue) return withProvider(byValue, provider);
  return withProvider(fromName(name, value, provider), provider);
}

/**
 * @param {Classification} r
 * @param {string|undefined} provider
 */
function withProvider(r, provider) {
  if (!r.provider && provider) r.provider = provider;
  return r;
}

/** @param {string} name */
function nameProvider(name) {
  if (PG_NAMES.has(name)) return "postgres";
  for (const seg of name.replace(PUBLIC_NAME, "").split("_")) {
    if (Object.prototype.hasOwnProperty.call(NAME_PROVIDERS, seg)) return NAME_PROVIDERS[seg];
  }
  return undefined;
}

/**
 * What the value's own shape says, or null when it says nothing.
 * @param {string} name
 * @param {string} v
 * @returns {Classification|null}
 */
function fromValue(name, v) {
  if (v.includes("-----BEGIN")) {
    const m = /-----BEGIN ([A-Z0-9 ]{0,40})-----/.exec(v);
    if (m && /PRIVATE KEY/.test(m[1])) return { secret: true, type: "private-key" };
    if (m && /CERTIFICATE/.test(m[1])) return { secret: false, type: "cert" };
  }
  if (v[0] === "{") {
    // A pasted service-account JSON is the whole credential, private key included.
    if (/"type"\s*:\s*"service_account"/.test(v)) return { secret: true, type: "cloud", provider: "gcp" };
    if (v.includes('"private_key"')) return { secret: true, type: "private-key" };
  }
  if (/(^|;)\s*(AccountKey|SharedAccessKey|SharedAccessSignature)=/i.test(v)) {
    return { secret: true, type: "cloud", provider: "azure" };
  }
  if (/^[a-z][a-z0-9+.-]{0,30}:\/\//i.test(v) || /^jdbc:/i.test(v)) return fromUrl(name, v);
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(v)) return fromJwt(v);
  for (const [re, r] of PREFIXES) {
    if (re.test(v)) return { secret: true, ...r };
  }
  return null;
}

/**
 * @param {string} name
 * @param {string} raw
 * @returns {Classification}
 */
function fromUrl(name, raw) {
  let url;
  try { url = new URL(raw.replace(/^jdbc:/i, "")); } catch { return { secret: false, type: "config" }; }
  const q = url.searchParams;
  const password = !!url.password || !!q.get("password");
  const dbProvider = DB_SCHEMES[url.protocol.toLowerCase()];
  if (dbProvider) return { secret: password, type: password ? "db-url" : "config", provider: dbProvider };
  const host = url.hostname.toLowerCase();
  if (host === "hooks.slack.com" && url.pathname.startsWith("/services/")) {
    return { secret: true, type: "webhook", provider: "slack" };
  }
  if ((host === "discord.com" || host === "discordapp.com") && url.pathname.startsWith("/api/webhooks/")) {
    return { secret: true, type: "webhook", provider: "discord" };
  }
  if (password) return { secret: true, type: DB_NAME.test(name) ? "db-url" : "secret" };
  // A Sentry DSN key only lets you send events, and ships in every browser bundle anyway.
  if ((host === "sentry.io" || host.endsWith(".sentry.io")) && url.username) {
    return { secret: false, type: "config", provider: "sentry" };
  }
  for (const [k, val] of q) {
    if (/^(token|access_token|api_key|apikey|key|secret|sig|signature)$/i.test(k) && val.length >= 16) {
      return { secret: true, type: "secret" };
    }
  }
  // Zapier, Make, n8n and friends: the unguessable path is the credential.
  if (/WEBHOOK/.test(name) && /^https?:$/.test(url.protocol) && url.pathname.length > 8) {
    return { secret: true, type: "webhook" };
  }
  return { secret: false, type: "config" };
}

/**
 * @param {string} v
 * @returns {Classification}
 */
function fromJwt(v) {
  /** @type {Classification} */
  const r = { secret: true, type: "jwt" };
  let claims;
  try { claims = JSON.parse(Buffer.from(v.split(".")[1], "base64url").toString("utf8")); } catch { return r; }
  if (!claims || typeof claims !== "object") return r;
  if (typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > 0) r.expires = claims.exp * 1000;
  const iss = typeof claims.iss === "string" ? claims.iss.toLowerCase() : "";
  if (iss.includes("supabase") || claims.role === "anon" || claims.role === "service_role") {
    r.provider = "supabase";
    // The anon key is meant for browsers; row level security is what guards the data.
    if (claims.role === "anon") { r.secret = false; r.type = "config"; }
  }
  return r;
}

/**
 * No shape matched, so the name and a few cheap value checks decide.
 * @param {string} name
 * @param {string} v
 * @param {string|undefined} provider
 * @returns {Classification}
 */
function fromName(name, v, provider) {
  const config = { secret: false, type: /** @type {Type} */ ("config") };
  if (!v) return config;
  if (PASSWORD_NAME.test(name)) return { secret: true, type: "password" };
  if (PLAIN_NAMES.has(name) || CONFIG_SUFFIX.test(name)) return config;
  const trivial = BOOL.test(v) || /^-?\d{1,6}$/.test(v);
  if (!trivial) {
    if (provider === "aws" && /SECRET/.test(name)) return { secret: true, type: "cloud", provider: "aws" };
    if (/CLIENT_SECRET/.test(name)) return { secret: true, type: "oauth" };
    if (/WEBHOOK/.test(name) && /(SECRET|TOKEN|KEY)/.test(name)) return { secret: true, type: "webhook" };
    if (SECRET_NAME.test(name)) return { secret: true, type: "secret" };
  }
  if (plain(v)) return config;
  if (TOKEN_NAME.test(name)) return { secret: true, type: PAT_NAME.test(name) ? "pat" : "api-key" };
  if (DB_NAME.test(name) && /:[^@\s/]+@/.test(v)) return { secret: true, type: "db-url" };
  if (random(v)) return { secret: true, type: "secret" };
  return config;
}

/**
 * Values nobody would call a secret: numbers, booleans, short words, emails, paths, host:port.
 * @param {string} v
 */
function plain(v) {
  if (BOOL.test(v) || /^-?\d+(\.\d+)?$/.test(v)) return true;
  if (v.length <= 16 && /^[a-z0-9._-]+$/i.test(v) && !(/[a-z]/i.test(v) && /\d/.test(v))) return true;
  if (v.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return true;
  if (/^(~|\.{1,2})?\/[^\s]*$/.test(v)) return true;
  if (v.length <= 253 && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i.test(v) && /[a-z]{2,}$|:\d+$/i.test(v)) return true;
  return false;
}

/**
 * Long, dense and mixed-case or mixed with digits: most likely generated, so treat it as a key.
 * Anything with whitespace is prose, not a key.
 * @param {string} v
 */
function random(v) {
  if (v.length < 20 || /\s/.test(v)) return false;
  const classes = (/[a-z]/.test(v) ? 1 : 0) + (/[A-Z]/.test(v) ? 1 : 0) + (/\d/.test(v) ? 1 : 0);
  return classes >= 2 && entropy(v) >= 3.5;
}

/** @param {string} v Shannon entropy in bits per character. */
function entropy(v) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const ch of v) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / v.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Text that must never sit in the index, where a later memory_ask could quote it. Each rule is a
 * bearer credential or invitation: a Tailscale sign-in link (network.tailscale.login hands it to the
 * person's own session), a setup claim (`#claim=`), a pairing seed (`vyre-pc:`), a private key block.
 * Add a rule here and bump REDACT_VERSION: every turn is cleaned before it is indexed, and the turns
 * already stored are cleaned once at the next pass.
 * @type {{ name: string, re: RegExp, to: string }[]}
 */
export const REDACTIONS = [
  { name: "tailscale-link", re: /https?:\/\/login\.tailscale\.com\/\S*/gi, to: "[tailscale sign-in link removed]" },
  { name: "claim", re: /#claim=[A-Za-z0-9_-]+/g, to: "#claim=[removed]" },
  { name: "pairing-seed", re: /\bvyre-pc:[A-Za-z0-9_-]+/g, to: "vyre-pc:[removed]" },
  // A pairing ticket or setup offer: 43 base64url characters near the word (a Wink ticket, ADR 0045).
  { name: "pair-ticket", re: /\b((?:wink|ticket|pair(?:ing)?|offer)\b[^\n]{0,24}?)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gi, to: "$1[removed]" },
  { name: "private-key", re: new RegExp(`${PK_BEGIN}[\\s\\S]*?(?:${PK_END}|$)`, "g"), to: "[private key removed]" },
];
/** Bumped when REDACTIONS or the token rule changes; a pass cleans stored turns once per version. */
export const REDACT_VERSION = "3";

// A pasted key or token, by the shapes the Vault already knows (core/vault/detect.js). Only a shape
// it names (a provider key, a token, a cloud key, a JWT, a private key, a database URL); its
// "looks random" fallback is left alone, since a commit hash or an id is not a secret.
const KNOWN = new Set(["api-key", "pat", "oauth", "cloud", "jwt", "webhook", "private-key", "db-url"]);
const TOKEN = /[^\s"'`<>()\[\]{},;]{16,512}/g;
/** One bare word: removed when it is a named secret shape (trailing punctuation kept). @param {string} w */
const word = w => {
  const tail = /[.:!?-]+$/.exec(w)?.[0] || "";
  const c = classify("", tail ? w.slice(0, -tail.length) : w);
  return c.secret && KNOWN.has(c.type) ? `[${c.provider || c.type} ${c.type} removed]${tail}` : w;
};
const tokens = (/** @type {string} */ text) => text.replace(TOKEN, w => {
  if (w[0] === "/" || w[0] === ".") return w;
  // A URL keeps its shape; each value in its query or fragment (`?api_key=sk-...`) is read as a word.
  if (/^https?:\/\//i.test(w)) return w.replace(/([?&#;=])([^?&#;=]{16,})/g, (_, d, v) => d + word(v));
  return word(w);
});

/** @param {string} text */
export const redact = text => tokens(REDACTIONS.reduce((t, r) => t.replace(r.re, r.to), String(text)));

/**
 * Where a pasted key or token sits in a message: each span with the shape it matched, so a caller can move the value somewhere safe and put a reference in its place. The same rules as `redact`
 * (a named shape, never the "looks random" fallback), plus a `NAME=value` pair and a whole private key block. Spans never overlap and come in text order.
 * @param {string} text
 * @returns {{ start: number, end: number, value: string, provider: string, type: string, label: string }[]}
 */
export function locateSecrets(text) {
  const s = String(text ?? "");
  /** @type {{ start: number, end: number, value: string, provider: string, type: string, label: string }[]} */
  const out = [];
  const taken = (/** @type {number} */ a, /** @type {number} */ b) => out.some(o => a < o.end && b > o.start);
  const pem = privateKeyBlock("whole");
  for (let m; (m = pem.exec(s));) out.push({ start: m.index, end: m.index + m[0].length, value: m[0], provider: "", type: "private-key", label: "Private key" });
  /** @param {string} w @param {number} at */
  const hit = (w, at) => {
    const tail = /[.:!?-]+$/.exec(w)?.[0] || "";
    const v = tail ? w.slice(0, -tail.length) : w;
    if (v.length < 16 || taken(at, at + v.length)) return;
    const c = classify("", v);
    if (!c.secret || !KNOWN.has(c.type)) return;
    out.push({ start: at, end: at + v.length, value: v, provider: c.provider || "", type: c.type, label: labelOf(c) });
  };
  const tok = new RegExp(TOKEN.source, "g");
  for (let m; (m = tok.exec(s));) {
    let w = m[0], at = m.index;
    if (/^https?:\/\//i.test(w)) {
      const q = /([?&#;=])([^?&#;=]{16,})/g;
      for (let u; (u = q.exec(w));) hit(u[2], at + u.index + 1);
      continue;
    }
    // The whole word first: a token that ends in "=" (base64 padding: a Stripe signing secret, a Sentry token) is one credential, not a NAME= with nothing after it.
    const before = out.length;
    hit(w, at);
    if (out.length > before) continue;
    const pair = /^[A-Za-z0-9_.-]{1,64}[=:]/.exec(w);
    if (pair) { w = w.slice(pair[0].length); at += pair[0].length; hit(w, at); }
  }
  return out.sort((a, b) => a.start - b.start);
}

export const BRANDS = { openai: "OpenAI", github: "GitHub", aws: "AWS", sendgrid: "SendGrid", digitalocean: "DigitalOcean", huggingface: "Hugging Face", openrouter: "OpenRouter", gitlab: "GitLab", pypi: "PyPI", npm: "npm" };
const KIND_WORDS = { "api-key": "key", pat: "token", oauth: "token", cloud: "key", jwt: "token", webhook: "signing secret", "private-key": "private key", "db-url": "database address" };
/** What a message calls a classified credential: "Anthropic key", "GitHub token", or the kind alone. @param {Classification} c */
function labelOf(c) {
  const word = /** @type {Record<string, string>} */ (KIND_WORDS)[c.type] || "secret";
  const name = c.provider ? /** @type {Record<string, string>} */ (BRANDS)[c.provider] || c.provider[0].toUpperCase() + c.provider.slice(1) : "";
  return name ? `${name} ${word}` : word[0].toUpperCase() + word.slice(1);
}

/** Kept for the callers that named it first. @param {string} text */
export const redactLinks = redact;


/**
 * Every credential-shaped string in `text`, by kind and 1-based line. Never returns the match
 * itself, so a refusal can be shown and logged without repeating the secret.
 * @param {string} text
 * @returns {{ kind: string, line: number }[]}
 */
export function findSecrets(text) {
  const SHARE = finders("share");
  /** @type {{ kind: string, line: number }[]} */
  const out = [];
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const f of SHARE) if (f.re.test(lines[i])) out.push({ kind: f.name, line: i + 1 });
  }
  return out;
}

