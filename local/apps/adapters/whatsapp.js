// @ts-check
// whatsapp: a message to one chat in WhatsApp for Mac, through the app's own window, with
// capsule-sight's hands (local/hands-mac: observe, find, act, commit). WhatsApp has no API for a
// person's own account, so the accessibility tree is the way in (tier ax).
//
// A send is `sends` (apps.send): the person proves it once (or rides their presence session),
// and every step below runs as module:apps, which the floor still binds. The steps, and why:
// 1. Search for the chat by name (set the search field; never a key), then press the one row whose
//    name is exactly the name asked for. Two rows that both could be it are a question, never a
//    pick; none is not_found. Nothing has been typed into a chat yet.
// 2. Check the chat that opened is that one: an element named exactly the chat's name must be
//    there beside the composer. Otherwise stop, before a word is written.
// 3. Set the composer to the words (set, not type, so a line break never sends early), and check
//    it holds exactly them.
// 4. Press Send through hands.commit, never Return: a key needs WhatsApp in front, and Return is
//    how a half-written message goes out. Then check the composer emptied and the words show.
// On any stop before Send, the composer is cleared again, so nothing half-written waits there.
// After Send is pressed there is no retry here: a send that did not verify is reported as "check
// WhatsApp", because pressing again could send it twice.
//
// WhatsApp's tree changes between versions, so every name and role below is a list, and config
// apps.whatsapp can replace any of them (search, rows, composer, send, header) after a real-Mac
// check. settleMs is 3000 to 4000: WhatsApp is slow to redraw.

import { AppsError } from "../env.js";

export const DEFAULTS = {
  app: "net.whatsapp.WhatsApp",
  search: { roles: ["AXTextField", "AXSearchField"], names: ["Search", "Search or start a new chat", "Search or start new chat"] },
  rows: { roles: ["AXCell", "AXRow", "AXButton"] },
  composer: { roles: ["AXTextArea", "AXTextView", "AXTextField"], names: ["Type a message", "Compose message", "Message"] },
  send: { roles: ["AXButton"], names: ["Send"] },
  header: { roles: ["AXStaticText", "AXHeading", "AXButton"] },
};

/** The names and roles in force: config apps.whatsapp over the defaults, part by part. */
function conf(/** @type {import("../env.js").Env} */ env) {
  const c = env.config && env.config.whatsapp && typeof env.config.whatsapp === "object" ? env.config.whatsapp : {};
  /** @type {any} */
  const out = { app: typeof c.app === "string" && c.app ? c.app : DEFAULTS.app };
  for (const k of /** @type {const} */ (["search", "rows", "composer", "send", "header"])) out[k] = { ...DEFAULTS[k], ...(c[k] && typeof c[k] === "object" ? c[k] : {}) };
  return out;
}

const lower = (/** @type {unknown} */ v) => String(v ?? "").trim().toLowerCase();

/** A hands tool's answer, or its refusal in words with the code kept (stopped, floor, not_built...). */
async function hands(/** @type {import("../env.js").Env} */ env, /** @type {string} */ tool, /** @type {any} */ input) {
  const r = await env.call(tool, input);
  if (r && r.error) {
    if (r.error.code === "no_such_tool") throw new AppsError("setup", "Vyre's hands are not on this Mac, so it cannot drive WhatsApp");
    const code = /^[a-z][a-z0-9_]{1,40}$/.test(String(r.error.code)) ? r.error.code : "failed";
    throw new AppsError(code, String(r.error.message || `${tool} failed`).replace(/^[a-z_]+: /, ""));
  }
  return r ? r.data : null;
}

/**
 * The controls of one kind: each role in turn, those whose name is one of `names` (any name when
 * the part has none), closest to `near` first.
 * @param {import("../env.js").Env} env @param {string} app @param {{ roles: string[], names?: string[] }} part @param {string} [near]
 */
async function find(env, app, part, near) {
  for (const role of part.roles) {
    const d = await hands(env, "hands.find", { app, role, ...(near ? { near } : {}), limit: 100 });
    if (d && d.blind) throw new AppsError("floor", `Vyre may not look at WhatsApp right now (${d.blind})`);
    const els = (d && Array.isArray(d.elements) ? d.elements : []).filter((/** @type {any} */ e) => e && e.selector && e.enabled !== false);
    const hits = part.names && part.names.length ? els.filter((/** @type {any} */ e) => part.names.some(n => lower(e.selector.name) === lower(n))) : els;
    if (hits.length) return hits;
  }
  return [];
}

/** One act, or stop with the reason when it did nothing or was not seen to work. */
async function act(/** @type {import("../env.js").Env} */ env, /** @type {any} */ input, /** @type {string} */ what, commit = false) {
  const r = await hands(env, commit ? "hands.commit" : "hands.act", { settleMs: 3000, ...input });
  if (r && r.held) throw new AppsError("failed", `${what} was held as sending; nothing was done`);
  if (!r || !r.acted) throw new AppsError("failed", `${what}: ${r && r.reason ? r.reason : "WhatsApp did not take it"}`);
  return r;
}

