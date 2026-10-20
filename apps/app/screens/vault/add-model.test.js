// The Vault's Add sheet (add-model.js): templates only from what Vyre declares (modules' needs, the provider catalog, this Space's kept templates), never an AI account or an app
// sign-in; a template's own fields; a need asked for at the top opens its template; a suggestion that has nothing falls back to a blank item; every save sends values exactly.
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../../../../core/vault/providers.js";
import { ADVANCED_KINDS, blankDraft, draftOf, kindCall, loginDraft, needPrompts, needTemplate, noteDraft, offered, saveCall, searchTemplates, suggestionDraft, suggestionNote, templates } from "./add-model.js";

const NEEDS = [
  { module: "comms", id: "twilio", provider: "twilio", purpose: "Send text messages through your Twilio account", state: "missing", item: "comms-twilio" },
  { module: "comms", id: "sending", provider: "sending-service", purpose: "Send your Flows' email", state: "ready", item: "comms-sending", test: { tool: "comms.service.test", asks: "email" } },
  { module: "voice", id: "openai", provider: "openai", purpose: "push-to-talk words", state: "missing", item: "voice-openai-key" },
  { module: "mail", id: "imap", provider: "imap-smtp", purpose: "Read and send mail", state: "missing", multiple: true },
];

test("the Add sheet has no AI account and no app sign-in: those live in Settings, AI accounts and in Connections", () => {
  const ids = templates({ needs: NEEDS }).map((t) => t.id);
  for (const name of ["anthropic", "claude-setup-token", "openai", "google-oauth", "github-oauth", "github"]) {
    assert.equal(offered(name), false, name);
    assert.ok(!ids.includes(`app:${name}`), `${name} is not a template`);
  }
  assert.ok(!ids.includes("need:voice:openai"), "a module's need for an AI key is asked for where AI accounts live, not here");
  for (const name of ADVANCED_KINDS) assert.equal(offered(name), false, `${name} is on Advanced`);
  for (const id of ids) assert.ok(!/anthropic|claude|openai|oauth/.test(id), id);
  assert.ok(Object.values(PROVIDERS).some((p) => offered(p.name)), "the catalog still offers its other apps");
});

test("templates come only from what Vyre declares: a module's need, the catalog, and this Space's own", () => {
  const list = templates({ needs: NEEDS, saved: [{ app: "GoHighLevel", fields: [{ name: "ghl api key", secret: true, help: "Settings, Private Integrations" }, { name: "GHL_LOCATION_ID", secret: false }] }] });
  const sources = new Set(list.map((t) => t.source));
  assert.deepEqual([...sources].sort(), ["app", "need", "space"]);
  const ghl = list.find((t) => t.id === "space:gohighlevel");
  assert.deepEqual(ghl?.fields.map((f) => [f.name, f.secret]), [["GHL_API_KEY", true], ["GHL_LOCATION_ID", false]], "a kept template's names in their one form");
  assert.equal(searchTemplates(list, "gohigh")[0].id, "space:gohighlevel");
  assert.equal(searchTemplates(list, "LOCATION_ID")[0].id, "space:gohighlevel", "a field's name finds its app");
});

test("a template's fields: the catalog's own names and labels, required first, and an app may take another field", () => {
  const tw = templates().find((t) => t.id === "app:twilio");
  assert.ok(tw);
  assert.deepEqual(tw.fields.map((f) => f.name), PROVIDERS.twilio.fields.map((f) => f.name), "the names the modules read");
  assert.equal(tw.fields[0].label, "Auth token");
  assert.equal(tw.extra, true);
  const d = draftOf(tw);
  assert.deepEqual(d.fields.map((f) => f.key), ["value", ...PROVIDERS.twilio.fields.filter((f) => f.optional).map((f) => f.name)], "required first, then the optional ones");
  const need = needTemplate(NEEDS[0]);
  assert.equal(need?.extra, false, "a module's need takes its own fields and nothing else");
});

test("a need that is not filled is asked for at the top, and the ask opens that app's template", () => {
  const asks = needPrompts(NEEDS);
  assert.deepEqual(asks.map((a) => a.template), ["need:comms:twilio", "need:mail:imap"], "missing, offered here; the AI key and the filled one are not asked");
  assert.equal(asks[0].text, "Comms needs Twilio: Auth token.");
  const t = templates({ needs: NEEDS }).find((x) => x.id === asks[0].template);
  assert.equal(t?.source, "need");
  assert.equal(t?.need?.module, "comms");
  assert.deepEqual(t?.fields.filter((f) => !f.optional).map((f) => f.label), ["Auth token"]);
  assert.deepEqual(templates({ needs: NEEDS }).find((x) => x.id === "need:comms:sending")?.test, { tool: "comms.service.test", asks: "email" }, "Test it comes from the module's own declared check");
});

