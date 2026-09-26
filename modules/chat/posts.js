// @ts-check
// posts — what Chat puts in Mattermost, as plain data. No state, no network.
//
// The rule behind all of it, ported from the prototype (channels.cjs): if it has to work on the
// phone, it is a post with buttons or a slash command, never custom UI. Web plugin panels do not
// render in the mobile apps; interactive posts and interactive dialogs do, on every platform,
// and look native because they are. Editing a held draft is a Mattermost dialog for that reason.
//
// Every button carries the id of the thing it answers ({kind, id, action}), because the answer
// has to route back to the question that raised it. Matching on message text would be guessing,
// and a wrong guess answers the wrong question. It also carries `s`, this install's hook secret,
// so a request that did not come from a post Chat made is refused even if it names a real id.

/** Mattermost refuses posts over 16383 characters. */
export const MAX_POST = 16000;

/** @param {string} s @param {number} n */
export const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

/** Quote text as a Markdown block, line by line. @param {string} s */
const quote = s => String(s).split("\n").map(l => "> " + l).join("\n");

/** @param {string|string[]|null|undefined} to */
export const toText = to => (Array.isArray(to) ? to.join(", ") : to ? String(to) : "an unnamed destination");

/**
 * @typedef {{ hook: string, secret: string }} Hook   where buttons post back, and the secret they carry
 */

/**
 * One button whose press Mattermost posts to our listener with its context.
 * @param {Hook} h @param {"ask"|"gate"} kind @param {string} id @param {string} action @param {string} label @param {string} style
 */
function button(h, kind, id, action, label, style) {
  return { id: action, name: label, style, integration: { url: h.hook + "/chat/action", context: { kind, id, action, s: h.secret } } };
}

/**
 * A plain message, as a reply in a thread when root is given.
 * @param {{ channel: string, root?: string|null, message: string }} p
 */
export function textPost({ channel, root, message }) {
  return { channel_id: channel, message: cut(message, MAX_POST), ...(root ? { root_id: root } : {}) };
}

/**
 * A permission question from Claude Code, answerable with a thumb.
 * @param {{ ask: string, tool: string, summary?: string, destination?: string|null, reason?: string|null }} ask
 * @param {{ channel: string, root?: string|null } & Hook} o
 */
export function askPost(ask, o) {
  const lines = [`**May I run** \`${cut(ask.summary || ask.tool, 400).replace(/`/g, "'")}\``];
  if (ask.destination) lines.push(`Going to: ${cut(ask.destination, 300)}`);
  if (ask.reason) lines.push(cut(ask.reason, 600));
  const message = lines.join("\n");
  return {
    ...textPost({ channel: o.channel, root: o.root, message }),
    props: { attachments: [{ fallback: message, title: "Permission", actions: [
      button(o, "ask", ask.ask, "allow", "Allow", "good"),
      button(o, "ask", ask.ask, "deny", "Deny", "danger"),
    ] }] },
  };
}

/**
 * The words that will go out, as the user will read them. Floor rule 1: the user sees the final
 * words; rule 2: they see where the words are going, which is why `to` comes first.
 * @param {{ via: string, to: any, kind?: string }} item @param {any} draft
 */
export function draftText(item, draft) {
  const lines = [`To: ${toText(item.to)} · via ${item.via}`];
  if (draft && typeof draft === "object") {
    if (draft.cc) lines.push(`Cc: ${toText(draft.cc)}`);
    if (draft.subject) lines.push(`Subject: ${draft.subject}`);
    if (typeof draft.body === "string") lines.push("", quote(cut(draft.body, 12000)));
    else if (draft.url) lines.push(`${draft.method || "GET"} ${draft.url}`);
  }
  return lines.join("\n");
}

/**
 * Something held at the Gate: Send, Edit, Discard.
 * @param {{ id: string, kind: string, via: string, to: any, summary?: string, agent?: string|null, why?: string|null }} item
 * @param {any} draft the content, from gate.get, or null when it could not be read
 * @param {{ channel: string, root?: string|null } & Hook} o
 */
export function heldPost(item, draft, o) {
  const who = item.agent || "An agent";
  const what = item.kind === "spend" ? "wants to spend" : item.kind === "delete" ? "wants to delete" : "wrote this";
  const head = `**Held at the Gate** · ${who} ${what}${item.summary ? `: ${cut(item.summary, 200)}` : ""}`;
  const body = [head, draftText(item, draft), item.why ? `_Why:_ ${cut(item.why, 400)}` : "", "Nothing goes out until you press Send."]
    .filter(Boolean).join("\n\n");
  const actions = [button(o, "gate", item.id, "send", "Send", "primary")];
  // Only something with words to change can be edited; a dialog with no fields helps nobody.
  if (editable(draft).length || item.to) actions.push(button(o, "gate", item.id, "edit", "Edit", "default"));
  actions.push(button(o, "gate", item.id, "discard", "Discard", "danger"));
  return { ...textPost({ channel: o.channel, root: o.root, message: body }), props: { attachments: [{ fallback: head, title: "Held", actions }] } };
}

/** The string fields of a draft a person may change, body last. @param {any} draft */
export function editable(draft) {
  if (!draft || typeof draft !== "object") return [];
  const keys = Object.keys(draft).filter(k => typeof draft[k] === "string" && !["method", "url"].includes(k));
  return [...keys.filter(k => k !== "body"), ...keys.filter(k => k === "body")].slice(0, 9);
}

/**
 * The edit dialog for a held item, with the draft filled in. Submitting it is the approval.
 * `state` carries the id and the secret back to us; Mattermost returns it untouched.
 * @param {{ id: string, to: any }} item @param {any} draft @param {Hook} h
 */
export function editDialog(item, draft, h) {
  const elements = [{ display_name: "To", name: "to", type: "text", default: Array.isArray(item.to) ? item.to.join(", ") : String(item.to || ""), optional: false, max_length: 2000 }];
  for (const k of editable(draft)) {
    const long = k === "body" || String(draft[k]).length > 150;
    elements.push({ display_name: k[0].toUpperCase() + k.slice(1).replace(/_/g, " "), name: k, type: long ? "textarea" : "text",
      default: String(draft[k]), optional: k !== "body", max_length: long ? 10000 : 500 });
  }
  return {
    callback_id: "gate",
    title: "Edit before sending",
    introduction_text: "What you submit here is what goes out.",
    submit_label: "Send",
    notify_on_cancel: false,
    state: JSON.stringify({ id: item.id, s: h.secret }),
    elements,
  };
}

/**
 * What a resolved question or held item becomes: the same message, the outcome, no buttons.
 * @param {string} message the post's current message @param {string} outcome
 */
export function resolvedPatch(message, outcome) {
  return { message: cut(message, MAX_POST - 200), props: { attachments: [{ fallback: outcome, text: outcome, actions: [] }] } };
}
