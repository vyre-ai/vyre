// @ts-check
// Moving a Project to another Space (team/0.3/DESIGN-project-move.md). The target Space gets a NEW project with its own new id and Drive folder; the records linked to the old one and its files are
// copied across, as the mover, through each Space's own gateway (so each side checks its own roles and Drive grants, file by file); the copy is verified; and only then does the old Space keep
// nothing but a "moved to" marker. Every step is idempotent and the id map is kept, so a crash resumes.
//
//   const plan = await planMove({ from, to, project, client });         read only: counts, a hash of them (what the person approves), blockers
//   const done = await runMove({ from, to, plan, ports });              creates, copies, verifies, then marks the source and removes what moved
//
// A side is { space, records, drive?, chain }: a gateway's records and drive with the mover's chain in THAT Space. Sealed fields cannot be copied by this code (it never sees a value): they move only
// through `ports.reseal`, the sealing process's own transfer between the two Spaces; with sealed fields in the plan and no such port, the plan has a blocker and nothing runs.
import crypto from "node:crypto";
import { isSealedValue } from "../../lib/sealed.js";

const PROJECT = "project";
const MAX_RECORDS = 2000;
const canonical = (/** @type {any} */ v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const sha = (/** @type {any} */ v) => crypto.createHash("sha256").update(typeof v === "string" || v instanceof Uint8Array ? v : canonical(v)).digest("hex");
const urnParts = (/** @type {string} */ u) => { const [, , space, type, id] = String(u).split("/"); return { space, type, id }; };
const bytesOf = (/** @type {any} */ r) => (r instanceof Uint8Array ? r : r && (r.bytes || r.data) instanceof Uint8Array ? (r.bytes || r.data) : Buffer.from(r && (r.bytes || r.data) || ""));

/** The records linked to a project, breadth first under the caller's chain (the set a move carries). @param {any} side @param {string} project @returns {Promise<string[]>} */
export async function linkedClosure(side, project) {
  /** @type {Set<string>} */ const seen = new Set([project]);
  /** @type {string[]} */ const queue = [project];
  while (queue.length && seen.size < MAX_RECORDS) {
    const u = /** @type {string} */ (queue.shift());
    const r = await side.records.linked(side.chain, u, { limit: 200 });
    for (const row of r.rows) { const rec = row.record; if (rec && !seen.has(rec.urn)) { seen.add(rec.urn); queue.push(rec.urn); } }
  }
  return [...seen];
}

/**
 * Everything that would move, read only. The hash covers both Spaces, the project, the client choice, the counts and the sorted ids, so what the person approves is exactly this.
 * @param {{ from: any, to: any, project: string, client?: "move" | "leave" }} o
 */
export async function planMove({ from, to, project, client = "leave" }) {
  const { type, id } = urnParts(project);
  const root = await from.records.get(from.chain, type, id);
  if (!root || type !== PROJECT) throw Object.assign(new Error("no such project in this Space"), { code: "not_found" });
  /** @type {Map<string, any>} */ const found = new Map();
  /** @type {string[]} */ const queue = [root.urn];
  let truncated = false;
  while (queue.length && found.size < MAX_RECORDS) {
    const u = /** @type {string} */ (queue.shift());
    const r = await from.records.linked(from.chain, u, { limit: 200 });
    if (r.truncated) truncated = true;
    for (const row of r.rows) { const rec = row.record; if (rec && !found.has(rec.urn) && rec.urn !== root.urn) { found.set(rec.urn, rec); queue.push(rec.urn); } }
  }
  let clientRec = null;
  if (client === "move" && root.data.client && root.data.client.urn) { const p = urnParts(root.data.client.urn); clientRec = await from.records.get(from.chain, p.type, p.id); if (clientRec) found.set(clientRec.urn, clientRec); }
  /** @type {Record<string, number>} */ const byType = {};
  let sealed = 0;
  for (const r of found.values()) { byType[r.type] = (byType[r.type] || 0) + 1; for (const v of Object.values(r.data || {})) if (isSealedValue(v)) sealed++; }
  for (const v of Object.values(root.data || {})) if (isSealedValue(v)) sealed++;
  /** @type {{ path: string, size: number }[]} */ let files = [];
  const folder = root.data.drive_path;
  if (folder && from.drive) files = (await from.drive.list(from.chain, folder)).map((/** @type {any} */ e) => ({ path: String(e.path ?? e.name ?? e), size: Number(e.size) || 0 }));
  // chat folders go by the sealed carry below, never by the mover's own reads
  if (from.drive && typeof from.drive.survey === "function") files = files.filter(f => !/^Projects\/[^/]+\/(chat|made)\/[^/]+\//.test(f.path));
  // the content hash of every file the mover reads, from the Drive's own record (no byte is read to plan): what the person approves covers the contents, not just the names and counts
  /** @type {Record<string, string | null>} */ const hashes = {};
  if (from.drive && typeof from.drive.stat === "function") for (const f of files) { try { const st = await from.drive.stat(from.chain, f.path); hashes[f.path] = st && st.sha256 ? String(st.sha256) : null; } catch { hashes[f.path] = null; } }
  // a project's chat folders are its participants' only, so the mover's listing above never shows them; the move carries them sealed, and the plan counts them without reading
  let chatFiles = 0, chatBytes = 0; /** @type {string[]} */ let chatHashes = [];
  if (folder && from.drive && typeof from.drive.survey === "function") { try { const sv = await from.drive.survey(from.chain, folder); chatFiles = sv.files; chatBytes = sv.bytes; chatHashes = sv.hashes || []; } catch { /* not an owner or admin here: the plan shows only what the mover reads */ } }
  /** @type {string[]} */ const blockers = [];
  if (chatFiles && to.remote === true) blockers.push("a project's chat folders cannot be carried to a Space on another server yet");
  if (chatFiles && to.remote !== true && !(typeof from.carry === "function" && to.drive)) blockers.push("this kernel cannot carry a chat's sealed files between Spaces yet");
  if (truncated || found.size >= MAX_RECORDS) blockers.push("the project has more linked records than one move carries");
  // a target on another server is not readable from here: it checks its own Drive and types when it receives the move (project-move-remote.js)
  if (files.length && !to.drive && to.remote !== true) blockers.push("the target Space has no Drive to receive the files");
  const types = to.types ? new Set((await to.types(to.chain)).map((/** @type {any} */ t) => t.name)) : null;
  // a type the target lacks is installed under the same approval (`to.install`), so it is part of the plan and the hash, not a blocker; without an installer it still blocks
  const install = types ? Object.keys(byType).filter(t => !types.has(t)).sort() : [];
  if (install.length && typeof to.install !== "function") for (const t of install) blockers.push(`the target Space has no record type ${t}`);
  const counts = { records: byType, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), sealed_fields: sealed, ...(chatFiles ? { chat_files: chatFiles, chat_bytes: chatBytes } : {}) };
  const ids = [...found.keys()].sort();
  // the versions too: a record edited after the approval is not the record that was approved
  const versions = [`${root.urn}@${root.version}`, ...[...found.values()].map(r => `${r.urn}@${r.version}`)].sort();
  // base64url, 43 characters: the form the kernel's moves and memory's room move both require of a plan hash
  const hash = crypto.createHash("sha256").update(canonical({ from: from.space, to: to.space, project: root.urn, client, counts, ids, versions, install, hashes: Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)), chat_hashes: chatHashes })).digest("base64url");
  /** @type {Record<string, number>} */ const sizes = Object.fromEntries(files.map(f => [f.path, f.size]));
  return { from: from.space, to: to.space, project: root.urn, client, counts, ids, install, hashes, sizes, hash, blockers, files: files.map(f => f.path), records: [...found.values()].map(r => ({ urn: r.urn, type: r.type })) };
}