test("a need is filled through vault.connect with its own field names, values exactly as typed", () => {
  const t = needTemplate(NEEDS[0]);
  const d = draftOf(/** @type {any} */ (t));
  d.fields[0].value = "f00d" + " ";
  const c = saveCall(t, d);
  assert.deepEqual(c, { tool: "vault.connect", input: { module: "comms", need: "twilio", fields: { value: "f00d " } } }, "the trailing space is the person's to remove; nothing trims it");
  assert.deepEqual(saveCall(t, d, { member: true }), { error: "A module's key is added by the Space's owner." });
  const many = /** @type {any} */ (needTemplate(NEEDS[3]));
  const md = draftOf(many);
  for (const f of md.fields) if (!f.optional) f.value = f.key.endsWith("port") ? "993" : f.key === "security" ? "tls" : "x";
  assert.deepEqual(saveCall(many, { ...md, name: "" }), { error: "Give this account a name, like work or sales." }, "a need with several accounts names each one");
  assert.equal(/** @type {any} */ (saveCall(many, { ...md, name: "Work Mail" })).input.label, "work-mail");
});

test("a catalog app saves as its kind with the provider noted; an added field is named in its one form; a wrong shape names the field, never the value", () => {
  const tw = /** @type {any} */ (templates().find((t) => t.id === "app:twilio"));
  const d = draftOf(tw);
  d.name = "Twilio main";
  d.fields[0].value = "a".repeat(32);
  d.fields.push({ id: "x", key: "twilio region", value: "us1", secret: false, on: true });
  const c = /** @type {any} */ (saveCall(tw, d));
  assert.equal(c.tool, "vault.put");
  assert.equal(c.input.name, "Twilio-main");
  assert.deepEqual(c.input.fields, { value: "a".repeat(32), TWILIO_REGION: "us1" });
  assert.deepEqual(c.input.details, { provider: "twilio" });
  assert.deepEqual(c.plain, ["TWILIO_REGION"], "plain fields are saved as the item's rule, not in its details");
  d.fields[0].value = "nope";
  const bad = /** @type {any} */ (saveCall(tw, d));
  assert.match(bad.error, /auth token does not look right for Twilio/);
  assert.ok(!bad.error.includes("nope"));
});

test("a suggestion fills the item's fields; with no account or no answer, a blank item and plain words", () => {
  const s = suggestionDraft({ app: "GoHighLevel", fields: [{ name: "ghl api-key", secret: true, help: "Settings, Private Integrations" }, { name: "GHL_LOCATION_ID", secret: false }] });
  assert.deepEqual(s.fields.map((f) => [f.key, f.secret, f.value]), [["GHL_API_KEY", true, ""], ["GHL_LOCATION_ID", false, ""]], "names only; the values are the person's to fill");
  const none = suggestionDraft({ app: "GoHighLevel", fields: [] });
  assert.equal(none.name, "GoHighLevel");
  assert.equal(none.fields.length, 1);
  assert.equal(none.fields[0].key, "", "one blank field to name");
  assert.match(suggestionNote("no_account"), /Connect your own AI account in Settings, AI accounts/);
  assert.match(suggestionNote("no_answer"), /Add its fields yourself/);
  assert.equal(blankDraft().fields.length, 1);
});

test("a login and a note: a login's address names its site; values are kept exactly", () => {
  const l = loginDraft();
  l.name = "Airline account";
  l.fields[0].value = "https://airline.example/login"; l.fields[1].value = "alex"; l.fields[2].value = " pass word ";
  assert.deepEqual(kindCall("login", l), { tool: "vault.put", input: { name: "Airline-account", kind: "login", fields: { username: "alex", password: " pass word " }, url: "https://airline.example/login", hosts: ["airline.example"] } });
  assert.deepEqual(kindCall("login", l, { member: true }).input.fields.url, "https://airline.example/login");
  const n = noteDraft(); n.name = "Office wifi"; n.fields[0].value = "line one\nline two\n";
  assert.deepEqual(kindCall("note", n), { tool: "vault.put", input: { name: "Office-wifi", kind: "note", fields: { text: "line one\nline two\n" } } });
});
