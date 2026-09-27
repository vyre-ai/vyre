// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./detect.js";

// Fake values are built at run time from a seeded generator, so no key-shaped literal sits in the
// source for a push-protection scanner to trip on, and none of them is a real credential.
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
let seed = 0x4e6f7274; // "Nort"
/** @param {number} n @param {string} [alphabet] */
function fake(n, alphabet = ALNUM) {
  let s = "";
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    s += alphabet[(seed >>> 8) % alphabet.length];
  }
  return s;
}
/** @param {object} o */
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** @param {object} claims */
const jwt = (claims) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u(claims)}.${fake(43)}`;

/**
 * @param {Array<[string, string, Record<string, unknown>]>} rows name, value, expected subset
 */
function table(rows) {
  for (const [name, value, want] of rows) {
    const got = classify(name, value);
    for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${name}: ${k}`);
  }
}

test("LLM providers", () => {
  table([
    ["ANTHROPIC_API_KEY", "sk-ant-api03-" + fake(90), { secret: true, type: "api-key", provider: "anthropic" }],
    ["OPENROUTER_API_KEY", "sk-or-v1-" + fake(64, HEX), { secret: true, type: "api-key", provider: "openrouter" }],
    ["OPENAI_API_KEY", "sk-proj-" + fake(120), { secret: true, type: "api-key", provider: "openai" }],
    ["LLM_KEY", "sk-" + fake(48), { secret: true, type: "api-key", provider: "openai" }],
    ["PPLX", "pplx-" + fake(48), { secret: true, provider: "perplexity" }],
    ["HF_TOKEN", "hf_" + fake(34), { secret: true, type: "api-key", provider: "huggingface" }],
    ["NORTHWIND_VECTOR", "pcsk_" + fake(40), { secret: true, provider: "pinecone" }],
    ["READER", "jina_" + fake(60), { secret: true, provider: "jina" }],
  ]);
});

test("Stripe keys, modes and webhooks", () => {
  table([
    ["STRIPE_SECRET_KEY", "sk_live_" + fake(24), { secret: true, type: "api-key", provider: "stripe", mode: "live" }],
    ["STRIPE_KEY", "sk_test_" + fake(24), { secret: true, mode: "test" }],
    ["STRIPE_RESTRICTED", "rk_live_" + fake(24), { secret: true, type: "api-key", mode: "live" }],
    ["STRIPE_PUBLISHABLE_KEY", "pk_test_" + fake(24), { secret: false, type: "config", provider: "stripe", mode: "test" }],
    ["STRIPE_PK", "pk_live_" + fake(24), { secret: false, type: "config", mode: "live" }],
    ["STRIPE_WEBHOOK_SECRET", "whsec_" + fake(32), { secret: true, type: "webhook", provider: "stripe" }],
  ]);
});

test("code hosts and package registries", () => {
  table([
    ["GITHUB_TOKEN", "ghp_" + fake(36), { secret: true, type: "pat", provider: "github" }],
    ["GH_TOKEN", "github_pat_" + fake(22) + "_" + fake(59), { secret: true, type: "pat", provider: "github" }],
    ["GH_OAUTH", "gho_" + fake(36), { secret: true, type: "oauth", provider: "github" }],
    ["GH_APP", "ghs_" + fake(36), { secret: true, type: "api-key", provider: "github" }],
    ["GITLAB_TOKEN", "glpat-" + fake(20), { secret: true, type: "pat", provider: "gitlab" }],
    ["NPM_TOKEN", "npm_" + fake(36), { secret: true, type: "api-key", provider: "npm" }],
    ["TWINE_PASSWORD_X", "pypi-" + fake(60), { secret: true, provider: "pypi" }],
  ]);
});

