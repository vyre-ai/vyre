// @ts-check
// Project templates and "start a project" (R031-10, 11, 12, 13), the module side. A template is a record per version (`project-template`, records/core-types.js); lib/project-template.js says what one holds and
// compiles it; the Flows stage module (kernel/flows/stages.js) runs the stages a project is pinned to. This file keeps the versions, puts one live on its owner's yes, starts a project from a live version
// (the project, its teammates, its pinned stages, its first stage's tasks), tries a template with nothing done, saves one from a finished project, and ships the library of Kit templates.
//
//   work.template.define     a new draft version (a person, or an assistant for them): nothing runs until it is live
//   work.template.list/get   the templates, and one version with its body
//   work.template.golive     the template's owner or an admin puts a draft version live; the one that was live is retired. A proposal (flows.propose { what: "template" }) is the same act on one card
//   work.template.test       every stage, task, doer, brief and checklist of a version on a sample, with nothing created, sent or changed
//   work.template.from-project   a draft template made from a project that ran one
//   work.template.library / work.template.install   the templates Kits ship, and one of them as a draft in this Space
//   work.start-project       start a project from a live version; also a Flow step ("Start a project from a template")

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { problems, snapshotOf, compile, briefOf, PROJECT_FIELDS } from "../../lib/project-template.js";
import { change as changeTags, parse as parseTags } from "../../lib/tags.js";
import { renderBrief } from "../../kernel/flows/checklist.js";

