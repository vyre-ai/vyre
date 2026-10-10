import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkAppModule, parseAppModule, cardOf, PINNED_RE } from "./manifest.js";
import { loadCatalog } from "./index.js";

const documents = () => JSON.parse(fs.readFileSync(new URL("./catalog/documents.json", import.meta.url), "utf8"));
const bad = (m, path) => checkAppModule(m).some(p => p.path === path);

test("the DocuSeal manifest in the catalog passes, and the catalog loads it", () => {
  assert.deepEqual(checkAppModule(documents()), []);
  assert.deepEqual([...loadCatalog().keys()], ["documents"]);
});

test("an image must be pinned by digest: a bare tag, a latest tag and a short digest are refused", () => {
  for (const image of ["docuseal/docuseal:3.3.1", "docuseal/docuseal:latest", "docuseal/docuseal@sha256:abc", "docuseal/docuseal"]) {
    const m = documents(); m.app.image = image;
    assert.ok(bad(m, "app.image"), image);
  }
  assert.ok(PINNED_RE.test("docuseal/docuseal:3.3.1@sha256:" + "a".repeat(64)));
});

test("limits are required and bounded; egress may name only vyred; volumes cannot be a system folder", () => {
  let m = documents(); delete m.app.limits; assert.ok(bad(m, "app.limits"));
  m = documents(); m.app.limits.memoryMb = 99999; assert.ok(bad(m, "app.limits.memoryMb"));
  m = documents(); m.app.egress = ["github.com"]; assert.ok(bad(m, "app.egress"));
  m = documents(); m.app.volumes = [{ name: "x", path: "/etc" }]; assert.ok(bad(m, "app.volumes[0].path"));
  m = documents(); m.app.volumes = [{ name: "x", path: "/data/../etc" }]; assert.ok(bad(m, "app.volumes[0].path"));
});

test("a placeholder this build does not know, a secret that is also plain env, and an env name in lowercase are refused", () => {
  let m = documents(); m.app.env.APP_URL = "{somewhere}"; assert.ok(bad(m, "app.env.APP_URL"));
  m = documents(); m.app.env.SECRET_KEY_BASE = "x"; assert.ok(bad(m, "app.secrets[0].env"));
  m = documents(); m.app.env.lower = "x"; assert.ok(bad(m, "app.env.lower"));
});

test("events belong to the module and name a Flow path the Flows engine accepts; the connection credential must be something the bootstrap prints", () => {
  let m = documents(); m.events[0].event = "other.signed"; assert.ok(bad(m, "events[0].event"));
  m = documents(); m.events[0].flow = "Bad Path"; assert.ok(bad(m, "events[0].flow"));
  m = documents(); m.connection.credential = "nothing"; assert.ok(bad(m, "connection.credential"));
  m = documents(); m.connection.operations[0].kind = "yolo"; assert.ok(bad(m, "connection.operations[0].kind"));
});

test("screens are [{id,label,path,icon?}] with a path inside the module; extra keys anywhere are named", () => {
  let m = documents(); m.screens = [{ id: "a", label: "A", path: "/../x" }]; assert.ok(bad(m, "screens[0].path"));
  m = documents(); m.screens = [{ id: "a", label: "A", path: "/" }, { id: "a", label: "B", path: "/b" }]; assert.ok(bad(m, "screens[1].id"));
  m = documents(); m.extra = 1; assert.ok(bad(m, "extra"));
  m = documents(); m["x-note"] = 1; assert.deepEqual(checkAppModule(m), []);
  assert.throws(() => parseAppModule({ name: "no" }), e => e.code === "bad_manifest" && e.problems.length >= 3);
});

test("files an app makes go only into a Drive folder the manifest lists, with a name that cannot climb", () => {
  let m = documents(); m.events[0].files.saveTo = "Elsewhere/{submission}-{name}.pdf"; assert.ok(bad(m, "events[0].files.saveTo"));
  m = documents(); m.events[0].files.saveTo = "Signed/../x-{name}"; assert.ok(bad(m, "events[0].files.saveTo"));
  m = documents(); m.events[0].files.saveTo = "/Signed/{name}"; assert.ok(bad(m, "events[0].files.saveTo"));
  m = documents(); m.events[0].files.saveTo = "Signed/{who}-{name}"; assert.ok(bad(m, "events[0].files.saveTo"));
  m = documents(); delete m.drive; assert.ok(bad(m, "events[0].files.saveTo"));
  m = documents(); m.drive = ["lower"]; assert.ok(bad(m, "drive"));
});

test("public paths are static files served without a session: a path, no dot segments", () => {
  let m = documents(); m.app.public = ["/manifest.json", "/favicon.svg"]; assert.deepEqual(checkAppModule(m), []);
  m = documents(); m.app.public = ["/a/../b"]; assert.ok(bad(m, "app.public"));
  m = documents(); m.app.public = ["manifest.json"]; assert.ok(bad(m, "app.public"));
  m = documents(); m.app.public = "all"; assert.ok(bad(m, "app.public"));
});