/** Open the one chat named `to`, and check it is the one that opened. */
async function openChat(/** @type {import("../env.js").Env} */ env, /** @type {any} */ c, /** @type {string} */ to) {
  const search = (await find(env, c.app, c.search))[0];
  if (!search) throw new AppsError("not_found", "WhatsApp's search field is not there; is WhatsApp open and signed in?");
  await act(env, { app: c.app, selector: search.selector, kind: "set", value: to }, "searching WhatsApp");
  const rows = (await find(env, c.app, c.rows)).filter((/** @type {any} */ e) => e.selector.name && e.selector.path !== search.selector.path);
  const exact = rows.filter((/** @type {any} */ e) => lower(e.selector.name) === lower(to));
  // One row by that exact name. Two (two people, or the same name in two places) are a question
  // for the person, as are only near misses: never a pick.
  if (exact.length > 1) throw new AppsError("ambiguous", `WhatsApp has more than one chat called ${to}; open the right one and try again`);
  if (!exact.length) {
    const near = rows.filter((/** @type {any} */ e) => lower(e.selector.name).includes(lower(to))).map((/** @type {any} */ e) => e.selector.name).slice(0, 5);
    throw new AppsError("not_found", near.length ? `WhatsApp has no chat called exactly ${to} (it has ${near.join(", ")})` : `WhatsApp has no chat called ${to}`);
  }
  await act(env, { app: c.app, selector: exact[0].selector, kind: "press", settleMs: 4000 }, `opening the chat with ${to}`);
  const composer = (await find(env, c.app, c.composer))[0];
  if (!composer) throw new AppsError("failed", `the chat with ${to} opened without a message field; nothing was written`);
  if (!(await isOpen(env, c, to, composer, exact[0].selector.path))) throw new AppsError("failed", `could not confirm the open chat is ${to}; nothing was written`);
  return composer;
}

/**
 * Whether the chat on screen is still `to`: an element named exactly that beside the message
 * field (not the list row that was pressed). The message field has no name of its own chat, so
 * this is asked again before the words go in and again right before Send: a person clicking
 * another chat in between must never get these words.
 */
async function isOpen(/** @type {import("../env.js").Env} */ env, /** @type {any} */ c, /** @type {string} */ to, /** @type {any} */ composer, /** @type {string} */ row = "") {
  const header = (await find(env, c.app, { ...c.header, names: [to] }, composer.selector.path))
    .filter((/** @type {any} */ e) => e.selector.path !== row && !/^AXCell|^AXRow/.test(e.selector.role));
  return header.length > 0;
}

/** The composer emptied, so nothing half-written is left in the chat. Best effort. */
async function clear(/** @type {import("../env.js").Env} */ env, /** @type {any} */ c, /** @type {any} */ composer) {
  try { await hands(env, "hands.act", { app: c.app, selector: composer.selector, kind: "set", value: "", settleMs: 1500 }); } catch {}
}

/** @type {import("./index.js").Adapter} */
export default {
  id: "whatsapp",
  app: "WhatsApp",
  bundleIds: ["net.whatsapp.WhatsApp", "desktop.WhatsApp"],
  tier: "ax",
  // targets are the chats on screen; a send searches for any other by its exact name.
  partialTargets: true,
  actions: {
    send: {
      title: "Send a message",
      input: { type: "object", required: ["to", "text"], properties: {
        to: { type: "string", maxLength: 100, description: "The chat's name, exactly as WhatsApp shows it." },
        text: { type: "string", minLength: 1, maxLength: 4000 },
      } },
      sends: true,
      preview: args => `WhatsApp → ${String(args.to || "").trim()}: ${String(args.text || "")}`,
      async run(args, env) {
        const c = conf(env);
        const to = String(args.to).trim(), text = String(args.text);
        if (!to) throw new AppsError("bad_input", "who is the WhatsApp message for?");
        const composer = await openChat(env, c, to);
        const moved = () => new AppsError("failed", `the open chat is no longer ${to}; nothing was sent`);
        /** @type {any} */
        let send;
        try {
          if (!(await isOpen(env, c, to, composer))) throw moved();
          const set = await act(env, { app: c.app, selector: composer.selector, kind: "set", value: text }, "writing the message");
          if (!set.verified) throw new AppsError("failed", "the message field did not take the words; nothing was sent");
          send = (await find(env, c.app, c.send, composer.selector.path))[0];
          if (!send) throw new AppsError("failed", "WhatsApp's Send button is not there; nothing was sent");
          if (!(await isOpen(env, c, to, composer))) throw moved();
        } catch (e) { await clear(env, c, composer); throw e; }
        // The one step that sends. No retry after this: a second press could send it twice.
        const r = await act(env, { app: c.app, selector: send.selector, kind: "press", settleMs: 4000 }, "pressing Send", true);
        const after = (await find(env, c.app, c.composer))[0];
        const emptied = !after || !after.value;
        return r.verified && emptied
          ? { said: `Sent to ${to} on WhatsApp`, verified: true }
          : { said: `Pressed Send in the chat with ${to}; Vyre could not see it go, so check WhatsApp before sending again`, verified: false };
      },
    },
  },
  /** The chats on screen in WhatsApp's list, by name. Reading them types nothing and opens nothing. */
  async targets(q, env) {
    const c = conf(env);
    const search = (await find(env, c.app, c.search))[0];
    const rows = (await find(env, c.app, c.rows)).filter((/** @type {any} */ e) => e.selector.name && (!search || e.selector.path !== search.selector.path));
    const seen = new Set();
    /** @type {Array<{ id: string, title: string, kind: string }>} */
    const out = [];
    for (const e of rows) {
      const name = String(e.selector.name).trim();
      if (!name || seen.has(lower(name))) continue;
      seen.add(lower(name));
      out.push({ id: name, title: name, kind: "chat" });
    }
    const k = lower(q);
    return k ? out.filter(t => lower(t.title).includes(k)) : out;
  },
};