const TYPE = "project-template";
const KITS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "records", "kits");
const fail = (/** @type {string} */ code, /** @type {string} */ message, /** @type {any} */ more = {}) => Object.assign(new Error(message), { code, ...more });
const slug = (/** @type {string} */ s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
const sha = (/** @type {string} */ s) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/**
 * @param {{ kernel: () => any, hub: () => any, flows: () => any, log?: (m: string) => void }} o
 */
export function createTemplates({ kernel, hub, flows, log = () => {} }) {
  const personOf = (/** @type {any} */ chain) => { const h = chain && chain.hops && chain.hops[0]; if (!h || h.actor.kind !== "person") throw fail("not_allowed", "this is done by a person, or by their assistant for them"); return h.actor; };
  const isAdmin = (/** @type {any} */ person) => { const r = kernel().members && kernel().members.roleOf ? kernel().members.roleOf({ kind: "person", id: person.id, space: kernel().space }) : null; return r === "owner" || r === "admin"; };
  const svc = () => kernel().serviceChain("work");
  const bodyOf = (/** @type {any} */ rec) => { try { return JSON.parse(String(rec.data.body)); } catch { throw fail("bad_state", `${rec.data.template} version ${rec.data.version} is not readable`); } };
  const env = () => ({ fields: [...PROJECT_FIELDS] });

  /** Every version of a template, newest first. @param {any} chain @param {string} template */
  async function versions(chain, template) {
    const rows = (await kernel().records.query(chain, TYPE, { filter: { field: "template", op: "eq", value: template }, page: { limit: 200 } })).rows;
    return rows.sort((/** @type {any} */ a, /** @type {any} */ b) => b.data.version - a.data.version);
  }
  /** One version: the one asked for, else the live one. @param {any} chain @param {string} template @param {number | undefined} version */
  async function pick(chain, template, version) {
    const all = await versions(chain, String(template || ""));
    const rec = version !== undefined ? all.find((/** @type {any} */ r) => r.data.version === Number(version)) : all.find((/** @type {any} */ r) => r.data.state === "live");
    if (!rec) throw fail("not_found", version !== undefined ? `no version ${version} of ${template}` : `${template} has no live version${all.length ? `: version ${all[0].data.version} is a ${all[0].data.state}; work.template.golive puts it live` : ""}`);
    return rec;
  }
  const shape = (/** @type {any} */ r, withBody = false) => ({ template: r.data.template, version: r.data.version, name: r.data.name, state: r.data.state, owner: r.data.owner && r.data.owner.actor ? r.data.owner.actor.id : null, ...(r.data.kit ? { kit: r.data.kit } : {}), ...(r.data.note ? { note: r.data.note } : {}), tags: parseTags(r.data.tags), urn: r.urn, ...(withBody ? { body: bodyOf(r) } : {}) });
  const asBody = (/** @type {any} */ b) => { if (typeof b === "string") { try { return JSON.parse(b); } catch { throw fail("bad_input", "the template is not valid JSON"); } } return b; };

  /** A new draft version. `template` names an existing template to add a version to; without it the name makes the id. */
  async function define(chain, { template, body, note, kit }) {
    const person = personOf(chain);
    const b = asBody(body);
    const errors = problems(b, env());
    if (errors.length) throw fail("bad_input", `that template is not valid: ${errors.slice(0, 5).map(e => `${e.path ? e.path + ": " : ""}${e.message}`).join("; ")}${errors.length > 5 ? ` (and ${errors.length - 5} more)` : ""}`, { errors });
    const id = template ? String(template) : `tpl_${slug(b.name)}`;
    if (!/^tpl_[a-z0-9-]{1,56}$/.test(id)) throw fail("bad_input", "a template id is tpl_ and a lower-case word");
    const have = await versions(chain, id);
    const owner = have[0] ? have[0].data.owner : { actor: { kind: "person", id: person.id, space: person.space } };
    if (have[0] && have[0].data.owner && have[0].data.owner.actor && have[0].data.owner.actor.id !== person.id && !isAdmin(person) && !chain.hops.some((/** @type {any} */ h) => h.actor.kind === "agent")) throw fail("not_allowed", `only ${id}'s owner or an admin adds a version to it; propose the change instead (flows.propose { what: "template" })`);
    const rec = await kernel().records.create(chain, TYPE, { name: b.name, template: id, version: (have[0] ? have[0].data.version : 0) + 1, state: "draft", body: JSON.stringify(b), owner, ...(kit ? { kit: String(kit) } : {}), ...(note ? { note: String(note).slice(0, 500) } : {}), tags: changeTags("", { add: b.tags || [] }) });
    return shape(rec);
  }

  /** @param {any} chain @param {{ template?: string }} [i] */
  async function list(chain, i = {}) {
    if (i.template) return { template: i.template, versions: (await versions(chain, i.template)).map((/** @type {any} */ r) => shape(r)) };
    const rows = (await kernel().records.query(chain, TYPE, { page: { limit: 500 } })).rows;
    const by = new Map();
    for (const r of rows.sort((/** @type {any} */ a, /** @type {any} */ b) => b.data.version - a.data.version)) {
      const t = by.get(r.data.template) || { template: r.data.template, name: r.data.name, live: null, latest: r.data.version, versions: 0, owner: r.data.owner && r.data.owner.actor ? r.data.owner.actor.id : null, tags: parseTags(r.data.tags) };
      t.versions++; if (r.data.state === "live" && t.live === null) t.live = r.data.version;
      by.set(r.data.template, t);
    }
    return { templates: [...by.values()].sort((a, b) => a.template < b.template ? -1 : 1) };
  }

  /** Put a version live: its owner, or an admin; the live one is retired. @param {any} chain @param {{ template: string, version: number }} i @param {{ as?: any }} [o] `as`: the person whose yes this is, for the proposal path (a module acts for them) */
  async function goLive(chain, i, o = {}) {
    const person = o.as || personOf(chain);
    const all = await versions(chain, String(i.template));
    const rec = all.find((/** @type {any} */ r) => r.data.version === Number(i.version));
    if (!rec) throw fail("not_found", `no version ${i.version} of ${i.template}`);
    const owner = rec.data.owner && rec.data.owner.actor ? rec.data.owner.actor.id : null;
    if (owner !== person.id && !isAdmin(person)) throw fail("not_allowed", `only ${i.template}'s owner or an admin puts a version live`);
    if (rec.data.state === "live") return shape(rec);
    if (rec.data.state === "retired") throw fail("bad_state", "that version was retired; make a new one with work.template.define");
    const errors = problems(bodyOf(rec), env());
    if (errors.length) throw fail("bad_input", `that version is not valid any more: ${errors[0].message}`);
    const by = o.as ? svc() : chain;
    for (const r of all.filter((/** @type {any} */ x) => x.data.state === "live")) await kernel().records.update(by, TYPE, r.id, { state: "retired" }, r.version);
    return shape(await kernel().records.update(by, TYPE, rec.id, { state: "live" }, rec.version));
  }

  /** Try a version with nothing created, sent or changed: each stage, each task with its doer, brief and checklist, what holds a stage, and who may move it early. */
  async function test(chain, i) {
    const rec = await pick(chain, i.template, i.version);
    const body = bodyOf(rec);
    const errors = problems(body, env());
    if (errors.length) return { ok: false, errors };
    const sample = { name: "Sample project", ...(i.sample && typeof i.sample === "object" ? i.sample : {}) };
    const stages = compile(body);
    const roles = new Map((body.roles || []).map((/** @type {any} */ r) => [r.role, r]));
    const doerWords = (/** @type {string} */ d) => { const m = /^role:(.+)$/.exec(d); const r = m ? roles.get(m[1]) : null; return r && r.agent ? `${d} (${r.agent}${r.lead ? ", the project lead" : ""})` : m ? `${d} (a person with that role)` : d; };
    const lines = [`Trying ${body.name} version ${rec.data.version} on "${sample.name}". Nothing is created, sent or changed.`];
    const counts = { stages: stages.length, tasks: 0, roles: roles.size, checks: 0 };
    stages.forEach((s, n) => {
      lines.push(`Stage ${n + 1}, ${s.name}${s.owner ? ` (${s.owner} may move it early, with a reason)` : ""}${s.enter_if ? `; entered only when ${s.enter_if}` : ""}:`);
      for (const t of s.tasks || []) {
        counts.tasks++;
        lines.push(`  task "${t.title}" for ${doerWords(t.doer)}${t.checker ? `, checked by ${t.checker}` : ""}${t.required === false ? " (optional)" : ""}${t.depends_on ? `, after ${t.depends_on.join(", ")}` : ""}`);
        for (const ln of String(renderBrief(t.brief, sample)).split("\n")) lines.push(`    ${ln}`);
        for (const c of t.checklist || []) { counts.checks++; lines.push(`    must hold: ${c.say} (${Object.keys(c.check)[0]})`); }
        if (t.credentials && t.credentials.length) lines.push(`    may use: ${t.credentials.join(", ")}`);
      }
      lines.push((s.tasks || []).length ? `  moves on when the ${(s.tasks || []).some((/** @type {any} */ t) => t.required !== false) ? "required " : ""}tasks are done${stages[n + 1] && stages[n + 1].enter_if ? ` and ${stages[n + 1].enter_if}` : ""}.` : n === stages.length - 1 ? "  the last stage: the project ends here." : "  no tasks: a person moves it on.");
    });
    const totals = `${counts.stages} stages, ${counts.tasks} tasks, ${counts.checks} checklist items, ${counts.roles} roles`;
    lines.push(totals);
    return { ok: true, template: rec.data.template, version: rec.data.version, lines, totals, counts };
  }

  /** Start a project from a live version (or the named one): the project, its teammates, its pinned stages and its first stage's tasks. The caller's own chain makes the project. */
  async function start(chain, i) {
    personOf(chain);
    const rec = await pick(chain, i.template, i.version);
    if (i.version === undefined && rec.data.state !== "live") throw fail("bad_state", "that version is not live");
    const body = bodyOf(rec);
    const errors = problems(body, env());
    if (errors.length) throw fail("bad_input", `that template is not valid: ${errors[0].message}`);
    const name = String(i.name || "").trim();
    if (!name) throw fail("bad_input", "name the project");
    const k = kernel(), h = hub();
    const made = await h.createProject(chain, { name, repo: i.repo, client: i.client, slug: i.slug });
    const first = body.stages[0].name;
    const lead = (body.roles || []).find((/** @type {any} */ r) => r.lead && r.agent);
    const proj = await k.records.update(chain, "project", made.id, {
      template: rec.data.template, template_version: String(rec.data.version), template_stage: first, template_snapshot: snapshotOf(body, { id: rec.data.template, version: rec.data.version }),
      ...(lead ? { lead: lead.agent } : {}), tags: changeTags(made.data.tags || "", { add: [...(body.tags || []), `from-${rec.data.template.replace(/^tpl_/, "")}`] }),
    }, made.version);
    const team = [];
    for (const r of body.roles || []) if (r.agent) { try { await h.teamMember({ action: "add", project: proj.data.slug, agent: r.agent, role: r.role }); team.push({ role: r.role, agent: r.agent, ...(r.lead ? { lead: true } : {}) }); } catch (e) { log(`templates: ${r.agent} could not join ${proj.data.slug}: ${/** @type {Error} */ (e).message}`); } }
    const f = flows();
    /** @type {{ made: number, skipped: { task: string, why: string }[] } | undefined} */ let entered;
    if (f && f.stages) entered = await f.stages.enter({ urn: proj.urn, type: "project", id: proj.id, stage: first, entry: `start:${proj.id}` });
    // `tasks_made` is how many of the first stage's tasks exist, and `tasks_skipped` says which could not be made and why (an assistant not in this space yet), so a person is never told their tasks are in Now when they are not
    return { project: proj.urn, slug: proj.data.slug, template: rec.data.template, version: rec.data.version, stage: first, teammates: team, ...(lead ? { lead: lead.agent } : {}), tasks_made: entered ? entered.made : 0,
      ...(entered && entered.skipped.length ? { tasks_skipped: entered.skipped } : {}) };
  }

  /** A draft template made from a project that ran one: the stages it was pinned to (their briefs kept as written) and the roles its team filled. */
  async function fromProject(chain, i) {
    const k = kernel();
    const projects = (await k.records.query(chain, "project", { filter: { field: "slug", op: "eq", value: String(i.project || "") }, page: { limit: 1 } })).rows;
    const proj = projects[0];
    if (!proj) throw fail("not_found", `no project ${i.project}`);
    if (!proj.data.template_snapshot) throw fail("bad_state", "that project did not start from a template, so there are no stages to copy; a free-flow project is chats and files");
    const snap = JSON.parse(String(proj.data.template_snapshot));
    const rows = (await k.records.query(chain, "team-member", { filter: { field: "project", op: "eq", value: { urn: proj.urn } }, page: { limit: 100 } })).rows;
    const roles = rows.filter((/** @type {any} */ r) => r.data.role && r.data.actor && r.data.actor.actor && r.data.actor.actor.kind === "agent").map((/** @type {any} */ r) => ({ role: String(r.data.role), agent: r.data.actor.actor.id, ...(proj.data.lead === r.data.actor.actor.id ? { lead: true } : {}) }));
    const body = { name: String(i.name || `${snap.name || proj.data.name} (copy)`), roles, tags: parseTags(proj.data.tags).filter((/** @type {string} */ t) => !t.startsWith("from-")), stages: snap.stages.map((/** @type {any} */ s, /** @type {number} */ n) => ({ name: s.name, ...(s.owner ? { owner: s.owner } : {}), ...(snap.stages[n + 1] && snap.stages[n + 1].enter_if ? { moves_on_when: snap.stages[n + 1].enter_if } : {}), ...(s.tasks ? { tasks: s.tasks } : {}) })) };
    return define(chain, { body, note: `saved from the project ${proj.data.slug}` });
  }

  /** The templates the Kits ship: records/kits/<kit>/project-templates/*.json. */
  function library() {
    const out = [];
    for (const kit of fs.existsSync(KITS_DIR) ? fs.readdirSync(KITS_DIR) : []) {
      const dir = path.join(KITS_DIR, kit, "project-templates");
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".json")).sort()) {
        try { const body = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); out.push({ id: `${kit}/${f.replace(/\.json$/, "")}`, kit, name: body.name, description: body.description || "", stages: (body.stages || []).length, tasks: (body.stages || []).reduce((/** @type {number} */ n, /** @type {any} */ s) => n + (s.tasks || []).length, 0), body }); } catch { /* an unreadable file is not a template */ }
      }
    }
    return out;
  }
  async function install(chain, i) {
    const t = library().find(x => x.id === i.id);
    if (!t) throw fail("not_found", `the library has no ${i.id}; work.template.library lists what ships`);
    return define(chain, { body: t.body, kit: t.kit, note: `from the ${t.kit} Kit` });
  }

  // ---- the proposal kind "template": the same card as an agent's change, for putting a version live
  /** @param {any} chain @param {{ template: string, version: number, proposer: string }} i */
  async function changeDraft(chain, i) {
    const rec = await pick(chain, i.template, i.version);
    if (rec.data.state !== "draft") throw fail("bad_state", `version ${i.version} is a ${rec.data.state}, not a draft`);
    const errors = problems(bodyOf(rec), env());
    if (errors.length) throw fail("bad_input", `that version is not valid: ${errors[0].message}`);
    const hash = sha(String(rec.data.body) + `|${rec.data.version}`);
    return { id: `${rec.data.template}@${rec.data.version}`, hash, template: rec.data.template, version: rec.data.version, owner: rec.data.owner && rec.data.owner.actor ? rec.data.owner.actor.id : null, title: `Put ${rec.data.name} version ${rec.data.version} live?` };
  }
  async function changeTitle(i) {
    const [template, version] = String(i.id).split("@");
    try { const rec = await pick(svc(), template, Number(version)); return rec.data.state === "draft" && sha(String(rec.data.body) + `|${rec.data.version}`) === i.hash ? `Put ${rec.data.name} version ${rec.data.version} live?` : null; } catch { return null; }
  }
  async function changeApply(i) {
    const [template, version] = String(i.id).split("@");
    if ((await changeTitle(i)) === null) throw fail("not_found", "that change is no longer waiting");
    return goLive(svc(), { template, version: Number(version) }, { as: { kind: "person", id: String(i.approver), space: kernel().space } });
  }

  return { define, list, get: async (/** @type {any} */ chain, /** @type {any} */ i) => shape(await pick(chain, i.template, i.version), true), goLive, test, start, fromProject, library, install, changeDraft, changeTitle, changeApply, briefOf };
}