/** A slug free in the target. @param {any} to @param {string} base */
async function freeSlug(to, base) {
  for (let n = 1; n < 1000; n++) { const s = n === 1 ? base : `${base}-${n}`; if (!(await to.records.query(to.chain, PROJECT, { filter: { field: "slug", op: "eq", value: s }, page: { limit: 1 } })).rows.length) return s; }
  throw Object.assign(new Error("no free short name in the target Space"), { code: "conflict" });
}

/**
 * Do the move. `ports`: `reseal(fromRef, toRecordUrn, field)` for sealed fields (the sealing process's own transfer), `onStep(name)` for progress and tests, `memory` {offer, export, import, forget} (the memory room's move), `cleanupFiles(paths)` or, with `move_id`, the Drive's `removeMoved` for removing source
 * files (the one approval of the move covers it; with neither, the files are listed as left behind), `state` an object kept between attempts so a resume continues.
 * @param {{ from: any, to: any, plan: any, ports?: any }} o
 */
export async function runMove({ from, to, plan, ports = {} }) {
  if (plan.blockers.length) throw Object.assign(new Error(`this move cannot run: ${plan.blockers.join("; ")}`), { code: "blocked" });
  const state = ports.state || (ports.state = {});
  // once the copy is verified the source is being emptied, so a resume must not re-plan it (it no longer matches); the hash it was approved under is what it continues under
  const removing = state.verified === plan.hash;
  const again = removing ? plan : await planMove({ from, to, project: plan.project, client: plan.client });
  if (again.hash !== plan.hash) throw Object.assign(new Error("the project changed since it was approved; plan the move again"), { code: "stale_plan" });
  if (plan.counts.sealed_fields > 0 && typeof ports.reseal !== "function") throw Object.assign(new Error("sealed fields move only through the sealing process, which this build does not offer yet; nothing was moved"), { code: "unavailable" });
  state.map ||= {};
  // a move that stopped half way resumes from what it saved (the id map above all), so a retry never makes a second target project or copies a record twice
  const persist = async () => { if (typeof ports.save === "function") await ports.save(state); };
  const step = (/** @type {string} */ n) => { if (ports.onStep) ports.onStep(n); };
  const { type, id } = urnParts(plan.project);
  const root = await from.records.get(from.chain, type, id);

  if (plan.install && plan.install.length && !state.installed) { step("install"); await to.install(to.chain, plan.install); state.installed = true; }

  // 1. the new project in the target: new id, new folder, the name and repo, a pointer back
  step("create");
  let target = state.target ? await to.records.get(to.chain, PROJECT, urnParts(state.target).id) : null;
  const pointer = `${from.space}:${root.urn}`;
  // a retry with no saved state finds the project an earlier attempt made (it carries the pointer back) rather than making a second one
  if (!target) { const prior = await to.records.query(to.chain, PROJECT, { filter: { field: "moved_from", op: "eq", value: pointer }, page: { limit: 1 } }); if (prior.rows && prior.rows[0]) target = prior.rows[0]; }
  if (!target) {
    const slug = await freeSlug(to, root.data.slug || "project");
    const made = await to.records.create(to.chain, PROJECT, { name: root.data.name, slug, status: "active", memory_scope: `project:${slug}`, moved_from: pointer, ...(root.data.repo ? { repo: root.data.repo } : {}) });
    target = await to.records.update(to.chain, PROJECT, made.id, { drive_path: `Projects/${made.id}` }, made.version);
  }
  state.target = target.urn;
  await persist();
  state.map[root.urn] = target.urn;

  // 2. records: created without their links first, then the links set through the map (a link to a record that did not move is dropped)
  step("records");
  const wanted = plan.records;
  for (const r of wanted) {
    if (state.map[r.urn]) continue;
    const p = urnParts(r.urn);
    const src = await from.records.get(from.chain, p.type, p.id);
    if (!src) continue;
    /** @type {Record<string, any>} */ const data = {};
    for (const [k, v] of Object.entries(src.data || {})) { if (isSealedValue(v)) continue; if (v && typeof v === "object" && !Array.isArray(v) && typeof /** @type {any} */ (v).urn === "string") continue; data[k] = v; }
    const made = await to.records.create(to.chain, r.type, data);
    state.map[r.urn] = made.urn;
    await persist();
  }
  step("links");
  for (const r of [{ urn: root.urn, type: PROJECT }, ...wanted]) {
    const p = urnParts(r.urn), np = urnParts(state.map[r.urn] || "");
    if (!np.id) continue;
    const src = await from.records.get(from.chain, p.type, p.id);
    if (!src) continue; // already removed by an earlier attempt: its links were set then
    /** @type {Record<string, any>} */ const patch = {};
    for (const [k, v] of Object.entries(src.data || {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && typeof /** @type {any} */ (v).urn === "string") { const m = state.map[/** @type {any} */ (v).urn]; if (m) patch[k] = { urn: m }; }
    }
    if (r.type === PROJECT) patch.moved_from = `${from.space}:${root.urn}`;
    if (Object.keys(patch).length) { const cur = await to.records.get(to.chain, np.type, np.id); await to.records.update(to.chain, np.type, np.id, patch, cur.version); }
  }
  // sealed fields: only through the sealing process, as references, never as values
  if (plan.counts.sealed_fields > 0 && !removing) {
    step("sealed");
    for (const r of [{ urn: root.urn, type: PROJECT }, ...wanted]) {
      const p = urnParts(r.urn);
      const src = await from.records.get(from.chain, p.type, p.id);
      for (const [k, v] of Object.entries(src.data || {})) if (isSealedValue(v)) await ports.reseal(v, state.map[r.urn], k);
    }
  }

  // 3. files, one by one under the mover's chain in each Space, under the new folder
  step("files");
  const oldRoot = root.data.drive_path, newRoot = target.data.drive_path;
  /** @type {Record<string, string>} */ const hashes = {};
  if (!removing) for (const f of plan.files) {
    if (!f.startsWith(`${oldRoot}/`) || f.split("/").some((/** @type {string} */ x) => x === ".." || x === ".")) throw Object.assign(new Error(`a file outside the project's folder was listed (${f}); nothing was copied`), { code: "bad_input" });
    const dest = `${newRoot}${f.slice(oldRoot.length)}`;
    const bytes = bytesOf(await from.drive.get(from.chain, f));
    hashes[f] = sha(bytes);
    if (plan.hashes && plan.hashes[f] && plan.hashes[f] !== hashes[f]) throw Object.assign(new Error(`a file changed since the move was approved (${f}); plan the move again`), { code: "stale_plan" });
    await to.drive.put(to.chain, dest, bytes);
  }

  // 4. verify: the counts and every file's hash in the target
  step("verify");
  if (!removing) for (const f of plan.files) {
    const dest = `${newRoot}${f.slice(oldRoot.length)}`;
    const got = bytesOf(await to.drive.get(to.chain, dest));
    if (sha(got) !== hashes[f]) throw Object.assign(new Error(`a file did not arrive intact (${f}); nothing was removed from the old Space`), { code: "verify_failed" });
  }
  // chat folders: sealed bytes carried by the Space service (`from.carry`, pool to pool inside the sealing processes), listed by the move's own event, each hash checked on what arrives. The mover reads no plaintext.
  if (plan.counts.chat_files && !removing && !state.chat_carried) {
    step("chat-files");
    const inv = (await from.drive.inventory(from.chain, oldRoot, { move_id: ports.move_id })).filter((/** @type {any} */ e) => e.chat);
    const entries = inv.map((/** @type {any} */ e) => ({ path: e.path, dest: `${newRoot}${e.path.slice(oldRoot.length)}`, sha256: e.sha256, size: e.size }));
    if (entries.length !== plan.counts.chat_files) throw Object.assign(new Error("the chat folders changed since the move was approved; plan the move again"), { code: "stale_plan" });
    const got = await from.carry(entries, { move_id: ports.move_id, to: to.space });
    const byPath = new Map((got || []).map((/** @type {any} */ g) => [g.dest, g.sha256]));
    for (const e of entries) if (e.sha256 && byPath.get(e.dest) !== e.sha256) throw Object.assign(new Error(`a chat file did not arrive intact (${e.path}); nothing was removed from the old Space`), { code: "verify_failed" });
    state.chat_carried = entries.map((/** @type {any} */ e) => e.path);
  }
  // every copied record is read back and compared by content (its own fields, not its links and not a sealed value) before anything is removed
  if (!removing) {
    for (const r of wanted) {
      const m = state.map[r.urn]; if (!m) continue;
      const sp = urnParts(r.urn), tp = urnParts(m);
      const a = await from.records.get(from.chain, sp.type, sp.id), b = await to.records.get(to.chain, tp.type, tp.id);
      const plain = (/** @type {any} */ d) => canonical(Object.fromEntries(Object.entries(d || {}).filter(([, v]) => !isSealedValue(v) && !(v && typeof v === "object" && !Array.isArray(v) && typeof /** @type {any} */ (v).urn === "string"))));
      if (!a || !b || plain(a.data) !== plain(b.data)) throw Object.assign(new Error(`a record did not arrive intact (${r.urn}); nothing was removed from the old Space`), { code: "verify_failed" });
    }
  }
  state.verified = plan.hash;
  await persist();
  const mapped = Object.keys(state.map).length - 1;
  if (mapped !== wanted.filter((/** @type {any} */ r) => state.map[r.urn]).length) throw Object.assign(new Error("the records that arrived do not match the plan; nothing was removed"), { code: "verify_failed" });

  // 5. the project's memory room: sealed to a one-use key of the target, imported there with a receipt (`ports.memory`: offer, export, import, forget; the memory module's own calls, one per move id).
  //    Nothing is forgotten in the source until the receipt is in hand and the files are verified.
  if (ports.memory && !state.memory_receipt) {
    step("memory");
    const offer = await ports.memory.offer({ target: target.urn });
    const exp = await ports.memory.export({ to_key: offer.to_key });
    state.memory_receipt = await ports.memory.import({ package: exp.package, into: target.urn });
    await persist();
  }

  // 5b. the Work engine's session lines (`ports.know`: export, import, forget), copied the same way and forgotten only against the receipt
  const knowRecords = [root.urn, ...wanted.map((/** @type {any} */ r) => r.urn)];
  if (ports.know && !state.know_receipt) {
    step("know");
    const exp = await ports.know.export({ records: knowRecords });
    state.know_receipt = await ports.know.import({ rows: exp.rows, map: state.map, from_space: from.space });
    await persist();
  }

  // 6. the old Space keeps a marker and nothing else
  step("marker");
  /** @type {string[]} */ let left = [];
  for (const r of wanted) { const p = urnParts(r.urn); try { const cur = await from.records.get(from.chain, p.type, p.id); if (cur) await from.records.remove(from.chain, p.type, p.id); } catch { /* removed already */ } }
  // 7. the source files go under the mover's chain: the one approval of the move covers it. Resumable: `state.cleaned` is set once they are gone; what cannot be removed is reported, never silently kept
  step("cleanup");
  if (!state.cleaned) {
    const remove = typeof ports.cleanupFiles === "function" ? ports.cleanupFiles : (from.drive && typeof from.drive.removeMoved === "function" && ports.move_id ? (/** @type {string[]} */ paths) => from.drive.removeMoved(from.chain, paths, { move_id: ports.move_id }).then(() => []) : null);
    const allFiles = [...plan.files, ...(state.chat_carried || [])];
    left = remove ? ((await remove(allFiles)) || []) : allFiles;
    if (!left.length) state.cleaned = true;
  }
  if (ports.know && state.know_receipt && !state.know_forgotten) {
    step("forget-know");
    try { await ports.know.forget({ records: knowRecords, receipt: state.know_receipt }); }
    catch (e) {
      // a line was written to the project between the copy and now: copy again (an import is idempotent, a repeat only fills in what is new) and forget against the new receipt, once
      if (/** @type {any} */ (e).code !== "conflict") throw e;
      const exp = await ports.know.export({ records: knowRecords });
      state.know_receipt = await ports.know.import({ rows: exp.rows, map: state.map, from_space: from.space });
      await persist();
      await ports.know.forget({ records: knowRecords, receipt: state.know_receipt });
    }
    state.know_forgotten = true;
  }
  if (ports.memory && state.memory_receipt && !state.memory_forgotten) {
    step("forget");
    /** @type {any} */ let f;
    try { f = await ports.memory.forget({ receipt: state.memory_receipt }); }
    catch (e) {
      // the room changed between the export and now (a write filed while the move ran): carry it again, then forget against the new receipt, once
      if (/** @type {any} */ (e).code !== "conflict") throw e;
      const offer = await ports.memory.offer({ target: state.target });
      const exp = await ports.memory.export({ to_key: offer.to_key });
      state.memory_receipt = await ports.memory.import({ package: exp.package, into: state.target });
      await persist();
      f = await ports.memory.forget({ receipt: state.memory_receipt });
    }
    state.memory_forgotten = true; state.memory_counts = f && f.forgotten;
  }
  const cur = await from.records.get(from.chain, PROJECT, id);
  await from.records.update(from.chain, PROJECT, id, { status: "moved", moved_to: `${to.space}:${target.urn}`, repo: null, client: null, drive_path: null, memory_scope: null }, cur.version);
  const out = { target: target.urn, moved: { records: wanted.length, files: plan.files.length, ...(state.memory_receipt ? { memory: state.memory_receipt.counts } : {}), ...(state.know_receipt ? { know: state.know_receipt.count } : {}) }, left_behind: left, map: state.map };
  step("done");
  return out;
}
