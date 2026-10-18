// @ts-check
// What a project's row in the list says (Projects, calm): what is next, who is on it, how far along, and when it last moved. Pure; the list draws it.
import { actorOf, needsReason } from "../../src/store-core/tasks.js";
import { aid } from "../../src/store-core/kernel-view.js";
import { teamOf } from "./model.js";

const DAY = 86_400_000;
const KIND_WORDS = /** @type {Record<string, string>} */ ({ stages: "Stages", client: "Client", ongoing: "Ongoing", simple: "Simple" });

/** The word for a project's kind on its row and page. A project with none is Simple; the Personal one says Private. @param {any} data a project's fields */
export const kindWord = (data) => (data && data.personal_of ? "Private" : KIND_WORDS[String(data && data.kind)] || "Simple");

const lc = (/** @type {string} */ s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const isDone = (/** @type {any} */ t) => t.state === "done" || t.state === "skipped";

/** "Moved today", "Moved 4 days ago": plain words for when something last changed. @param {number} at @param {number} now */
export function movedWords(at, now) {
  if (!at) return "";
  const days = Math.floor((now - at) / DAY), hours = (now - at) / 3_600_000;
  if (hours < 24) return "Moved today";
  if (days < 2) return "Moved yesterday";
  if (days < 7) return `Moved ${days} days ago`;
  if (days < 14) return "Moved last week";
  if (days < 30) return `Moved ${Math.floor(days / 7)} weeks ago`;
  return "Moved over a month ago";
}

/**
 * @param {import("./model.js").World} world @param {{ def: any, row: any }} item
 * @returns {{ next: string, needsYou: boolean, done: number, total: number, team: string[], moved: string }}
 */
export function rowFacts(world, item) {
  const { row, def } = item;
  if (row.data && row.data.personal_of) return { next: "Notes, drafts and chats that are just yours", needsYou: false, done: 0, total: 0, team: [], moved: "Pinned" };
  const tasks = world.tasks.filter((t) => t.record === row.urn);
  const name = (/** @type {string} */ id) => actorOf(id, world.actors)?.name || id;
  const mine = tasks.find((t) => needsReason(t, world.me, world.actors) !== null);
  const working = tasks.find((t) => t.state === "working");
  const open = tasks.find((t) => t.state === "ready" || t.state === "waiting" || t.state === "needs_check");
  let next = tasks.length ? "Nothing open" : "No to-dos yet", needsYou = false;
  if (mine) { next = `Waiting on you: ${lc(mine.title)}`; needsYou = true; }
  else if (working) next = `${name(aid(working.doer))} is working on ${lc(working.title)}`;
  else if (open) next = `Next: ${lc(open.title)}`;
  const ownerField = (def.fields || []).find((/** @type {any} */ f) => f.kind === "actor");
  const owner = ownerField ? aid(row.data?.[ownerField.name]?.actor) : "";
  const team = teamOf({ tasks, actors: world.actors, owner }).map((m) => m.id).slice(0, 4);
  const at = Math.max(Number(row.updated_at) || 0, ...tasks.map((t) => Number(t.updated_at) || 0));
  return { next, needsYou, done: tasks.filter(isDone).length, total: tasks.length, team, moved: movedWords(at, world.now) };
}

/**
 * The order of the Projects list: the Personal project first (it is pinned), then the rest by the newest change to the project or its to-dos, a tie by name. The list given is not changed.
 * @template {{ def: any, row: any }} T @param {import("./model.js").World} world @param {T[]} items @returns {T[]}
 */
export function orderProjects(world, items) {
  const at = (/** @type {T} */ i) => Math.max(Number(i.row.updated_at) || 0, ...world.tasks.filter((t) => t.record === i.row.urn).map((t) => Number(t.updated_at) || 0));
  const name = (/** @type {T} */ i) => String(i.row.data?.name ?? i.row.id).toLowerCase();
  const key = items.map((i) => ({ i, p: i.row.data?.personal_of ? 1 : 0, at: at(i), n: name(i) }));
  return key.sort((a, b) => b.p - a.p || b.at - a.at || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)).map((k) => k.i);
}