test("chat and messaging", () => {
  table([
    ["SLACK_BOT_TOKEN", "xoxb-" + fake(12, "0123456789") + "-" + fake(24), { secret: true, type: "api-key", provider: "slack" }],
    ["SLACK_USER", "xoxp-" + fake(12, "0123456789") + "-" + fake(24), { secret: true, type: "oauth", provider: "slack" }],
    ["SLACK_APP_TOKEN", "xapp-1-" + fake(30), { secret: true, provider: "slack" }],
    ["ALERTS", "https://hooks.slack.com/services/T" + fake(8, UPPER) + "/B" + fake(8, UPPER) + "/" + fake(24),
      { secret: true, type: "webhook", provider: "slack" }],
    ["HARLOW_HOOK", "https://discord.com/api/webhooks/" + fake(18, "0123456789") + "/" + fake(60),
      { secret: true, type: "webhook", provider: "discord" }],
    ["BOT", fake(10, "0123456789") + ":" + fake(35), { secret: true, type: "api-key", provider: "telegram" }],
    ["TWILIO_API_KEY", "SK" + fake(32, HEX), { secret: true, type: "api-key", provider: "twilio" }],
    ["TWILIO_ACCOUNT_SID", "AC" + fake(32, HEX), { secret: false, type: "config", provider: "twilio" }],
    ["TWILIO_AUTH_TOKEN", fake(32, HEX), { secret: true, type: "api-key", provider: "twilio" }],
  ]);
});

test("email providers", () => {
  table([
    ["SENDGRID_API_KEY", "SG." + fake(22) + "." + fake(43), { secret: true, type: "api-key", provider: "sendgrid" }],
    ["RESEND_API_KEY", "re_" + fake(32), { secret: true, type: "api-key", provider: "resend" }],
    ["MAILGUN_KEY", "key-" + fake(32, HEX), { secret: true, type: "api-key", provider: "mailgun" }],
  ]);
});

test("cloud credentials", () => {
  table([
    ["AWS_ACCESS_KEY_ID", "AKIA" + fake(16, UPPER), { secret: true, type: "cloud", provider: "aws" }],
    ["AWS_SESSION", "ASIA" + fake(16, UPPER), { secret: true, type: "cloud", provider: "aws" }],
    ["AWS_SECRET_ACCESS_KEY", fake(40, ALNUM + "/+"), { secret: true, type: "cloud", provider: "aws" }],
    ["GOOGLE_MAPS_KEY", "AIza" + fake(35), { secret: true, type: "api-key", provider: "google" }],
    ["GOOGLE_CLIENT_SECRET", "GOCSPX-" + fake(28), { secret: true, type: "oauth", provider: "google" }],
    ["GCP_SA", JSON.stringify({ type: "service_account", project_id: "northwind", private_key: "x" }),
      { secret: true, type: "cloud", provider: "gcp" }],
    ["AZURE_STORAGE", `DefaultEndpointsProtocol=https;AccountName=harlow;AccountKey=${fake(86)}==;EndpointSuffix=core.windows.net`,
      { secret: true, type: "cloud", provider: "azure" }],
    ["DO_TOKEN", "dop_v1_" + fake(64, HEX), { secret: true, type: "pat", provider: "digitalocean" }],
    ["RAILWAY_TOKEN", fake(8, HEX) + "-" + fake(4, HEX) + "-" + fake(4, HEX) + "-" + fake(4, HEX) + "-" + fake(12, HEX),
      { secret: true, type: "api-key", provider: "railway" }],
    ["CLOUDFLARE_API_TOKEN", fake(40), { secret: true, type: "api-key", provider: "cloudflare" }],
  ]);
});

test("SaaS tokens by shape", () => {
  table([
    ["LINEAR_API_KEY", "lin_api_" + fake(40), { secret: true, provider: "linear" }],
    ["NOTION_TOKEN", "ntn_" + fake(46), { secret: true, provider: "notion" }],
    ["AIRTABLE_PAT", "pat" + fake(14) + "." + fake(64, HEX), { secret: true, type: "pat", provider: "airtable" }],
    ["HUBSPOT", "pat-na1-" + fake(8, HEX) + "-" + fake(4, HEX) + "-" + fake(4, HEX) + "-" + fake(4, HEX) + "-" + fake(12, HEX),
      { secret: true, type: "pat", provider: "hubspot" }],
    ["SHOPIFY_ADMIN", "shpat_" + fake(32, HEX), { secret: true, type: "api-key", provider: "shopify" }],
    ["SQUARE", "sq0atp-" + fake(22), { secret: true, provider: "square" }],
    ["SCRAPER", "apify_api_" + fake(36), { secret: true, provider: "apify" }],
    ["SUPABASE_SECRET_KEY", "sb_secret_" + fake(32), { secret: true, provider: "supabase" }],
    ["SUPABASE_PUBLISHABLE_KEY", "sb_publishable_" + fake(32), { secret: false, type: "config", provider: "supabase" }],
  ]);
});