test("the card is built from the manifest only and says what the app may reach", () => {
  const c = cardOf(documents());
  assert.match(c.runs, /docuseal\/docuseal:3\.3\.1/);
  assert.match(c.pinned, /^sha256:e171808c/);
  assert.deepEqual(c.reaches, ["your Vyre, to tell it a document was signed"]);
  assert.deepEqual(c.shows, ["Signatures"]);
  assert.equal(c.opensFor, "the owner and the admins of this Space");
  assert.equal(c.notes.length, 3);
  assert.match(c.screensNeed, /need a server with a public address/);
  assert.match(c.screensNeed, /still runs the app for your Flows and its webhooks/);
  const bare = documents(); bare.screens = []; assert.equal(cardOf(bare).screensNeed, null, "no screens, nothing to say");
  assert.equal(c.saves, "the files it gets back, in Signed/ in your Drive");
  const m = documents(); m.app.egress = []; assert.deepEqual(cardOf(m).reaches, ["nothing outside this server"]);
});

test("every event a catalog app maps is one the appmods module declares it may emit", () => {
  const emits = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).watches.emits;
  for (const m of loadCatalog().values()) for (const e of m.events || []) assert.ok(emits.includes(e.event), `${m.name}: ${e.event} is not in appmods watches.emits`);
});

test("the hook port a server with a host helper gives the app is a whole number from 43000 to 43999, or absent", () => {
  assert.deepEqual(checkAppModule({ ...documents(), app: { ...documents().app, hookPort: 43500 } }), []);
  const { hookPort, ...rest } = documents().app;
  assert.deepEqual(checkAppModule({ ...documents(), app: rest }), [], "an app can have none (it then runs only where vyred reaches Docker itself)");
  for (const v of [42999, 44000, "43001", 43001.5, 0, -1, null]) assert.ok(bad({ ...documents(), app: { ...documents().app, hookPort: v } }, "app.hookPort"), String(v));
});

test("the user-facing name is Documents, never the engine's: the card, the events, the views and the Connection say Documents; the engine is credited where the law wants it", async () => {
  const m = documents();
  assert.equal(m.name, "documents");
  assert.equal(m.title, "Documents");
  const c = cardOf(m);
  assert.equal(c.title, "Documents");
  assert.match(c.adds, /Document record/);
  const shown = JSON.stringify([c.title, c.description, c.notes, c.shows, c.tells, c.connection, m.connection.label, m.events.map(e => e.event), m.screens]);
  assert.ok(!/docuseal/i.test(shown), `nothing a person reads says DocuSeal: ${shown.slice(0, 200)}`);
  // the engine's source is where the card's `source` points, and its licence is stated (AGPL-3.0)
  assert.equal(m.source, "https://github.com/docusealco/docuseal");
  assert.equal(m.license, "AGPL-3.0");
});

test("the Kit the app ships is the compiled form of its source, defines a Document record linked to a Contact and a Project, and a Flow that files a signed one", async () => {
  const { compile } = await import("../../records/language/compile.js");
  const here = new URL("./catalog/", import.meta.url);
  const stored = JSON.parse(fs.readFileSync(new URL("documents.kit.json", here), "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(compile(fs.readFileSync(new URL("documents.kit.ts", here), "utf8")))), stored, "the .json is what the .ts compiles to: recompile after editing the source");
  assert.equal(stored.id, "documents");
  const doc = stored.types.find(t => t.name === "document");
  assert.deepEqual(["name", "status", "template", "signer_email", "signed_at", "file", "submission", "contact", "project"].filter(n => !doc.fields.some(f => f.name === n)), []);
  assert.equal(doc.fields.find(f => f.name === "contact").to, "contact");
  assert.equal(doc.fields.find(f => f.name === "project").to, "project");
  const flow = stored.flows.find(f => f.name === "document_signed");
  assert.deepEqual(flow.trigger, { on: "event", event: "documents.signed" });
  assert.equal(documents().kit, "documents.kit.json");
  assert.ok(documents().events.some(e => e.event === "documents.signed"), "the event the Flow waits for is one the app emits");
  assert.ok(documents().events.find(e => e.event === "documents.signed").data.at, "and it carries when it was signed");
});

test("a signer who declines is an event the app emits and a Flow the Kit ships: the Document is filed as Declined on the signer's Contact, and never as Signed", async () => {
  const stored = JSON.parse(fs.readFileSync(new URL("./catalog/documents.kit.json", import.meta.url), "utf8"));
  const flow = stored.flows.find((/** @type {any} */ f) => f.name === "document_declined");
  assert.deepEqual(flow.trigger, { on: "event", event: "documents.declined" });
  const sets = JSON.stringify(flow.steps).match(/"status":"[A-Za-z]+"/g) || [];
  assert.deepEqual([...new Set(sets)], ['"status":"Declined"']);
  const ev = documents().events.find((/** @type {any} */ e) => e.webhook === "form.declined");
  assert.equal(ev.event, "documents.declined");
  assert.deepEqual(Object.keys(ev.data).sort(), ["at", "email", "reason", "submission", "template"]);
  assert.ok(stored.version >= 2, "an installed Kit of the first version is upgraded to get the new Flow");
});
