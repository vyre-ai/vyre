// @ts-check
// apps: drive the Mac's apps from the Capsule, the CLI and the phone. "timer 10 min", "note: buy
// milk", "remind me to call juno at 6", "weather tomorrow".
//
// apps.route turns a person's words into one of these calls without running it; apps.setup does
// an app's one-time setup (Clock's two shortcuts).
//
// The action tools: apps.list says what is installed and how well Vyre can reach each app.
// apps.targets lists the things inside one app a person might pick (notes, reminder lists, later
// chats and channels). apps.act runs an action that sends nothing as the person. apps.send runs
// one that does (a message, a post), and declares presence, so every caller that is not a module,
// models included, needs a person's proof for each call. That proof may be the short presence
// session (ADR 0004) opened by one strong proof in the surface that holds its secret, so a
// burst of messages does not ask for Touch ID each time; each send is still previewed there.
//
// Starting the module costs nothing: no scan, no process, no timer. The folders are read on the
// first apps.list, and each cache expires when it is read. Every contact with the Mac goes
// through env.js, which a test builds over fakes.

import { checkInput } from "../../core/modules/index.js";
import { makeEnv, AppsError } from "./env.js";
import { adapters } from "./adapters/index.js";
import { installed, DEFAULT_DIRS } from "./installed.js";
import { route, sendTo, timeKind, withParsed, appleAsked } from "./route.js";
import { rank as rankTargets, STRONG } from "./fuzzy.js";
import { setupFor } from "./setup.js";
import path from "node:path";
import * as vyreConfig from "../../core/config/index.js";

export const TARGETS_TTL_MS = 60 * 1000;
export const LIST_MAX = 100;

/** Messaging apps worth offering when they are installed, in this order. */
export const MESSAGING = ["Messages", "WhatsApp", "Slack", "Telegram", "Signal", "Discord"];

