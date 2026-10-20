// @ts-check
// The one naming of a model call's failure: each provider's documented error bodies and its CLI's printed failures, read into the six classes a caller (a Flow's fallback account) decides on.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_ERROR_CLASSES, classifyAiError, aiError, aiErrorClass } from "./ai-errors.js";

/** [what, status, text, class]: the providers' own words (HTTP bodies) and their CLIs' printed failures. */
const TABLE = [
  // Anthropic API, and Claude Code's -p JSON result
  ["anthropic bad key", 401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "auth"],
  ["claude code expired token", null, "Failed to authenticate. API Error: 401 OAuth token has expired. Please obtain a new token or run /login.", "auth"],
  ["claude code not logged in", null, "Invalid API key · Please run /login", "auth"],
  ["anthropic no credit", 400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}', "credits"],
  ["anthropic rate limit", 429, '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', "rate_limit"],
  ["claude subscription limit", null, "Claude AI usage limit reached|1760961600", "rate_limit"],
  ["claude 5-hour limit", null, "5-hour limit reached ∙ resets 3pm", "rate_limit"],
  ["anthropic overloaded", 529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "unavailable"],
  ["anthropic api error", 500, '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}', "unavailable"],
  ["anthropic too long", 400, '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 220000 tokens > 200000 maximum"}}', "bad_request"],
  ["anthropic permission", 403, '{"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}', "auth"],
  ["anthropic refusal", 200, '{"stop_reason":"refusal"}', "refused"],
  // OpenAI API, and codex exec's JSON events
  ["openai bad key", 401, '{"error":{"message":"Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}', "auth"],
  ["openai quota", 429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}', "credits"],
  ["openai rate", 429, '{"error":{"message":"Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 30000, Used 30000","type":"tokens","code":"rate_limit_exceeded"}}', "rate_limit"],
  ["openai context", 400, '{"error":{"message":"This model\'s maximum context length is 128000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}', "bad_request"],
  ["openai content", 400, '{"error":{"message":"Your request was rejected as a result of our safety system.","type":"invalid_request_error","code":"content_policy_violation"}}', "refused"],
  ["openai server", 503, '{"error":{"message":"The server is overloaded or not ready yet.","type":"server_error"}}', "unavailable"],
  ["codex expired login", null, "unexpected status 401 Unauthorized: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.", "auth"],
  ["codex chatgpt limit", null, "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 days 3 hours.", "rate_limit"],
  ["codex stream", null, "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)", "unavailable"],
  ["codex model", null, "unexpected status 400 Bad Request: The requested model 'gpt-9' does not exist.", "bad_request"],
  // OpenRouter
  ["openrouter no key", 401, '{"error":{"message":"No auth credentials found","code":401}}', "auth"],
  ["openrouter user", 401, '{"error":{"message":"User not found.","code":401}}', "auth"],
  ["openrouter credits", 402, '{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 1000.","code":402}}', "credits"],
  ["openrouter moderation", 403, '{"error":{"message":"anthropic/claude requires moderation on OpenRouter. Your input was flagged for \\"violence\\".","code":403}}', "refused"],
  ["openrouter rate", 429, '{"error":{"message":"Rate limit exceeded: free-models-per-day.","code":429}}', "rate_limit"],
  ["openrouter provider down", 502, '{"error":{"message":"Provider returned error","code":502}}', "unavailable"],
  ["openrouter no endpoints", 404, '{"error":{"message":"No endpoints found matching your data policy (Paid model training). Configure: https://openrouter.ai/settings/privacy","code":404}}', "unavailable"],
  ["openrouter timeout", 408, '{"error":{"message":"Request timed out","code":408}}', "unavailable"],
  // xAI API, and Grok Build over ACP
  ["xai bad key", 400, '{"code":"Client specified an invalid argument","error":"Incorrect API key provided: xa***. You can obtain an API key from https://console.x.ai."}', "auth"],
  ["xai no credits", 403, '{"code":"The caller does not have permission to execute the specified operation","error":"Your newly created team doesn\'t have any credits yet. You can purchase credits on https://console.x.ai."}', "credits"],
  ["xai spending", 403, '{"error":"Your team has either used all available credits or reached its monthly spending limit."}', "credits"],
  ["xai rate", 429, '{"error":"Too many requests"}', "rate_limit"],
  ["grok login gone", null, "Authentication required", "auth"],
  ["grok expired", null, "Authentication failed: your session has expired", "auth"],
  // the network, and the CLI not there
  ["refused connection", null, "connect ECONNREFUSED 127.0.0.1:443", "unavailable"],
  ["dns", null, "getaddrinfo ENOTFOUND api.x.ai", "unavailable"],
  ["nobody named it", null, "something odd happened", "unavailable"],
];

test("each provider's own failure reads as one of six classes", () => {
  const wrong = TABLE.filter(([, status, text, cls]) => classifyAiError({ status: /** @type {any} */ (status), text }) !== cls).map(([what, status, text, cls]) => `${what}: got ${classifyAiError({ status: /** @type {any} */ (status), text })}, want ${cls}`);
  assert.deepEqual(wrong, []);
  for (const c of AI_ERROR_CLASSES) assert.ok(TABLE.some(r => r[3] === c), `the table has a ${c}`);
});

test("a timeout or a missing CLI is unavailable; a driver's own class stands; the door's own refusal has none", () => {
  assert.equal(classifyAiError({ timedOut: true }), "unavailable");
  assert.equal(classifyAiError({ notFound: true }), "unavailable");
  const e = aiError("credits", "Your Claude plan is out of credits.", { code: "credits", provider: "claude" });
  assert.deepEqual([e.aiClass, e.code, e.message], ["credits", "credits", "Your Claude plan is out of credits."]);
  assert.equal(aiErrorClass(e), "credits");
  assert.equal(aiErrorClass(Object.assign(new Error("ledger_hit"), { code: "ledger_hit", refusal: { code: "ledger_hit" } })), null);
  assert.equal(aiErrorClass(new Error("OpenRouter answered 402: insufficient credits")), "credits");
  assert.equal(aiErrorClass(Object.assign(new Error("aborted"), { name: "TimeoutError" })), "unavailable");
  assert.equal(aiErrorClass(null), null);
  assert.equal(/** @type {any} */ (aiError(/** @type {any} */ ("nonsense"), "x")).aiClass, "unavailable", "an unknown class is never passed on");
});
