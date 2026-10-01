// @ts-check
// secret-detect: say what one .env variable is, and whether it belongs in the Vault or stays in the file.
//
// The import preview calls this per line. The result goes on screen next to the variable name, so
// it carries only words from a fixed vocabulary (type, provider, mode) plus an expiry time: never a
// prefix, a length or any other slice of the value. Value shape wins over the name, because names
// lie (NEXT_PUBLIC_STRIPE_KEY=sk_live_...) and shapes mostly do not. Every regex is anchored or
// bounded, and only the first 8 KB of a value is looked at, so a pasted blob cannot stall the UI.

/**
 * @typedef {"api-key"|"pat"|"oauth"|"cloud"|"db-url"|"private-key"|"cert"|"jwt"|"webhook"|"password"|"secret"|"config"} Type
 * @typedef {{ secret: boolean, type: Type, provider?: string, mode?: "live"|"test", expires?: number, public?: true }} Classification
 */

const MAX = 8192;

/** @type {Array<[RegExp, Omit<Classification, "secret"> & { secret?: boolean }]>} */
const PREFIXES = [
  [/^sk-ant-[\w-]{20,}$/, { type: "api-key", provider: "anthropic" }],
  [/^sk-or-[\w-]{20,}$/, { type: "api-key", provider: "openrouter" }],
  [/^sk-(proj|svcacct|admin)-[\w-]{20,}$/, { type: "api-key", provider: "openai" }],
  [/^sk-[A-Za-z0-9]{48,}$/, { type: "api-key", provider: "openai" }],
  [/^(sk|rk)_live_[A-Za-z0-9]{16,}$/, { type: "api-key", provider: "stripe", mode: "live" }],
  [/^(sk|rk)_test_[A-Za-z0-9]{16,}$/, { type: "api-key", provider: "stripe", mode: "test" }],
  [/^pk_live_[A-Za-z0-9]{16,}$/, { type: "config", provider: "stripe", mode: "live", secret: false }],
  [/^pk_test_[A-Za-z0-9]{16,}$/, { type: "config", provider: "stripe", mode: "test", secret: false }],
  [/^whsec_[A-Za-z0-9+/=]{16,}$/, { type: "webhook", provider: "stripe" }],
  [/^ghp_[A-Za-z0-9]{30,}$/, { type: "pat", provider: "github" }],
  [/^github_pat_[A-Za-z0-9_]{40,}$/, { type: "pat", provider: "github" }],
  [/^(gho|ghu|ghr)_[A-Za-z0-9]{30,}$/, { type: "oauth", provider: "github" }],
  [/^ghs_[A-Za-z0-9]{30,}$/, { type: "api-key", provider: "github" }],
  [/^glpat-[\w-]{20,}$/, { type: "pat", provider: "gitlab" }],
  [/^xox[pare]-[A-Za-z0-9-]{10,}$/, { type: "oauth", provider: "slack" }],
  [/^xoxb-[A-Za-z0-9-]{10,}$/, { type: "api-key", provider: "slack" }],
  [/^xapp-[A-Za-z0-9-]{10,}$/, { type: "api-key", provider: "slack" }],
  [/^(AKIA|ASIA)[A-Z0-9]{16}$/, { type: "cloud", provider: "aws" }],
  [/^AIza[\w-]{35}$/, { type: "api-key", provider: "google" }],
  [/^GOCSPX-[\w-]{20,}$/, { type: "oauth", provider: "google" }],
  [/^ya29\.[\w.-]{20,}$/, { type: "oauth", provider: "google" }],
  [/^1\/\/[\w-]{20,}$/, { type: "oauth", provider: "google" }],
  [/^SG\.[\w-]{16,}\.[\w-]{16,}$/, { type: "api-key", provider: "sendgrid" }],
  [/^re_[A-Za-z0-9_]{16,}$/, { type: "api-key", provider: "resend" }],
  [/^key-[0-9a-f]{32}$/, { type: "api-key", provider: "mailgun" }],
  [/^SK[0-9a-f]{32}$/, { type: "api-key", provider: "twilio" }],
  [/^AC[0-9a-f]{32}$/, { type: "config", provider: "twilio", secret: false }],
  [/^npm_[A-Za-z0-9]{36}$/, { type: "api-key", provider: "npm" }],
  [/^pypi-[\w-]{50,}$/, { type: "api-key", provider: "pypi" }],
  [/^hf_[A-Za-z0-9]{30,}$/, { type: "api-key", provider: "huggingface" }],
  [/^dop_v1_[a-f0-9]{64}$/, { type: "pat", provider: "digitalocean" }],
  [/^do[or]_v1_[a-f0-9]{64}$/, { type: "oauth", provider: "digitalocean" }],
  [/^pplx-[A-Za-z0-9]{40,}$/, { type: "api-key", provider: "perplexity" }],
  [/^shp(at|ca|pa)_[a-fA-F0-9]{32}$/, { type: "api-key", provider: "shopify" }],
  [/^shpss_[a-fA-F0-9]{32}$/, { type: "secret", provider: "shopify" }],
  [/^sq0atp-[\w-]{20,}$/, { type: "api-key", provider: "square" }],
  [/^sq0csp-[\w-]{20,}$/, { type: "oauth", provider: "square" }],
  [/^lin_api_[A-Za-z0-9]{32,}$/, { type: "api-key", provider: "linear" }],
  [/^lin_oauth_[A-Za-z0-9]{32,}$/, { type: "oauth", provider: "linear" }],
  [/^(ntn|secret)_[A-Za-z0-9]{40,}$/, { type: "api-key", provider: "notion" }],
  [/^pat[A-Za-z0-9]{14}\.[a-f0-9]{64}$/, { type: "pat", provider: "airtable" }],
  [/^pat-(na|eu)\d-[a-f0-9-]{36}$/, { type: "pat", provider: "hubspot" }],
  [/^sntry[su]_[A-Za-z0-9+/=_]{40,}$/, { type: "api-key", provider: "sentry" }],
  [/^pcsk_[A-Za-z0-9_]{20,}$/, { type: "api-key", provider: "pinecone" }],
  [/^jina_[A-Za-z0-9_]{20,}$/, { type: "api-key", provider: "jina" }],
  [/^apify_api_[A-Za-z0-9]{20,}$/, { type: "api-key", provider: "apify" }],
  [/^sb_secret_[\w-]{16,}$/, { type: "api-key", provider: "supabase" }],
  [/^sb_publishable_[\w-]{16,}$/, { type: "config", provider: "supabase", secret: false }],
  [/^\d{8,10}:[\w-]{35}$/, { type: "api-key", provider: "telegram" }],
  [/^[MNO][A-Za-z0-9_-]{23,27}\.[\w-]{6,7}\.[\w-]{27,}$/, { type: "api-key", provider: "discord" }],
];

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