const obj = (/** @type {any} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "space", "agent", "mcp", "harness"];

/**
 * The tools, over a Templates made by createTemplates. Every one runs under the caller's own kernel chain (`chainOf`), which decides what it reaches.
 * @param {{ ctx: any, templates: ReturnType<typeof createTemplates>, chainOf: (extra: any) => any }} o
 */
export function registerTemplateTools({ ctx, templates: t, chainOf }) {
  const run = (/** @type {(chain: any, i: any) => Promise<any>} */ f) => async (/** @type {any} */ i, /** @type {any} */ extra) => f(await chainOf(extra), i || {});
  const body = { type: ["object", "string"], description: "the template: { name, description?, tags?, roles?: [{ role, agent?, lead? }], stages: [{ name, owner?, moves_on_when?, tasks?: [{ title, doer, output: { kind }, checker?, brief?, checklist?, credentials?, context?, needs_yes?, ask?, depends_on?, due_offset_ms?, required? }] }] }" };
  ctx.tool("work.template.define", { description: "Write a project template as a new draft version: stages, tasks, doers, checklists, needed yeses and agent roles. Test it with work.template.test, then work.template.golive.", input: obj({ template: { type: "string", description: "template id; omit for a new template" }, body, note: { type: "string" } }, ["body"]), callers: CALLERS, run: run((c, i) => t.define(c, i)) });
  ctx.tool("work.template.list", { description: "The project templates of this Space (id, name, which version is live, owner), or the versions of one (template).", input: obj({ template: { type: "string" } }), callers: CALLERS, run: run((c, i) => t.list(c, i)) });
  ctx.tool("work.template.get", { description: "One version of a project template with its whole body (the live one by default).", input: obj({ template: { type: "string" }, version: { type: "integer" } }, ["template"]), callers: CALLERS, run: run((c, i) => t.get(c, i)) });
  ctx.tool("work.template.golive", { description: "Put a draft version of a template live: the template's owner or an admin, in their own name. The version that was live is retired; projects already running keep the version they started with.", input: obj({ template: { type: "string" }, version: { type: "integer" } }, ["template", "version"]), run: run((c, i) => t.goLive(c, i)) });
  ctx.tool("work.template.test", { description: "Dry-run a template version, changing nothing: shows each stage, task, doer, brief, checklist and who may move a stage early.", input: obj({ template: { type: "string" }, version: { type: "integer" }, sample: { type: "object", description: "sample project fields that fill the briefs, such as { name }" } }, ["template"]), callers: CALLERS, run: run((c, i) => t.test(c, i)) });
  ctx.tool("work.template.from-project", { description: "Make a draft template from a project that ran one, keeping its pinned stages, briefs and filled roles.", input: obj({ project: { type: "string", description: "the project's short name" }, name: { type: "string", description: "name for the new template" } }, ["project"]), callers: CALLERS, run: run((c, i) => t.fromProject(c, i)) });
  ctx.tool("work.template.library", { description: "The project templates the Kits ship (id, name, stages, tasks). work.template.install makes one a draft in this Space.", input: obj({}), callers: CALLERS, run: async (_i, extra) => { await chainOf(extra); return { templates: t.library().map(({ body: _b, ...rest }) => rest) }; } });
  ctx.tool("work.template.install", { description: "Add a library template (id from work.template.library) to this Space as a draft version.", input: obj({ id: { type: "string" } }, ["id"]), callers: CALLERS, run: run((c, i) => t.install(c, i)) });
  ctx.tool("work.start-project", { description: "Start a project from a live template: creates the project, its teammates from the roles, the pinned stages, and the first stage's tasks with briefs.", input: obj({ template: { type: "string" }, name: { type: "string", description: "the new project's name" }, client: { type: "string", description: "the client's record address" }, repo: { type: "string" }, slug: { type: "string" }, version: { type: "integer", description: "template version to pin; the live one by default" } }, ["template", "name"]), callers: [...CALLERS, "module"], run: run((c, i) => t.start(c, i)) });
  // the proposal kind "template" (flows-host.js)
  ctx.tool("work.template.change.draft", { description: "Check a draft version can be put live and say whose yes it needs. For the proposals path.", internal: true, callers: ["module"], input: obj({ template: { type: "string" }, version: { type: "integer" }, proposer: { type: "string" } }, ["template", "version", "proposer"]), run: async (/** @type {any} */ i) => { if (!ctx.kernel || typeof ctx.kernel.serviceChain !== "function") throw Object.assign(new Error("the kernel is not wired on this box yet; try again in a minute, or ask the owner or an admin"), { code: "unavailable" }); return t.changeDraft(ctx.kernel.serviceChain("work"), i); } });
  ctx.tool("work.template.change.title", { description: "The title a stored template change really has, or null. For the proposals path.", internal: true, callers: ["module"], input: obj({ id: { type: "string" }, hash: { type: "string" } }, ["id", "hash"]), run: async (/** @type {any} */ i) => { if (!ctx.kernel || typeof ctx.kernel.serviceChain !== "function") throw Object.assign(new Error("the kernel is not wired on this box yet; try again in a minute, or ask the owner or an admin"), { code: "unavailable" }); return t.changeTitle(i); } });
  ctx.tool("work.template.change.apply", { description: "Put the version live on its owner's yes. For the proposals path.", internal: true, callers: ["module"], input: obj({ id: { type: "string" }, hash: { type: "string" }, approver: { type: "string" } }, ["id", "hash", "approver"]), run: async (/** @type {any} */ i) => { if (!ctx.kernel || typeof ctx.kernel.serviceChain !== "function") throw Object.assign(new Error("the kernel is not wired on this box yet; try again in a minute, or ask the owner or an admin"), { code: "unavailable" }); return t.changeApply(i); } });
}
