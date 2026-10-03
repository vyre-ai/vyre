// @ts-check
// UI lab scenarios for the field renderers and generated views (see lab.js). Open as lab/index.html#/<name>?theme=paper. Sample rows live in ui/sample-rows.js
// (the made-up world); the scenarios draw them through the same views.js the Deck screens use, so a screenshot here is the screen.
//   fields    every kind, display and edit, with a sealed field for a person and for an assistant
//   list      Contacts as a list              board    Contacts as a board          matters   Matters as a list
//   calendar  Matters by closing date         dashboard  Matters dashboard          record    the Doe estate plan record page
//   contact   Jane Doe's record page, with sealed fields    assistant   the same page as an assistant sees it
import { h } from "../../js/dom.js";
import { types, typeById } from "../types.js";
import { rows, actors, linkIndex, events, SPACES } from "../sample-rows.js";
import { KINDS, display, edit } from "../fields.js";
import { listView, boardView, calendarView, dashboardView, recordPage, val, titleOf } from "../views.js";
import { pageHeader } from "../../js/page-header.js";
import { segmented, tabs, chip } from "../components/index.js";

const NOW = Date.UTC(2026, 9, 3, 12, 0);
const links = linkIndex(types);
const base = () => ({ actors, links, now: NOW, open: () => {}, rows });
const rowsOf = (/** @type {string} */ id) => rows.filter(r => r.type === id);
const spaceChip = (/** @type {any} */ r) => { const s = SPACES.find(x => x.id === r.space); return s ? chip(s.name, { tone: "plain" }) : null; };

/** @param {string} title @param {string} meta @param {...any} body */
const page = (title, meta, ...body) => h("div", { class: "ui-lab-page uv-page" }, pageHeader({ title, meta }), ...body);

const SAMPLE = /** @type {Record<string, any>} */ ({ text: "Doe estate plan", number: 42, money: 4800, date: "2026-10-28", choice: "Client", stage: "Drafting", actor: "chris", link: "jane", file: "Intake questionnaire.pdf",
  address: "18 Larkin St, San Francisco, CA 94109", phone: "+1 415 555 0142", email: "jane.doe@example.com", richText: "Widowed, two adult children. Wants the **trust funded** before the sale.", rating: 4, sealed: "412-55-6789" });