const str = { type: "string" };
const actInput = {
  type: "object", required: ["app", "action"],
  properties: {
    app: { type: "string", description: "App name or bundle id: Clock, Notes, Reminders, Weather." },
    action: { type: "string", description: "One of the app's actions, as apps.list and errors name them." },
    args: { type: "object", description: "The action's arguments." },
  },
};

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const opts = (ctx.config && ctx.config.apps) || {};
    const env = makeEnv({ config: opts, call: (tool, input) => ctx.call(tool, input) });
    const registry = adapters(Array.isArray(opts.adapters) ? opts.adapters : []);
    const apps = installed({ dirs: Array.isArray(opts.dirs) ? opts.dirs : DEFAULT_DIRS, now: env.now, exec: env.exec });
    /** @type {Map<string, { at: number, targets: any[] }>} */
    const targetCache = new Map();

    /** An adapter's targets for a query, cached for a minute, expiring on read. */
    const targetsOf = async (/** @type {any} */ a, /** @type {string} */ q) => {
      const key = `${a.id}\u0000${q}`;
      const hit = targetCache.get(key);
      if (hit && env.now() - hit.at <= TARGETS_TTL_MS) return hit.targets;
      const targets = await a.targets(q, env);
      // Expired entries go on write, so a stream of different queries cannot grow the map.
      const now = env.now();
      for (const [k, v] of targetCache) if (now - v.at > TARGETS_TTL_MS) targetCache.delete(k);
      targetCache.set(key, { at: now, targets });
      return targets;
    };

    /** The adapter and action a call names, or a coded refusal in words. */
    const resolve = (/** @type {string} */ app, /** @type {string} */ action) => {
      const a = registry.find(app);
      if (!a) throw new AppsError("not_found", `Vyre cannot drive ${app} yet; it can drive ${registry.all.map(x => x.app).join(", ")}`);
      const act = Object.prototype.hasOwnProperty.call(a.actions, action) ? a.actions[action] : null;
      if (!act) throw new AppsError("not_found", `${a.app} has no action ${action}; it can do ${Object.keys(a.actions).join(", ")}`);
      return { a, act };
    };

    /**
     * Check the action's own schema, then run it. An action that worked may have changed what
     * the app's targets are (a new note, a new list), so that app's cached targets go.
     */
    const run = async (/** @type {any} */ a, /** @type {any} */ act, /** @type {any} */ args) => {
      const problems = checkInput(act.input, args, "args");
      if (problems.length) throw new AppsError("bad_input", problems.join("; "));
      const out = await act.run(args, env);
      for (const k of targetCache.keys()) if (k.startsWith(`${a.id}\u0000`)) targetCache.delete(k);
      return out;
    };

    ctx.tool("apps.list", {
      description: "Apps installed on this Mac: name, bundle id, path, and tier (how Vyre reaches it: connector, intents, script, or ax for its UI); actions and nests (has things inside to pick) when Vyre has words for the app. Filter with q; names that start with q come first.",
      input: { type: "object", properties: { q: str, limit: { type: "integer", description: `Most rows, default 20, at most ${LIST_MAX}.` } } },
      async run({ q = "", limit = 20 }) {
        const rows = await apps.find({ q, limit: Math.min(LIST_MAX, Math.max(1, limit)) });
        return {
          apps: rows.map(r => {
            const a = registry.find(r.name) || registry.find(r.bundleId);
            // What Vyre can do in it, for a picker: its actions, and whether it holds people or
            // notes to pick (nests). Absent for an app Vyre has no adapter for yet.
            return { name: r.name, bundleId: r.bundleId, path: r.path, tier: a ? a.tier : "ax",
              ...(a ? { actions: Object.keys(a.actions), nests: typeof a.targets === "function" } : {}) };
          }),
        };
      },
    });

    ctx.tool("apps.targets", {
      description: "Things inside one app a person can pick: notes in Notes, lists in Reminders. Each has an id to pass back in args. Empty for an app with none.",
      input: { type: "object", required: ["app"], properties: { app: str, q: str, limit: { type: "integer", description: "Most rows, default 20." } } },
      async run({ app, q = "", limit = 20 }) {
        const a = registry.find(app);
        if (!a || typeof a.targets !== "function") return { targets: [] };
        return { targets: (await targetsOf(a, q)).slice(0, Math.max(1, limit)) };
      },
    });

    /**
     * A model's answer, made safe to hand on: it must name an app and an action, and whether the
     * action sends comes from the adapter, never from the model. An app with no adapter yet is
     * treated as sending, so it can only ever reach apps.send and its proof.
     */
    const fromModel = (/** @type {any} */ m) => {
      if (!m || typeof m !== "object" || typeof m.app !== "string" || typeof m.action !== "string") return null;
      const args = m.args && typeof m.args === "object" && !Array.isArray(m.args) ? m.args : {};
      const a = registry.find(m.app);
      const act = a && Object.prototype.hasOwnProperty.call(a.actions, m.action) ? a.actions[m.action] : null;
      const app = a ? a.app : m.app;
      const sends = act ? act.sends : true;
      // The line a person approves is built here from the args, never taken from the model: a
      // model could otherwise show "Timer for 5 minutes" over a message to someone else.
      const said = sends && typeof args.to === "string" && typeof args.text === "string" ? `${app} → ${args.to}: ${args.text}` : `${app} ${m.action}`;
      return { app, action: m.action, args, sends, said, via: "model" };
    };

    /**
     * The messaging apps to offer when words do not say which: the ones Vyre can send through
     * first, then the usual ones this Mac has installed.
     */
    const messagingApps = async () => {
      /** @type {{ name: string, bundleId?: string, hint?: string }[]} */
      const out = [];
      const seen = new Set();
      for (const a of registry.all) {
        if (!Object.values(a.actions).some(x => x.sends)) continue;
        seen.add(a.app.toLowerCase());
        out.push({ name: a.app, ...(a.bundleIds[0] ? { bundleId: a.bundleIds[0] } : {}), hint: "Vyre sends through it" });
      }
      let rows = [];
      try { rows = await apps.find({ limit: 100 }); } catch {}
      for (const name of MESSAGING) {
        const row = rows.find(r => r.name.toLowerCase() === name.toLowerCase());
        if (!row || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push({ name: row.name, ...(row.bundleId ? { bundleId: row.bundleId } : {}), hint: "installed; Vyre cannot send through it yet" });
      }
      return out;
    };

    /**
     * The people in an app who match a typed name, best first, and a "Did you mean" line when one
     * of them is the only strong match. None when the app has no people Vyre can list.
     */
    const recipients = async (/** @type {string} */ appName, /** @type {string} */ typed) => {
      const a = registry.find(appName);
      if (!a || typeof a.targets !== "function" || !typed) return { list: [], didYouMean: null };
      let all = [];
      try { all = await targetsOf(a, ""); } catch { return { list: [], didYouMean: null }; }
      const list = rankTargets(typed, all).map(t => ({ id: t.id, title: t.title, app: a.app, score: t.score }));
      const strong = list.filter(t => t.score >= STRONG);
      return { list, didYouMean: strong.length === 1 ? `Did you mean ${strong[0].title} on ${a.app}?` : null };
    };

    /** A route that asks: fill in the candidates it asks between. */
    const fillNeeds = async (/** @type {any} */ r) => {
      if (r.needs.app) return { ...r, needs: { app: await messagingApps() } };
      const { firstWordIsTo, ...q } = r;
      const { list, didYouMean } = await recipients(r.app, r.to || "");
      // "whatsapp juno running late": when juno is someone in the app, the message is the rest;
      // when no one is, the first word was the message's own and nothing is known about who.
      if (firstWordIsTo) {
        if (list.length) q.text = q.text.trim().replace(/^\S+\s*/, "") || q.text;
        else delete q.to;
      }
      return { ...q, needs: { recipient: list }, ...(didYouMean ? { didYouMean } : {}) };
    };

    /**
     * A send to someone the app does not know by that name becomes a question, not a guess. An app
     * with no people to list (no adapter yet) passes the name on as written.
     */
    const checkRecipient = async (/** @type {any} */ r) => {
      const a = registry.find(r.app);
      if (!a || typeof a.targets !== "function") return r;
      let all;
      try { all = await targetsOf(a, ""); } catch { return r; }
      const to = String(r.args.to || "").toLowerCase();
      // An id is one person. A name is one person only when no one else in the app has it: two
      // people called Alex are asked about, never sent to whichever the app finds first.
      const byId = all.find((/** @type {any} */ t) => t.id.toLowerCase() === to);
      if (byId) return { ...r, said: `${a.app} → ${byId.title}: ${r.args.text}` };
      const named = all.filter((/** @type {any} */ t) => t.title.toLowerCase() === to);
      if (named.length === 1) return r;
      if (named.length > 1) {
        return { ambiguous: true, reason: `${a.app} has ${named.length} people called ${r.args.to}`, ask: "Which one?", text: r.args.text, app: r.app, action: r.action, to: r.args.to,
          needs: { recipient: named.map((/** @type {any} */ t) => ({ id: t.id, title: t.title, app: a.app, score: 1 })) } };
      }
      const { list, didYouMean } = await recipients(r.app, r.args.to);
      return { ambiguous: true, reason: `${a.app} has no one called ${r.args.to}`, needs: { recipient: list }, ask: "Who should get this?",
        text: r.args.text, app: r.app, action: r.action, to: r.args.to, ...(didYouMean ? { didYouMean } : {}) };
    };

    /**
     * The time in a route, read by the planner's parser (planner.parse, ADR 0025): our rules say
     * which app and kind, the planner says when. Its "cannot place that" is the answer, so the
     * person is asked rather than given a guess. With no planner on this Vyre (the tool is missing
     * or fails), our own reading stands.
     */
    const parsed = async (/** @type {string} */ text, /** @type {any} */ o, /** @type {any} */ r) => {
      if (r.needs || r.sends) return r;
      if (r.ambiguous) {
        // Words our rules could not place may still be the planner's ("alarm 6pm every weekday"):
        // when it reads them as an item, the item is the route. Not inside an app's scope, and not
        // for the Mac's own apps, which cannot keep what our rules could not.
        if (o.app || o.planner === "apple" || appleAsked(text)) return r;
        let p;
        try { p = await ctx.call("planner.parse", { text }); } catch { return r; }
        const d = p && !p.error ? p.data : null;
        if (!d || typeof d !== "object" || d.ambiguous || typeof d.kind !== "string") return r;
        return withParsed({ app: "Planner", action: "add", args: { text: String(text).trim(), kind: d.kind }, sends: false, said: "" }, d, o);
      }
      const kind = timeKind(r);
      if (!kind) return r;
      // The words without "in Apple Clock": the planner reads time, not which app.
      const words = r.app === "Planner" ? String(r.args.text) : (appleAsked(text) || { text }).text;
      let p;
      try { p = await ctx.call("planner.parse", { text: words, kind }); } catch { return r; }
      if (!p || p.error || !p.data || typeof p.data !== "object") return r;
      if (p.data.ambiguous) return { ambiguous: true, reason: String(p.data.reason || "the planner could not place that time") };
      return withParsed(r, p.data, o);
    };

    /**
     * An answer to a question: the app and who as picked (an id from the candidates, or a name
     * typed), and the words kept from it. An app Vyre cannot send through, or a name that is not
     * one, is asked about again; who is checked against the app's people like any send.
     */
    const answer = async (/** @type {string} */ text, /** @type {string | undefined} */ app, /** @type {string} */ to) => {
      const again = async (/** @type {string} */ reason) => ({ ambiguous: true, reason, needs: { app: await messagingApps() }, ask: "Which app?", text, action: "send", to });
      if (!app) return again("which app should this go through?");
      const offered = (await messagingApps()).filter(x => x.hint === "Vyre sends through it").map(x => ({ id: x.name, title: x.name }));
      const best = rankTargets(app, offered)[0];
      const a = registry.find(best ? best.id : app);
      if (!a || !Object.values(a.actions).some(x => x.sends)) return again(`Vyre cannot send through ${app} yet`);
      // A candidate's id may not look like a name (WhatsApp's have an @), so an id is looked up first.
      let all = [];
      if (typeof a.targets === "function") { try { all = await targetsOf(a, ""); } catch {} }
      const hit = all.find((/** @type {any} */ t) => t.id === to);
      if (hit) return { app: a.app, action: "send", args: { to: hit.id, text }, sends: true, said: `${a.app} → ${hit.title}: ${text}` };
      const r = /** @type {any} */ (sendTo(a.app, to, text));
      return r.needs ? fillNeeds(r) : !r.ambiguous && r.sends ? checkRecipient(r) : r;
    };

    ctx.tool("apps.route", {
      description: "Turn a person's words into one app action without running it: {app, action, args, sends, said}, or {ambiguous, reason}. \"timer 10 min\", \"remind me to call juno at 6\", \"weather tomorrow\", \"whatsapp juno: running late\". Timers, alarms, reminders, todos and notes go to the Planner unless the words ask for the Mac's app. When a message's app or recipient is unclear the answer asks instead: {needs: {app: [candidates]} or {recipient: [candidates]}, ask, text (kept as typed), app?, action?, didYouMean?}; send it on once a person picks, as {text, app, to}. app scopes the words to one app (the Capsule's @App). model: true lets a small model try what the rules cannot place, when one is configured.",
      input: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 2000 }, app: str, to: str, model: { type: "boolean" } } },
      async run({ text, app, to, model = false }) {
        // An answer to a question: the app and who, as picked, and the words kept from it.
        if (to) return answer(text, app, to);
        const o = { now: env.now(), timeZone: env.timeZone, planner: opts.planner === "apple" ? "apple" : "planner", ...(app ? { app } : {}) };
        const r = /** @type {any} */ (await parsed(text, o, route(text, o)));
        if (r.needs) return fillNeeds(r);
        if (!r.ambiguous && r.sends) return checkRecipient(r);
        if (!("ambiguous" in r) || !model || typeof opts.model !== "function") return r;
        // The seam for a lean model call (config apps.model): only for what the rules left
        // ambiguous, only when the caller asked. It gets the words and what each app can do.
        const catalog = registry.all.map(x => ({ app: x.app, actions: Object.entries(x.actions).map(([name, v]) => ({ name, title: v.title, sends: v.sends, input: v.input })) }));
        let m = null;
        try { m = fromModel(await opts.model(text, catalog)); } catch {}
        return m || r;
      },
    });

    ctx.tool("apps.setup", {
      description: "An app's one-time setup, run when a person first asks for something that needs it. For Clock: writes Vyre's Timer and Alarm shortcuts, signs them and opens each in Shortcuts, where one click adds it. Returns steps (plain words to show) and files. ready: true when there is nothing to do.",
      input: { type: "object", required: ["app"], properties: { app: str } },
      // Only the surfaces a person drives: it signs files and opens import windows, which a
      // model or another module has no business doing on its own. The Deck (and the phone's
      // installed Deck) calls as "deck", and the Registry lets "deck" admit the box owner's own
      // devices over the tailnet (tailnet:<owner>), never a guest or an agent's node.
      callers: ["cli", "capsule", "deck"],
      async run({ app }) {
        const a = registry.find(app);
        const fn = a ? setupFor(a.id) : null;
        if (!a || !fn) throw new AppsError("not_supported", `${a ? a.app : app} needs no setup`);
        // Kept under the Vyre home, beside everything else Vyre wrote, never in Downloads.
        const root = opts.setupDir || path.join((ctx.paths && ctx.paths.root) || vyreConfig.home(), "apps", "shortcuts");
        return fn(env, root);
      },
    });

    ctx.tool("apps.act", {
      description: "Do one thing in an app that sends nothing as the person: a Clock timer or alarm, a note, a reminder, the weather. Returns said, one line to show, and the action's data. An action that sends, posts or pays is refused here with code sends: use apps.send.",
      input: actInput,
      async run({ app, action, args = {} }) {
        const { a, act } = resolve(app, action);
        if (act.sends) throw new AppsError("sends", `${a.app} ${action} sends as you, so it goes through apps.send, with a person's proof`);
        const out = await run(a, act, args);
        ctx.events.emit("apps.acted", { app: a.app, action });
        return out;
      },
    });

    ctx.tool("apps.send", {
      description: "Do one thing in an app that sends, posts or pays as the person. Every call needs a person's proof, shown the preview (\"WhatsApp → juno: running late\"). Returns said and the action's data.",
      input: actInput,
      presence: {
        // Every send may ride a session; the floor's SESSIONABLE list is what allows it at all.
        session: () => true,
        summary: async (/** @type {any} */ input) => {
          const a = registry.find(input && input.app);
          const act = a && Object.prototype.hasOwnProperty.call(a.actions, input.action) ? a.actions[input.action] : null;
          if (act && typeof act.preview === "function") {
            try { const p = await act.preview(input.args || {}, env); if (p) return p; } catch {}
          }
          return `${a ? a.app : input && input.app} ${input && input.action}`;
        },
      },
      async run({ app, action, args = {} }) {
        const { a, act } = resolve(app, action);
        if (!act.sends) throw new AppsError("not_sends", `${a.app} ${action} sends nothing; use apps.act`);
        const out = await run(a, act, args);
        ctx.events.emit("apps.sent", { app: a.app, action });
        return out;
      },
    });

    return {
      /** How many target lists are cached; the tests read it through the Registry's handle. */
      cachedTargets: () => targetCache.size,
      async stop() {
        apps.clear();
        targetCache.clear();
      },
    };
  },
};
