// @ts-check
// What a module puts in the app, as data (ADR 0047 section 3, shows.deck): a Now card is a tool the module names as `now:<tool>`; the app calls it and draws { title, detail?, meta? }. The module
// supplies words and never styles. This file only reads the answers; nothing here draws.

/** @typedef {{ module: string, tool: string }} NowSlot @typedef {{ module: string, tool: string, title: string, detail: string, meta: string }} NowCard */

/** The Now slots of the running modules, in the order the box listed them. @param {any} answer what `system.modules` answered @returns {NowSlot[]} */
export function nowSlots(answer) {
  const rows = answer && Array.isArray(answer.modules) ? answer.modules : [];
  /** @type {NowSlot[]} */ const out = [];
  for (const m of rows) {
    if (!m || m.state !== "running" || typeof m.name !== "string") continue;
    for (const t of Array.isArray(m.now) ? m.now : []) if (typeof t === "string" && t.startsWith(m.name + ".")) out.push({ module: m.name, tool: t });
  }
  return out;
}

/** One card from a tool's answer, or null when it answered nothing a card can show (never a throw: a module's card must not break Now). @param {NowSlot} slot @param {any} data @returns {NowCard | null} */
export function nowCard(slot, data) {
  if (!data || typeof data !== "object" || typeof data.title !== "string" || !data.title.trim()) return null;
  const s = (/** @type {unknown} */ v, /** @type {number} */ max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return { module: slot.module, tool: slot.tool, title: s(data.title, 80), detail: s(data.detail, 200), meta: s(data.meta, 80) };
}

/** Load every module's Now card: `call(tool, input)` answers { data } or { error }. A module that fails or answers nothing is left out. @param {(tool: string, input?: any) => Promise<{ data?: any, error?: any }>} call @returns {Promise<NowCard[]>} */
export async function loadNowCards(call) {
  const listed = await call("system.modules", {});
  const slots = nowSlots(listed && listed.data);
  const cards = await Promise.all(slots.map(async slot => {
    try { const r = await call(slot.tool, {}); return r && r.data ? nowCard(slot, r.data) : null; } catch { return null; }
  }));
  return /** @type {NowCard[]} */ (cards.filter(Boolean));
}
