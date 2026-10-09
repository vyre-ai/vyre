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
  for (const [type, spec] of Object.entries(BLOCKS)) add(`block-${type}`, type, { v: 2, id: type, layout: { block: "b" }, blocks: { b: { type, content: spec.sample, ...(type === "actions" || type === "approval" ? { actions: [{ id: "a", title: "Approve" }, { id: "b", title: "Not now" }] } : {}) } } });
  for (const [id, s] of Object.entries(COMPOSITES)) add(id, s.title, s);
  // A whole screen that is a component (the owner's Design changes page): the gallery draws it from sample data.
  out["design-changes"] = { title: "Design changes", screens: { full: { component: "design-changes" }, compact: { component: "design-changes" }, glance: { component: "design-changes" } } };
  return out;
}