test("PEM blocks", () => {
  table([
    ["SIGNING", "-----BEGIN PRIVATE KEY-----\\n" + fake(64) + "\\n-----END PRIVATE KEY-----", { secret: true, type: "private-key" }],
    ["DEPLOY_KEY", "-----BEGIN OPENSSH PRIVATE KEY-----\n" + fake(70) + "\n-----END OPENSSH PRIVATE KEY-----", { secret: true, type: "private-key" }],
    ["GITHUB_APP_KEY", "-----BEGIN RSA PRIVATE KEY-----\n" + fake(64), { secret: true, type: "private-key", provider: "github" }],
    ["TLS_CERT", "-----BEGIN CERTIFICATE-----\n" + fake(64) + "\n-----END CERTIFICATE-----", { secret: false, type: "cert" }],
  ]);
});

test("database and broker URLs", () => {
  table([
    ["DATABASE_URL", "postgres://harlow:" + fake(20) + "@db.northwind.internal:5432/app", { secret: true, type: "db-url", provider: "postgres" }],
    ["PG", "postgresql://harlow:" + fake(20) + "@db.northwind.internal/app", { secret: true, type: "db-url", provider: "postgres" }],
    ["LOCAL_DB", "postgres://localhost:5432/northwind", { secret: false, type: "config", provider: "postgres" }],
    ["MYSQL_URL", "mysql://root:" + fake(12) + "@127.0.0.1/harlow", { secret: true, type: "db-url", provider: "mysql" }],
    ["MONGO_URI", "mongodb+srv://app:" + fake(16) + "@cluster0.northwind.example/test", { secret: true, type: "db-url", provider: "mongodb" }],
    ["REDIS_URL", "rediss://:" + fake(24) + "@cache.northwind.example:6380", { secret: true, type: "db-url", provider: "redis" }],
    ["CACHE", "redis://localhost:6379", { secret: false, type: "config", provider: "redis" }],
    ["BROKER", "amqps://harlow:" + fake(16) + "@mq.northwind.example/vhost", { secret: true, type: "db-url", provider: "amqp" }],
    ["DB_URL", "sqlserver://sa:" + fake(16) + "@db.harlow.example", { secret: true, type: "db-url" }],
    ["UPSTREAM", "https://user:" + fake(16) + "@proxy.northwind.example", { secret: true, type: "secret" }],
    ["SENTRY_DSN", "https://" + fake(32, HEX) + "@o12345.ingest.sentry.io/678", { secret: false, type: "config", provider: "sentry" }],
    ["ZAPIER_WEBHOOK_URL", "https://hooks.zapier.com/hooks/catch/123456/" + fake(7), { secret: true, type: "webhook" }],
    ["FEED", "https://api.harlow.example/v1/feed?token=" + fake(32), { secret: true, type: "secret" }],
  ]);
});

test("JWTs, Supabase roles and expiry", () => {
  const exp = 1893456000;
  const anon = jwt({ iss: "supabase", ref: "northwind", role: "anon", iat: 1700000000, exp });
  const service = jwt({ iss: "supabase", ref: "northwind", role: "service_role", iat: 1700000000, exp });
  const plainJwt = jwt({ sub: "harlow", exp });
  assert.deepEqual(classify("SUPABASE_ANON_KEY", anon), { secret: false, type: "config", provider: "supabase", expires: exp * 1000 });
  assert.deepEqual(classify("SUPABASE_SERVICE_ROLE_KEY", service), { secret: true, type: "jwt", provider: "supabase", expires: exp * 1000 });
  assert.deepEqual(classify("SESSION", plainJwt), { secret: true, type: "jwt", expires: exp * 1000 });
  assert.deepEqual(classify("SESSION", jwt({ sub: "harlow" })), { secret: true, type: "jwt" });
  assert.deepEqual(classify("SESSION", jwt({ exp: "soon" })), { secret: true, type: "jwt" });
  // A payload that is not JSON is still a token-shaped secret.
  assert.deepEqual(classify("SESSION", "eyJhbGciOiJIUzI1NiJ9." + fake(40) + "." + fake(40)), { secret: true, type: "jwt" });
});

