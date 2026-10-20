// @ts-check
// OpenCode Go and the OpenCode API, one key, against a fake fetch. Nothing here calls opencode.ai.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { opencodeCall, familyOf, modelsUrl, opencodeUserAgent, probeOpenCode } from "../../../lib/opencode.js";
import { openrouterDoorDriver } from "./openrouter.js";
import { modelListDrivers } from "../../daemon/model-lists.js";

const KEY = "oc-test-key-0123456789abcdef";
const GO = "https://opencode.ai/inference/go";
const API = "https://opencode.ai/inference";

/** @param {any} [body] @param {number} [status] */
function fake(body, status = 200) {
  /** @type {any[]} */ const seen = [];
  const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetch, seen };
}

test("each product calls only its own documented path, and the two qwen and minimax splits stay apart", async () => {
  const cases = [
    [true, "qwen3.8-max", `${GO}/anthropic/v1/messages`, "anthropic"],
    [false, "qwen3.8-max", `${API}/openai/v1/chat/completions`, "chat"],
    [true, "qwen3.8-flash", `${GO}/anthropic/v1/messages`, "anthropic"],
    [false, "qwen3.8-flash", `${API}/anthropic/v1/messages`, "anthropic"],
    [true, "minimax-m3", `${GO}/anthropic/v1/messages`, "anthropic"],
    [false, "minimax-m3", `${API}/openai/v1/chat/completions`, "chat"],
    [true, "minimax-m3.1-flash-free", `${GO}/openai/v1/chat/completions`, "chat"],
    [false, "gpt-5.5", `${API}/openai/v1/responses`, "responses"],
    [true, "gpt-6-luna", `${GO}/openai/v1/responses`, "responses"],
    [true, "gemini-4-argon-contributor", `${GO}/google/v1beta/models/gemini-4-argon-contributor:generateContent`, "google"],
    [false, "gemini-3.1-pro", `${API}/google/v1beta/models/gemini-3.1-pro:generateContent`, "google"],
    [true, "glm-5.1", `${GO}/openai/v1/chat/completions`, "chat"],
    [false, "claude-opus-5-5-backup", `${API}/anthropic/v1/messages`, "anthropic"],
  ];
  for (const [go, model, url, family] of cases) {
    const f = fake(family === "chat" ? { choices: [{ message: { content: "ok" } }] } : family === "anthropic" ? { content: [{ type: "text", text: "ok" }] } : family === "responses" ? { output_text: "ok" } : { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    const out = await opencodeCall({ go: go === true, key: KEY, model: String(model), session: "thread-1", messages: [{ role: "user", content: "hi" }], fetch: f.fetch });
    assert.equal(out.content, "ok", String(model));
    assert.equal(f.seen[0].url, url, `${go} ${model}`);
    assert.equal(f.seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(f.seen[0].headers["user-agent"], opencodeUserAgent());
    assert.equal(f.seen[0].headers["x-title"], undefined, "OpenRouter's title header is not sent");
    assert.equal(f.seen[0].body.stream, undefined);
    assert.equal(f.seen[0].body.provider, undefined);
  }
});

test("both products send a user agent; only Go sends a conversation id, and a Go call with no id is not sent", async () => {
  const go = fake({ choices: [{ message: { content: "ok" } }] });
  await opencodeCall({ go: true, key: KEY, model: "glm-5.3", session: "run_42", messages: [{ role: "user", content: "hi" }], fetch: go.fetch });
  assert.equal(go.seen[0].headers["user-agent"], opencodeUserAgent());
  assert.match(go.seen[0].headers["user-agent"], /^vyre\/[0-9]/);
  assert.equal(go.seen[0].headers["x-opencode-session"], "run_42");
  const api = fake({ choices: [{ message: { content: "ok" } }] });
  await opencodeCall({ go: false, key: KEY, model: "glm-5.3", session: "run_42", messages: [{ role: "user", content: "hi" }], fetch: api.fetch });
  assert.equal(api.seen[0].headers["user-agent"], opencodeUserAgent());
  assert.equal(api.seen[0].headers["x-opencode-session"], undefined);
  const none = fake({ choices: [{ message: { content: "ok" } }] });
  await assert.rejects(() => opencodeCall({ go: true, key: KEY, model: "glm-5.3", messages: [{ role: "user", content: "hi" }], fetch: none.fetch }), (e) => /** @type {any} */ (e).aiClass === "bad_request" && /conversation id/.test(/** @type {any} */ (e).message));
  assert.equal(none.seen.length, 0, "no request without the conversation id");
});

test("bodies follow the documented shape: responses is a string, anthropic lifts system, google uses the method suffix", async () => {
  const responses = fake({ output_text: "ok" });
  await opencodeCall({ go: false, key: KEY, model: "gpt-5.5", messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "hi" }], fetch: responses.fetch });
  assert.equal(typeof responses.seen[0].body.input, "string");
  assert.match(responses.seen[0].body.input, /user: hi/);
  assert.equal(responses.seen[0].body.messages, undefined);
  const anthropic = fake({ content: [{ type: "text", text: "ok" }] });
  await opencodeCall({ go: true, key: KEY, model: "claude-haiku-5-5", session: "t1", max: 200, messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "hi" }, { role: "assistant", content: "yes" }], fetch: anthropic.fetch });
  assert.equal(anthropic.seen[0].body.system, "Be brief");
  assert.equal(anthropic.seen[0].body.max_tokens, 200);
  assert.deepEqual(anthropic.seen[0].body.messages.map((/** @type {any} */ m) => m.role), ["user", "assistant"]);
  const google = fake({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  await opencodeCall({ go: false, key: KEY, model: "gemini-3.1-pro", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yes" }], fetch: google.fetch });
  assert.equal(google.seen[0].url.endsWith(":generateContent"), true);
  assert.deepEqual(google.seen[0].body.contents.map((/** @type {any} */ c) => c.role), ["user", "model"]);
});

test("a model with no documented path is not called, including systemone, and an unknown endpoint hides the row", async () => {
  for (const [go, model] of [[false, "jev-1.13"], [false, "jev-1.13-free"], [false, "test"], [true, "omen-alpha"], [true, "minimax-m2.5"], [true, "minimax-m2.7"]]) {
    assert.equal(familyOf(go === true, model), null, `${go} ${model}`);
    const f = fake({});
    await assert.rejects(() => opencodeCall({ go: go === true, key: KEY, model: String(model), session: "t", messages: [{ role: "user", content: "hi" }], fetch: f.fetch }), /no chat path/);
    assert.equal(f.seen.length, 0);
  }
  assert.equal(familyOf(false, "custom-1", "https://opencode.ai/inference/openai/v1/responses"), "responses");
  assert.equal(familyOf(false, "gpt-5.5", "https://opencode.ai/inference/systemone/v1/systemone"), null);
  assert.equal(familyOf(false, "gpt-5.5", "https://example.com/unknown"), null);
});

test("a poisoned address is ignored; a loopback test double replaces only the origin", async (t) => {
  const saved = { go: process.env.VYRE_OPENCODE_GO_URL, api: process.env.VYRE_OPENCODE_URL };
  t.after(() => { for (const [k, name] of [["go", "VYRE_OPENCODE_GO_URL"], ["api", "VYRE_OPENCODE_URL"]]) { const v = /** @type {any} */ (saved)[k]; if (v === undefined) delete process.env[name]; else process.env[name] = v; } });
  process.env.VYRE_OPENCODE_GO_URL = "https://evil.example/steal";
  process.env.VYRE_OPENCODE_URL = "http://evil.example/v1";
  assert.equal(modelsUrl(true), `${GO}/v1/models`);
  assert.equal(modelsUrl(false), `${API}/v1/models`);
  const f = fake({ choices: [{ message: { content: "ok" } }] });
  await opencodeCall({ go: true, key: KEY, model: "glm-5.3", session: "t", messages: [{ role: "user", content: "hi" }], fetch: f.fetch });
  assert.equal(f.seen[0].url, `${GO}/openai/v1/chat/completions`);
  process.env.VYRE_OPENCODE_GO_URL = "http://127.0.0.1:9/ignore-this-path";
  assert.equal(modelsUrl(true), "http://127.0.0.1:9/inference/go/v1/models");
});

test("a refusal uses plain words and never the body or the key", async () => {
  const secret = `plan exhausted ${KEY}`;
  const limited = fake({ error: { message: secret } }, 429);
  await assert.rejects(() => opencodeCall({ go: true, key: KEY, model: "glm-5.3", session: "t", messages: [{ role: "user", content: "hi" }], fetch: limited.fetch }), (e) => {
    const x = /** @type {any} */ (e);
    assert.equal(x.aiClass, "rate_limit");
    assert.match(x.message, /next few hours/);
    assert.equal(x.message.includes(KEY), false);
    assert.equal(x.message.includes("plan exhausted"), false);
    return true;
  });
  const denied = fake({ error: { message: KEY } }, 401);
  await assert.rejects(() => opencodeCall({ go: false, key: KEY, model: "glm-5.3", messages: [{ role: "user", content: "hi" }], fetch: denied.fetch }), (e) => /** @type {any} */ (e).aiClass === "auth" && !/** @type {any} */ (e).message.includes(KEY));
  const down = fake("nope", 503);
  await assert.rejects(() => opencodeCall({ go: false, key: KEY, model: "glm-5.3", messages: [{ role: "user", content: "hi" }], fetch: down.fetch }), (e) => /** @type {any} */ (e).aiClass === "unavailable");
});

test("one key is checked on the regular list; Go only records whether that key lists a Go model", async () => {
  /** @type {string[]} */ const asked = [];
  const both = async (/** @type {string} */ url) => {
    asked.push(url);
    const rows = url.includes("/inference/go/") ? { data: [{ id: "glm-5.3" }, { id: "jev-1.13" }] } : { data: [{ id: "glm-5.3" }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };
  const ok = await probeOpenCode(KEY, both);
  assert.equal(ok.go_ok, true);
  assert.equal(asked[0], `${API}/v1/models`);
  assert.equal(asked[1], `${GO}/v1/models`);
  /** @type {string[]} */ const denied = [];
  await assert.rejects(() => probeOpenCode(KEY, async (url) => { denied.push(url); return { ok: false, status: 401, text: async () => KEY }; }), (e) => /** @type {any} */ (e).code === "bad_input" && /refused that key/.test(/** @type {any} */ (e).message) && !/** @type {any} */ (e).message.includes(KEY));
  assert.equal(denied.length, 1, "a refused regular list does not ask Go");
  const noGo = await probeOpenCode(KEY, async (url) => String(url).includes("/inference/go/") ? { ok: false, status: 404, text: async () => "" } : { ok: true, status: 200, text: async () => "not-json" });
  assert.equal(noGo.go_ok, false, "a models-list miss is not a bad key");
});

test("the model list asks only that product's URL, drops what cannot be called, and OpenRouter does not gain OpenCode's headers", async () => {
  const rows = { data: [{ id: "glm-5.3" }, { id: "qwen3.8-max" }, { id: "jev-1.13" }, { id: "test" }, { id: "omen-alpha" }, { id: "minimax-m2.5" }, { id: "minimax-m2.7" }] };
  /** @type {any[]} */ const asked = [];
  const drivers = modelListDrivers({ keyOf: async () => KEY, fetch: async (url, init) => { asked.push({ url, headers: init.headers }); return { ok: true, status: 200, json: async () => rows }; } });
  const go = await drivers.opencode.models({ account: { id: "a", go_only: true } });
  const api = await drivers.opencode.models({ account: { id: "b", go_only: false } });
  assert.deepEqual(go.map((m) => m.id).sort(), ["glm-5.3", "qwen3.8-max"]);
  assert.deepEqual(api.map((m) => m.id).sort(), ["glm-5.3", "minimax-m2.5", "minimax-m2.7", "qwen3.8-max"]);
  assert.equal(asked[0].url, `${GO}/v1/models`);
  assert.equal(asked[0].headers["user-agent"], opencodeUserAgent());
  assert.equal(asked[0].headers["x-opencode-session"], undefined);
  assert.equal(asked[1].url, `${API}/v1/models`);
  assert.equal(asked[1].headers["user-agent"], opencodeUserAgent());
  assert.equal(asked[1].headers["x-opencode-session"], undefined);
  assert.ok(!JSON.stringify(go).includes(KEY));
  const or = [];
  await openrouterDoorDriver({ fetch: async (url, init) => { or.push(init.headers); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }; } }).call({ model: "acme/m", messages: [{ role: "user", content: "hi" }], credential: { key: KEY, base: "http://127.0.0.1:9/v1" } });
  assert.equal(or[0]["user-agent"], undefined);
  assert.equal(or[0]["x-opencode-session"], undefined);
  assert.equal(or[0]["x-title"], "Vyre");
});
