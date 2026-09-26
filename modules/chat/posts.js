// @ts-check
// posts — what Chat puts in Mattermost, as plain data. No state, no network.
//
// The rule behind all of it, ported from the prototype (channels.cjs): if it has to work on the
// phone, it is a post with buttons or a slash command, never custom UI. Web plugin panels do not
// render in the mobile apps; interactive posts do, on every platform, and look native because
// they are. A held draft is never edited in a form here: the post always shows the words Send
// will send, `/vyre body` and `/vyre subject` replace them, and "Edit in Deck" opens the Deck,
// where every field is edited inline.
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
 * @typedef {{ hook: string, secret: string, deck?: string }} Hook   where buttons post back, the secret they carry, and the Deck's address
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
 * Something held at the Gate: Send, Discard, and Edit in Deck when the Deck's address is known.
 * The message is the words Send will send; a revision patches it (heldPatch), so the two never
 * differ (floor rule 1).
 * @param {{ id: string, kind: string, via: string, to: any, summary?: string, agent?: string|null, why?: string|null }} item
 * @param {any} draft the current content (the last revision, else the draft), from gate.get, or null when it could not be read
 * @param {{ channel: string, root?: string|null } & Hook} o
 */
export function heldPost(item, draft, o) {
  const { message, props } = held(item, draft, o);
  return { ...textPost({ channel: o.channel, root: o.root, message }), props };
}

/**
 * The held post's new message and buttons after a revision.
 * @param {any} item @param {any} draft @param {Hook} h
 */
export function heldPatch(item, draft, h) {
  const { message, props } = held(item, draft, h);
  return { message: cut(message, MAX_POST), props };
}

/** @param {any} item @param {any} draft @param {Hook} h */
function held(item, draft, h) {
  const who = item.agent || "An agent";
  const what = item.kind === "spend" ? "wants to spend" : item.kind === "delete" ? "wants to delete" : "wrote this";
  const head = `**Held at the Gate** · ${who} ${what}${item.summary ? `: ${cut(item.summary, 200)}` : ""}`;
  const change = typeof draft?.body === "string"
    ? `Change the words with \`/vyre body ${item.id} <new text>\`${typeof draft?.subject === "string" ? ` or \`/vyre subject ${item.id} <text>\`` : ""}.`
    : "";
  const message = [head, draftText(item, draft), item.why ? `_Why:_ ${cut(item.why, 400)}` : "", `Send sends exactly what is shown here. ${change}`.trim()]
    .filter(Boolean).join("\n\n");
  const actions = [button(h, "gate", item.id, "send", "Send", "primary"), button(h, "gate", item.id, "discard", "Discard", "danger")];
  // A link, not a callback: opening the Deck is something the person does. It carries the id
  // anyway, since every button does (channels.cjs); Mattermost ignores context on a link.
  if (h.deck) actions.push({ id: "deck", name: "Edit in Deck", style: "default",
    integration: { url: `${h.deck.replace(/\/+$/, "")}/now/held/${encodeURIComponent(item.id)}`, context: { kind: "gate", id: item.id, action: "deck" } } });
  return { message, props: { attachments: [{ fallback: head, title: "Held", actions }] } };
}

/**
 * What a resolved question or held item becomes: the same message, the outcome, no buttons.
 * @param {string} message the post's current message @param {string} outcome
 */
export function resolvedPatch(message, outcome) {
  return { message: cut(message, MAX_POST - 200), props: { attachments: [{ fallback: outcome, text: outcome, actions: [] }] } };
}