test("public-by-design names", () => {
  table([
    ["NEXT_PUBLIC_SUPABASE_URL", "https://northwind.supabase.co", { secret: false, type: "config", provider: "supabase", public: undefined }],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", jwt({ iss: "supabase", role: "anon" }), { secret: false, type: "config", public: undefined }],
    ["VITE_API_BASE", "/api", { secret: false, type: "config" }],
    ["EXPO_PUBLIC_ANALYTICS_ID", fake(32), { secret: false, type: "config" }],
    ["PUBLIC_STRIPE_KEY", "pk_live_" + fake(24), { secret: false, public: undefined }],
  ]);
  // A secret shape under a public name ships to every browser: vault it and flag the leak.
  table([
    ["NEXT_PUBLIC_STRIPE_KEY", "sk_live_" + fake(24), { secret: true, type: "api-key", provider: "stripe", public: true }],
    ["VITE_CLAUDE", "sk-ant-api03-" + fake(90), { secret: true, provider: "anthropic", public: true }],
    ["REACT_APP_PUBLIC_KEY", "-----BEGIN PRIVATE KEY-----\n" + fake(40), { secret: true, type: "private-key", public: true }],
    ["NEXT_PUBLIC_SUPABASE_KEY", jwt({ iss: "supabase", role: "service_role" }), { secret: true, provider: "supabase", public: true }],
  ]);
});

test("name heuristics", () => {
  table([
    ["DB_PASSWORD", "postgres", { secret: true, type: "password" }],
    ["PGPASSWORD", "hunter2", { secret: true, type: "password", provider: "postgres" }],
    ["SMTP_PASS", "Northwind-2026", { secret: true, type: "password" }],
    ["SESSION_SECRET", "changeme", { secret: true, type: "secret" }],
    ["JWT_SIGNING_KEY", fake(12), { secret: true, type: "secret" }],
    ["GITHUB_CLIENT_SECRET", fake(40, HEX), { secret: true, type: "oauth", provider: "github" }],
    ["HARLOW_WEBHOOK_SECRET", fake(24), { secret: true, type: "webhook" }],
    ["DEEPGRAM_API_KEY", fake(40, HEX), { secret: true, type: "api-key", provider: "deepgram" }],
    ["ELEVENLABS_API_KEY", "sk_" + fake(48, HEX), { secret: true, type: "api-key", provider: "elevenlabs" }],
    ["DATADOG_API_KEY", fake(32, HEX), { secret: true, type: "api-key", provider: "datadog" }],
    ["VERCEL_PERSONAL_ACCESS_TOKEN", fake(24), { secret: true, type: "pat", provider: "vercel" }],
    ["MLA_PAYPAL_TOKEN", "A21AA" + fake(40), { secret: true, provider: "paypal" }],
    ["TOKEN_TTL", "3600", { secret: false, type: "config" }],
    ["AUTH_PROVIDER", "github", { secret: false, type: "config" }],
    ["SECRET_ROTATION_ENABLED", "true", { secret: false, type: "config" }],
    ["NORTHWIND_SALT", "yes", { secret: false, type: "config" }],
  ]);
});

