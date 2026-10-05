// @ts-check
// deck/ui/scenario: "a client pays" (team/0.3/DESIGN-tasks.md, the scenario that has to feel effortless), written against the Store interface alone, so it runs on
// the mock store now and on the real gateway later. A payment arrives; the project is made from the firm's Kit with its team; Research reads about the client and
// writes what it found onto the record, with sources; Intake drafts the Welcome email from the Welcome template using Research's notes and leaves it for one tap.
// The person's tap (Send with Face ID) is not part of it: it is store.decide, and the stage then moves on by itself.
import { aid } from "./kernel-view.js";
import { actorValue, money, ref } from "./mock-values.js";

/** @typedef {import("./contracts.js").Store} Store */

/**
 * @typedef {{ name?: string, email?: string, phone?: string }} Client
 * @typedef {{ client?: Client, amount?: number, pace?: number, sleep?: (ms: number) => Promise<void>, onStep?: (step: number, what: string) => void,
 *   findings?: { situation: string, assets: string, pressure: string, notes: string, sources: string[] } }} Options
 */

const DEFAULT_FINDINGS = {
  situation: "Widowed, two adult children",
  assets: "House at 18 Larkin St, sale in November",
  pressure: "Fund the trust before the sale",
  notes: "Wants the trust funded before the house sale in November. Two adult children, Marcus is the likely successor trustee.",
  sources: ["Intake form, 8 Sep", "County property record", "Her first message"],
};

/**
 * Plays the scenario and returns when the Welcome email waits for the person. Steps: 1 payment, 2 project and team, 3 Research done, 4 Welcome drafted.
 * @param {Store} store @param {Options} [o]
 * @returns {Promise<{ contact: string, matter: string, task: string }>} the urns of the contact and the matter, and the id of the Welcome task
 */
export async function runClientPays(store, o = {}) {
  const client = { name: "Jane Doe", email: "jane.doe@example.com", phone: "+1 415 555 0142", ...(o.client || {}) };
  const amount = o.amount ?? 1500;
  const findings = o.findings || DEFAULT_FINDINGS;
  const pause = async (/** @type {number} */ step, /** @type {string} */ what) => { o.onStep?.(step, what); if (o.pace && o.sleep) await o.sleep(o.pace); };
  const first = String(client.name).split(" ")[0], last = String(client.name).split(" ").slice(1).join(" ") || String(client.name);
  const money$ = `$${amount.toLocaleString("en-US")}`;
  const [me, spaces] = await Promise.all([store.me ? store.me() : Promise.resolve(""), store.spaces()]);
  const team = spaces.find((s) => s.kind === "team");
  const space = team?.id || spaces[0].id;

  await pause(1, `${client.name} paid ${money$}`);
  const known = (await store.list("contact")).find((c) => c.data.name === client.name);
  const contact = known || await store.create("contact", { name: client.name, role: "Client", email: [client.email], phone: [client.phone] }, { by: "vyre", space });

  const matter = await store.create("matter", { title: `${last} estate plan`, client: ref(contact.urn), plan: "Both", fee: money(amount), owner: actorValue({ kind: "person", id: me, space }) },
    { by: "vyre", why: `Flow On payment: ${client.name} paid ${money$}.`, space });
  await pause(2, `${matter.data.title} was created from the Kit, and its team is working`);

  const mine = await store.tasks({ record: matter.urn });
  const research = mine.find((t) => aid(t.doer) === "research");
  if (!research) throw new Error("The Kit made no Research task.");
  await store.update(matter.urn, { situation: findings.situation, assets: findings.assets, pressure: findings.pressure,
    research: `Sources: ${findings.sources.join(", ")}. ${findings.notes}` }, matter.version, "research");
  await store.editTask(research.id, /** @type {any} */ ({ ext: { ...(research.ext || {}), now: "is reading the intake form and the county record" } }), "research");
  await store.submit(research.id, { note: { text: findings.notes, sources: findings.sources } }, "research");
  await pause(3, `Research filled 3 fields and added a note with ${findings.sources.length} sources`);

  const welcome = (await store.tasks({ record: matter.urn })).find((t) => aid(t.doer) === "intake" && t.output.kind === "sent");
  if (!welcome) throw new Error("The Kit made no Welcome email task.");
  const [templates, actors, fresh] = await Promise.all([store.list("template"), store.actors(), store.get(matter.urn)]);
  const tpl = templates.find((t) => t.urn === welcome.template);
  const attorney = actors.find((a) => a.id === aid(/** @type {any} */ (fresh?.data.owner)?.actor))?.name || "your attorney";
  const tailored = "I read that you want the trust funded before the house sale in November, so we will start there. We will also ask about Marcus at our first call.";
  const fill = (/** @type {string} */ s) => s.replace("[Client first name]", first).replace("[Tailored paragraph]", tailored).replace("[Matter title]", String(matter.data.title))
    .replace("[Attorney name]", attorney).replace("[Firm signature]", "Harlow Legal");
  await store.submit(welcome.id, { draft: { subject: fill(String(tpl?.data.subject || "Welcome")), body: fill(String(tpl?.data.body || `Hi ${first},`)), sources: findings.sources.length } }, "intake");
  await pause(4, `Welcome email for ${client.name} is ready`);
  return { contact: contact.urn, matter: matter.urn, task: welcome.id };
}