function fieldsScenario() {
  const def = (/** @type {string} */ kind, /** @type {string} */ label) => ({ key: kind, label: kind === "sealed" ? "SSN" : label, kind: /** @type {any} */ (kind), options: ["Client", "Vendor", "Referrer"], stages: ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"], link: "contact", currency: "USD" });
  const cells = KINDS.map(([kind, label]) => {
    const d = def(kind, label), c = { ...base(), def: d, who: /** @type {"person"} */ ("person"), reveal: async () => SAMPLE.sealed };
    return h("div", { class: "uv-gal-c" }, h("div", { class: "uv-box-l" }, label),
      h("div", { class: "uv-gal-r" }, h("span", { class: "uv-box-l" }, "Shows"), display(kind, SAMPLE[kind], c)),
      h("div", { class: "uv-gal-r" }, h("span", { class: "uv-box-l" }, "Edits"), edit(kind, SAMPLE[kind], c).el),
      kind === "sealed" ? h("div", { class: "uv-gal-r" }, h("span", { class: "uv-box-l" }, "Assistant"), display(kind, SAMPLE[kind], { ...c, who: "assistant" })) : null);
  });
  return page("Field kinds", "One display and one edit renderer for each. Nothing else draws a field.", h("div", { class: "uv-gal" }, cells));
}

function listFor(/** @type {string} */ typeId, /** @type {string} */ view) {
  const def = /** @type {any} */ (typeById(typeId)), rs = rowsOf(typeId);
  const o = { ...base(), rowExtra: typeId === "contact" ? spaceChip : null };
  const body = view === "board" ? boardView(def, rs, o) : view === "calendar" ? calendarView(def, rs, o) : view === "dashboard" ? dashboardView(def, rs, o) : listView(def, rs, o);
  const kinds = [["list", "List"], ["board", "Board"], ...(def.views.calendar ? [["calendar", "Calendar"]] : []), ...(def.views.dashboard ? [["dashboard", "Dashboard"]] : [])];
  return page(def.plural, `In every space`, h("div", { class: "uv-bar" }, segmented({ options: /** @type {any} */ (kinds), value: view, label: "View" })), body);
}

function recordFor(/** @type {string} */ id, who = "person") {
  const r = /** @type {any} */ (rows.find(x => x.id === id)), def = /** @type {any} */ (typeById(r.type));
  const sealedRaw = new Map(rows.map(x => [x.id, x.values]));
  const team = r.type === "matter" ? ["alex", "research", "kit", "drafting"].map(i => ({ id: i, doing: actors.find(a => a.id === i)?.doing, role: actors.find(a => a.id === i)?.role })) : [];
  team[0] && (team[0].doing = "Owner");
  const page_ = recordPage(def, r, { ...base(), who, rows: rowsOf(r.type), events: events[id] || [], team,
    related: r.type === "contact" ? rows.filter(x => x.type === "matter" && x.values.client === id).map(x => ({ id: x.id, title: titleOf(def, x) && String(x.values.title), type: "matter" })) : [],
    chats: id === "m1" || id === "jane" ? [{ id: "c1", title: "Funding checklist", members: ["juno", "kit"], when: "Today" }, { id: "c2", title: "Intake follow-up", members: ["chris", "kit"], when: "Mon" }] : [],
    files: id === "jane" ? ["Engagement letter (signed).docx", "ID check.pdf"] : [],
    doing: r.type === "matter" ? "Drafting is drafting the engagement letter" : null,
    reveal: async (/** @type {string} */ rid, /** @type {string} */ key) => String(sealedRaw.get(rid)?.[key] ?? ""),
    faceId: async () => ({ method: "face_id" }),
    seesAs: async (/** @type {string} */ rid) => { const v = { ...sealedRaw.get(rid) }; for (const f of def.fields) if (f.kind === "sealed" || f.sealed) if (v[f.key] !== undefined) v[f.key] = { sealed: true }; return v; },
    onupdate: async () => {} });
  return page(String(r.values[def.titleKey]), `${def.name} in ${SPACES.find(s => s.id === r.space)?.name}`, page_);
}

/** The real screens, on the store the Deck uses (ui/store.js), so the lab shows what /u/records and /u/record draw. @param {string} mod @param {string} a */
async function realScreen(mod, a) {
  const root = h("div", { class: "ui-lab-page" });
  const m = await import(mod);
  await m.default({ root, params: { screen: "x", a }, query: new URLSearchParams(), cleanup: () => {} });
  return root;
}

export const scenarios = {
  "screen-contacts": () => realScreen("../../views/ui-records.js", "contact"),
  "screen-matters": () => realScreen("../../views/ui-records.js", "matter"),
  "screen-matter": async () => { const { getStore } = await import("../store.js"); const m = (await getStore().list("matter")).find(r => r.values.title === "Doe estate plan"); return realScreen("../../views/ui-record.js", m ? m.id : "m1"); },
  "screen-contact": async () => { const { getStore } = await import("../store.js"); const m = (await getStore().list("contact")).find(r => r.values.name === "Jane Doe"); return realScreen("../../views/ui-record.js", m ? m.id : "c1"); },
  fields: fieldsScenario,
  list: () => listFor("contact", "list"),
  board: () => listFor("contact", "board"),
  matters: () => listFor("matter", "list"),
  calendar: () => listFor("matter", "calendar"),
  dashboard: () => listFor("matter", "dashboard"),
  record: () => recordFor("m1"),
  contact: () => recordFor("jane"),
  assistant: () => recordFor("jane", "assistant"),
};
void tabs; void val;