test("plain config stays in the file", () => {
  table([
    ["PORT", "3000", { secret: false, type: "config" }],
    ["NODE_ENV", "production", { secret: false, type: "config" }],
    ["LOG_LEVEL", "debug", { secret: false, type: "config" }],
    ["TZ", "Europe/London", { secret: false, type: "config" }],
    ["FEATURE_X_ENABLED", "on", { secret: false, type: "config" }],
    ["S3_BUCKET", "northwind-assets-prod-2026", { secret: false, type: "config" }],
    ["AWS_REGION", "us-east-1", { secret: false, type: "config", provider: "aws" }],
    ["GOOGLE_CLIENT_ID", fake(12, "0123456789") + "-" + fake(32, HEX) + ".apps.googleusercontent.com", { secret: false, type: "config" }],
    ["SUPPORT_ADDRESS", "help@harlow.example", { secret: false, type: "config" }],
    ["UPLOAD_ROOT", "/var/lib/northwind/uploads", { secret: false }],
    ["CACHE_HOST", "cache.northwind.internal:6379", { secret: false }],
    ["API_BASE", "https://api.harlow.example/v2", { secret: false, type: "config" }],
    ["GREETING", "Welcome to Northwind Harlow 2026 edition", { secret: false }],
    ["RETRIES", "5", { secret: false }],
    ["RATIO", "0.75", { secret: false }],
    ["EMPTY_KEY", "", { secret: false, type: "config" }],
    ["QUOTED", '"production"', { secret: false }],
  ]);
});

test("entropy fallback", () => {
  table([
    ["NORTHWIND_BLOB", fake(40), { secret: true, type: "secret" }],
    ["HARLOW_OPAQUE", "'" + fake(32) + "'", { secret: true, type: "secret" }],
    ["LONG_LOWER", "abcabcabcabcabcabcabcabc", { secret: false }],
    ["SHORT_MIX", "a1B2c3", { secret: false }],
  ]);
});

test("never throws, caps work, odd input", () => {
  for (const [n, v] of [[undefined, undefined], [null, null], [42, 42], [{}, []], ["X", "\u0000￿"], ["X", "eyJ.eyJ."], ["X", "postgres://%zz"]]) {
    const r = classify(n, v);
    assert.equal(typeof r.secret, "boolean");
    assert.equal(typeof r.type, "string");
  }
  const huge = "a".repeat(5_000_000) + "!";
  const t0 = Date.now();
  classify("BIG", huge);
  classify("BIG", "sk-" + "a".repeat(5_000_000));
  classify("BIG", "https://x.example/?" + "a=b&".repeat(500_000));
  assert.ok(Date.now() - t0 < 1000, "long values are capped");
});

test("result never echoes the value", () => {
  const VOCAB = new Set(["api-key", "pat", "oauth", "cloud", "db-url", "private-key", "cert", "jwt", "webhook",
    "password", "secret", "config", "live", "test"]);
  const exp = 1893456000;
  const corpus = [
    ["ANTHROPIC_API_KEY", "sk-ant-api03-" + fake(90)], ["STRIPE_KEY", "sk_live_" + fake(24)],
    ["GITHUB_TOKEN", "ghp_" + fake(36)], ["AWS_SECRET_ACCESS_KEY", fake(40)], ["X", "AKIA" + fake(16, UPPER)],
    ["DATABASE_URL", "postgres://harlow:" + fake(20) + "@db.northwind.internal/app"],
    ["S", jwt({ iss: "supabase", role: "service_role", exp })], ["K", "-----BEGIN PRIVATE KEY-----\n" + fake(64)],
    ["DB_PASSWORD", "Northwind-Harlow-99"], ["BLOB", fake(64)], ["NEXT_PUBLIC_X", "sk_live_" + fake(24)],
    ["SLACK", "https://hooks.slack.com/services/T0/B0/" + fake(24)], ["PORT", "8080"],
  ];
  for (const [name, value] of corpus) {
    const r = classify(name, value);
    for (const [k, v] of Object.entries(r)) {
      if (k === "expires") assert.equal(v, exp * 1000);
      else if (k === "provider") assert.match(String(v), /^[a-z-]+$/);
      else if (typeof v === "string") assert.ok(VOCAB.has(v), `${name}: ${k}`);
      else assert.equal(typeof v, "boolean");
    }
    // Provider slugs are fixed words that may coincide with a URL scheme; everything else must not overlap.
    const json = JSON.stringify({ ...r, provider: undefined });
    for (let i = 0; i + 6 <= value.length; i++) {
      assert.ok(!json.includes(value.slice(i, i + 6)), `${name} leaked a slice`);
    }
  }
});
