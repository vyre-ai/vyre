// @ts-check
// Fixtures for the gallery and the picture tests: every block's sample as a one-block screen, plus a few whole screens that stand for what people build. Resolved screens (content, no tools), so a
// picture of one needs no box. scripts/gen-gallery writes them, with each surface's form, to apps/app/ui/blocks/fixtures.generated.json.
import { BLOCKS, reduceScreen } from "./blocks.js";


/** @type {Record<string, any>} */
const COMPOSITES = {
  desk: {
    v: 2, id: "desk", title: "Intake desk",
    layout: { col: [{ block: "kpis" }, { split: [{ block: "queue" }, { col: [{ block: "who" }, { block: "recent" }], gap: "s3" }] }] },
    blocks: {
      kpis: { type: "stats", content: BLOCKS.stats.sample },
      queue: { type: "list", props: { title: "Waiting on you" }, content: { rows: [
        { id: "1", title: "Smith intake", subtitle: "Dana, today", accessory: "new" }, { id: "2", title: "Lee engagement letter", subtitle: "Waiting for signature", accessory: "sent" },
        { id: "3", title: "Okafor retainer", subtitle: "Payment pending", accessory: "due" }, { id: "4", title: "Brightwell consult", subtitle: "Tomorrow, 10:00" }] } },
      who: { type: "keyvalue", props: { title: "Smith intake" }, content: { pairs: [{ label: "Client", value: "Dana Smith" }, { label: "Stage", value: "Intake" }, { label: "Owner", value: "Lee Park" }] } },
      recent: { type: "timeline", content: BLOCKS.timeline.sample },
    },
  },
  record: {
    v: 2, id: "record", title: "Smith intake",
    layout: { col: [{ block: "facts" }, { tabs: [{ block: "history", label: "Activity" }, { block: "letter", label: "Letter" }] }, { block: "go" }] },
    blocks: {
      facts: { type: "keyvalue", content: { pairs: [{ label: "Client", value: "Dana Smith" }, { label: "Opened", value: "3 Oct" }, { label: "Fee", value: "$2,000" }] } },
      history: { type: "timeline", content: BLOCKS.timeline.sample },
      letter: { type: "document", content: BLOCKS.document.sample },
      go: { type: "actions", props: { primary: "send" }, actions: [{ id: "send", title: "Send letter", outward: true }, { id: "note", title: "Add a note" }], content: {} },
    },
  },
  matter: {
    v: 2, id: "matter", title: "Smith matter",
    layout: { col: [{ block: "ask" }, { block: "stage" }, { split: [{ block: "cal" }, { block: "team" }] }, { block: "files" }] },
    blocks: {
      ask: { type: "approval", content: BLOCKS.approval.sample, actions: [{ id: "send", title: "Send it", outward: true }, { id: "hold", title: "Not now" }] },
      stage: { type: "stages", props: { title: "Where it is" }, content: BLOCKS.stages.sample },
      cal: { type: "calendar", props: { title: "Coming up" }, content: BLOCKS.calendar.sample },
      team: { type: "people", props: { title: "Who is on it" }, content: BLOCKS.people.sample },
      files: { type: "gallery", props: { title: "Files" }, content: BLOCKS.gallery.sample },
    },
  },
  grouped: {
    v: 2, id: "grouped", title: "Settings",
    layout: { block: "s" },
    blocks: { s: { type: "list", props: { density: "tight" }, content: { rows: [
      { id: "account", title: "Account and recovery", subtitle: "Sign-in, recovery code", icon: "person.crop.circle", group: "You" },
      { id: "notifications", title: "Notifications", subtitle: "What can reach you, and when", icon: "bell", group: "You" },
      { id: "ai", title: "AI accounts", subtitle: "Claude, OpenAI and others, with budgets", icon: "sparkles", group: "You" },
      { id: "devices", title: "Devices", subtitle: "Your phone and computers", icon: "phone", accessory: "2 devices", group: "Devices" },
      { id: "backups", title: "Backups", subtitle: "Which Spaces are backed up", icon: "tray", group: "Devices" },
    ] } } },
  },
  typed: {
    v: 2, id: "typed", title: "Matters",
    layout: { block: "t" },
    blocks: { t: { type: "table", props: { controls: true, sort: "_title" }, content: {
      total: 3,
      columns: [
        { id: "_title", title: "Matter", sortLabel: "Title", kind: "title", role: "title", sort: true },
        { id: "client", title: "Client", kind: "link", role: "line", sort: true, f: { name: "client", label: "Client", kind: "link", to: "contact" } },
        { id: "stage", title: "Stage", kind: "stage", role: "line", sort: true, filter: true, options: ["Intake", "Signing", "Closed"], f: { name: "stage", label: "Stage", kind: "stage", options: ["Intake", "Signing", "Closed"] } },
        { id: "fee", title: "Fee", kind: "money", role: "end", sort: true, f: { name: "fee", label: "Fee", kind: "money" } },
        { id: "owner", title: "Owner", kind: "actor", role: "col", sort: true, f: { name: "owner", label: "Owner", kind: "actor" } },
        { id: "ssn", title: "SSN", kind: "sealed", role: "col", sort: false, f: { name: "ssn", label: "SSN", kind: "sealed" } },
        { id: "due", title: "Closing", kind: "date", role: "endDate", f: { name: "due", label: "Closing", kind: "date" } },
      ],
      rows: [
        { id: "1", urn: "urn:m/1", cells: { _title: { k: "title", v: "Ortiz power of attorney", id: "1", s: "ortiz power of attorney" }, client: { k: "link", v: "urn:c/1", link: { title: "Lena Ortiz", type: "contact" }, s: "lena ortiz" }, stage: { k: "stage", v: "Signing", s: "Signing" }, fee: { k: "money", v: 800, s: 800 }, owner: { k: "actor", v: "a1", who: { id: "a1", name: "Alex Rivera", family: "person" }, s: "alex rivera" }, ssn: { k: "sealed", on: true }, due: { k: "date", v: "2026-10-05", s: 1791158400000 } } },
        { id: "2", urn: "urn:m/2", cells: { _title: { k: "title", v: "Doe trust", id: "2", s: "doe trust" }, client: { k: "link", v: "urn:c/2", link: { title: "Marcus Doe", type: "contact" }, s: "marcus doe" }, stage: { k: "stage", v: "Intake", s: "Intake" }, fee: { k: "money", v: 3900, s: 3900 }, owner: { k: "actor", v: "a2", who: { id: "a2", name: "Chris Park", family: "person" }, s: "chris park" }, ssn: { k: "sealed", on: false }, due: { k: "date", v: "2026-10-09", s: 1791504000000 } } },
        { id: "3", urn: "urn:m/3", cells: { _title: { k: "title", v: "Shah will update", id: "3", s: "shah will update" }, client: { k: "link", v: "urn:c/3", link: { title: "Priya Shah", type: "contact" }, s: "priya shah" }, stage: { k: "stage", v: "Closed", s: "Closed" }, fee: { k: "money", v: 1200, s: 1200 }, owner: { k: "actor", v: "a1", who: { id: "a1", name: "Alex Rivera", family: "person" }, s: "alex rivera" }, ssn: { k: "sealed", on: true }, due: { k: "date", v: "2026-10-20", s: 1792454400000 } } },
      ] } } },
  },
  numbers: {
    v: 2, id: "numbers", title: "This month",
    layout: { col: [{ block: "kpis" }, { row: [{ block: "trend" }, { block: "by" }] }, { block: "warn" }] },
    blocks: {
      kpis: { type: "stats", content: BLOCKS.stats.sample },
      trend: { type: "chart", props: { title: "Intakes per day" }, content: BLOCKS.chart.sample },
      by: { type: "table", props: { title: "By matter" }, content: BLOCKS.table.sample },
      warn: { type: "banner", props: { tone: "warn" }, content: { text: "Calendar is not connected, so hearings are missing." } },
    },
  },
};

