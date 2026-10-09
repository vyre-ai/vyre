// @ts-check
// The LinkedIn site kit: what to teach, in what order, and how an account is kept safe. It is a recipe, not captured traffic: LinkedIn changes its calls often, so the operations are learned from
// the person's own signed-in session, on their own account, with the method (pin the intent, name the operation, two examples, prove on a third), and healed when the site changes. The kit says
// which operations make the flagship set, the page each is taught from, which fields a person wants back, and that sending anything is held for their yes.
//
// Safety is not optional here and it is not a fixed rule: the account's pace, daily caps, quiet hours and the stop at the first security check come from core/connectors/governor.js, with
// conservative defaults for this site that the person may change for their own account.

export const LINKEDIN_KIT = Object.freeze({
  id: "linkedin",
  label: "LinkedIn",
  origins: Object.freeze(["https://www.linkedin.com"]),
  /** The profile the account governor applies unless the person sets their own (governor.js WATCHED). */
  governor: "strict",
  note: "LinkedIn watches for automation. Reads go at a person's pace, a message or a connection request is held for your yes and made once, and the first security check stops the account until you clear it.",
  operations: Object.freeze([
    { name: "readProfile", kind: "read", inputs: [{ name: "slug", hint: "the public id in linkedin.com/in/<slug>", pattern: "[A-Za-z0-9%_.-]{3,100}" }],
      trigger: { url: "https://www.linkedin.com/in/{slug}/" }, wants: ["firstName", "lastName", "headline", "locationName", "publicIdentifier", "summary"],
      teach: "Open a profile you may read; use two different public profiles as the two examples; then prove it on a third." },
    { name: "readCompany", kind: "read", inputs: [{ name: "slug", hint: "the public id in linkedin.com/company/<slug>", pattern: "[A-Za-z0-9%_.-]{2,100}" }],
      trigger: { url: "https://www.linkedin.com/company/{slug}/" }, wants: ["name", "tagline", "industry", "staffCount", "websiteUrl", "universalName"],
      teach: "Two different company pages as examples; prove it on a third." },
    { name: "searchPeople", kind: "read", inputs: [{ name: "keywords", hint: "what to search for, as typed in the search box", pattern: ".{3,100}" }],
      trigger: { url: "https://www.linkedin.com/search/results/people/?keywords={keywords}" }, wants: ["title", "primarySubtitle", "secondarySubtitle", "navigationUrl"],
      teach: "Two different searches as examples; prove it on a third." },
    { name: "readInbox", kind: "read", inputs: [], trigger: { url: "https://www.linkedin.com/messaging/" }, wants: ["entityUrn", "lastActivityAt", "preview"], pickRequest: true,
      teach: "Takes no input, so the request is chosen from the scout rather than found by an example: scout the Messaging page and pass the id of the conversations call." },
    { name: "sendMessage", kind: "send", inputs: [{ name: "to", hint: "the person's public id", pattern: "[A-Za-z0-9%_.-]{3,100}" }, { name: "text", hint: "the message", pattern: "[\\s\\S]{3,3000}" }],
      trigger: { url: "https://www.linkedin.com/messaging/thread/new/", steps: [{ action: "fill", selector: { role: "textbox", name: "Write a message" }, value: "{text}" }, { action: "click", selector: { role: "button", name: "Send" } }] },
      teach: "Taught with the request BLOCKED (nothing is sent) after you say yes; two different recipients and texts as the examples. Every later call waits for your yes." },
    { name: "sendConnectionRequest", kind: "send", inputs: [{ name: "slug", hint: "the public id in linkedin.com/in/<slug>", pattern: "[A-Za-z0-9%_.-]{3,100}" }, { name: "note", hint: "an optional note", pattern: "[\\s\\S]{3,300}" }],
      trigger: { url: "https://www.linkedin.com/in/{slug}/", steps: [{ action: "click", selector: { role: "button", name: "Connect" } }, { action: "click", selector: { role: "button", name: "Add a note" } }, { action: "fill", selector: { role: "textbox", name: "Add a note" }, value: "{note}" }, { action: "click", selector: { role: "button", name: "Send" } }] },
      teach: "Taught with the request BLOCKED after you say yes; two different people as the examples. Every later call waits for your yes, and invitations count against the account's daily limit." },
  ]),
});

/** The kits Vyre ships, by id. */
export const KITS = Object.freeze({ linkedin: LINKEDIN_KIT });

/** The kit for a site, by its origin or id; null when none. @param {string} site */
export function kitFor(site) {
  const s = String(site || "").toLowerCase();
  for (const k of Object.values(KITS)) if (k.id === s || k.origins.some(o => s === o || s.startsWith(o + "/") || s.replace(/^https?:\/\/(www\.)?/, "") === o.replace(/^https?:\/\/(www\.)?/, ""))) return k;
  return null;
}

/**
 * The plan for teaching a kit, in the order to do it: one entry per operation with the call to make (chrome_op learn arguments, the examples left for the person to choose) and the words to say.
 * @param {typeof LINKEDIN_KIT} kit
 */
export function teachPlan(kit) {
  return kit.operations.map((o, i) => ({
    step: i + 1, name: o.name, kind: o.kind, inputs: o.inputs.map(x => ({ name: x.name, hint: x.hint })), teach: o.teach,
    learn: { action: "learn", site: kit.origins[0], name: o.name, kind: o.kind, trigger: o.trigger, wants: o.wants, examples: o.inputs.length ? "[two objects of different values for " + o.inputs.map(x => x.name).join(", ") + ", chosen with the person]" : "[{}] and pass the scout's request id", ...(o.pickRequest ? { pickRequest: true } : {}) },
    then: o.kind === "read" ? "chrome_op save with verify = inputs that were not examples" : "chrome_op save (a send is kept without being run)",
  }));
}
