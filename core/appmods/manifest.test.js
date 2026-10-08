import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkAppModule, parseAppModule, cardOf, PINNED_RE } from "./manifest.js";
import { loadCatalog } from "./index.js";

const docuseal = () => JSON.parse(fs.readFileSync(new URL("./catalog/docuseal.json", import.meta.url), "utf8"));
const bad = (m, path) => checkAppModule(m).some(p => p.path === path);

test("the DocuSeal manifest in the catalog passes, and the catalog loads it", () => {
  assert.deepEqual(checkAppModule(docuseal()), []);
  assert.deepEqual([...loadCatalog().keys()], ["docuseal"]);
});

test("an image must be pinned by digest: a bare tag, a latest tag and a short digest are refused", () => {
  for (const image of ["docuseal/docuseal:3.3.1", "docuseal/docuseal:latest", "docuseal/docuseal@sha256:abc", "docuseal/docuseal"]) {
    const m = docuseal(); m.app.image = image;
    assert.ok(bad(m, "app.image"), image);
  }
  assert.ok(PINNED_RE.test("docuseal/docuseal:3.3.1@sha256:" + "a".repeat(64)));
});

test("limits are required and bounded; egress may name only vyred; volumes cannot be a system folder", () => {
  let m = docuseal(); delete m.app.limits; assert.ok(bad(m, "app.limits"));
  m = docuseal(); m.app.limits.memoryMb = 99999; assert.ok(bad(m, "app.limits.memoryMb"));
  m = docuseal(); m.app.egress = ["github.com"]; assert.ok(bad(m, "app.egress"));
  m = docuseal(); m.app.volumes = [{ name: "x", path: "/etc" }]; assert.ok(bad(m, "app.volumes[0].path"));
  m = docuseal(); m.app.volumes = [{ name: "x", path: "/data/../etc" }]; assert.ok(bad(m, "app.volumes[0].path"));
});

test("a placeholder this build does not know, a secret that is also plain env, and an env name in lowercase are refused", () => {
  let m = docuseal(); m.app.env.APP_URL = "{somewhere}"; assert.ok(bad(m, "app.env.APP_URL"));
  m = docuseal(); m.app.env.SECRET_KEY_BASE = "x"; assert.ok(bad(m, "app.secrets[0].env"));
  m = docuseal(); m.app.env.lower = "x"; assert.ok(bad(m, "app.env.lower"));
});

test("events belong to the module and name a Flow path the Flows engine accepts; the connection credential must be something the bootstrap prints", () => {
  let m = docuseal(); m.events[0].event = "other.signed"; assert.ok(bad(m, "events[0].event"));
  m = docuseal(); m.events[0].flow = "Bad Path"; assert.ok(bad(m, "events[0].flow"));
  m = docuseal(); m.connection.credential = "nothing"; assert.ok(bad(m, "connection.credential"));
  m = docuseal(); m.connection.operations[0].kind = "yolo"; assert.ok(bad(m, "connection.operations[0].kind"));
});

test("screens are [{id,label,path,icon?}] with a path inside the module; extra keys anywhere are named", () => {
  let m = docuseal(); m.screens = [{ id: "a", label: "A", path: "/../x" }]; assert.ok(bad(m, "screens[0].path"));
  m = docuseal(); m.screens = [{ id: "a", label: "A", path: "/" }, { id: "a", label: "B", path: "/b" }]; assert.ok(bad(m, "screens[1].id"));
  m = docuseal(); m.extra = 1; assert.ok(bad(m, "extra"));
  m = docuseal(); m["x-note"] = 1; assert.deepEqual(checkAppModule(m), []);
  assert.throws(() => parseAppModule({ name: "no" }), e => e.code === "bad_manifest" && e.problems.length >= 3);
});

test("the card is built from the manifest only and says what the app may reach", () => {
  const c = cardOf(docuseal());
  assert.match(c.runs, /docuseal\/docuseal:3\.3\.1/);
  assert.match(c.pinned, /^sha256:e171808c/);
  assert.deepEqual(c.reaches, ["your Vyre, to tell it a document was signed"]);
  assert.deepEqual(c.shows, ["Signatures"]);
  const m = docuseal(); m.app.egress = []; assert.deepEqual(cardOf(m).reaches, ["nothing outside this server"]);
});

test("every event a catalog app maps is one the appmods module declares it may emit", () => {
  const emits = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).watches.emits;
  for (const m of loadCatalog().values()) for (const e of m.events || []) assert.ok(emits.includes(e.event), `${m.name}: ${e.event} is not in appmods watches.emits`);
});