/** The fixtures: id -> { title, screens: { full, compact, glance } }. */
export function fixtures() {
  /** @type {Record<string, { title: string, screens: Record<string, any> }>} */
  const out = {};
  const add = (/** @type {string} */ id, /** @type {string} */ title, /** @type {any} */ screen) => {
    out[id] = { title, screens: { full: reduceScreen(screen, "app"), compact: reduceScreen(screen, "phone"), glance: reduceScreen(screen, "chat") } };
  };
  for (const [type, spec] of Object.entries(BLOCKS)) add(`block-${type}`, type, { v: 2, id: type, layout: { block: "b" }, blocks: { b: { type, content: spec.sample, ...(type === "records" ? { data: { records: { type: "matter" } } } : {}), ...(type === "actions" || type === "approval" ? { actions: [{ id: "a", title: "Approve" }, { id: "b", title: "Not now" }] } : {}) } } });
  for (const [id, s] of Object.entries(COMPOSITES)) add(id, s.title, s);
  // A whole screen that is a component (the owner's Design changes page): the gallery draws it from sample data.
  out["vault-emergency"] = { title: "Vault: emergency access", screens: { full: { component: "vault-emergency" }, compact: { component: "vault-emergency" }, glance: { component: "vault-emergency" } } };
  out["runner-settings"] = { title: "Run on this computer", screens: { full: { component: "runner-settings" }, compact: { component: "runner-settings" }, glance: { component: "runner-settings" } } };
  out["runner-settings-off"] = { title: "Run on this computer, off", screens: { full: { component: "runner-settings-off" }, compact: { component: "runner-settings-off" }, glance: { component: "runner-settings-off" } } };
  out["sites-list"] = { title: "Sites", screens: { full: { component: "sites-list" }, compact: { component: "sites-list" }, glance: { component: "sites-list" } } };
  out["chats-list"] = { title: "Chats", screens: { full: { component: "chats-list" }, compact: { component: "chats-list" }, glance: { component: "chats-list" } } };
  out["preview-card"] = { title: "Preview card", screens: { full: { component: "preview-card" }, compact: { component: "preview-card" }, glance: { component: "preview-card" } } };
  out["assistants-list"] = { title: "Assistants", screens: { full: { component: "assistants-list" }, compact: { component: "assistants-list" }, glance: { component: "assistants-list" } } };
  out["members-list"] = { title: "Members", screens: { full: { component: "members-list" }, compact: { component: "members-list" }, glance: { component: "members-list" } } };
  out["kits-list"] = { title: "Kits", screens: { full: { component: "kits-list" }, compact: { component: "kits-list" }, glance: { component: "kits-list" } } };
  out["access-list"] = { title: "Access", screens: { full: { component: "access-list" }, compact: { component: "access-list" }, glance: { component: "access-list" } } };
  out["computers-lately"] = { title: "Your computers, lately", screens: { full: { component: "computers-lately" }, compact: { component: "computers-lately" }, glance: { component: "computers-lately" } } };
  out["publish-sheet"] = { title: "Publish from a card", screens: { full: { component: "publish-sheet" }, compact: { component: "publish-sheet" }, glance: { component: "publish-sheet" } } };
  out["runner-chip"] = { title: "Session placement", screens: { full: { component: "runner-chip" }, compact: { component: "runner-chip" }, glance: { component: "runner-chip" } } };
  out["vault-real"] = { title: "Vault (real box shapes)", screens: { full: { component: "vault-real" }, compact: { component: "vault-real" }, glance: { component: "vault-real" } } };
  out["flow-parallel"] = { title: "Flow with a parallel and its join", screens: { full: { component: "flow-parallel" }, compact: { component: "flow-parallel" }, glance: { component: "flow-parallel" } } };
  out["design-changes"] = { title: "Design changes", screens: { full: { component: "design-changes" }, compact: { component: "design-changes" }, glance: { component: "design-changes" } } };
  return out;
}
