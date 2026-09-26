// @ts-check
// apps: drive the Mac's apps from the Capsule, the CLI and the phone. "timer 10 min", "note: buy
// milk", "remind me to call juno at 6", "weather tomorrow".
//
// Four tools. apps.list says what is installed and how well Vyre can reach each app.
// apps.targets lists the things inside one app a person might pick (notes, reminder lists, later
// chats and channels). apps.act runs an action that sends nothing as the person. apps.send runs
// one that does (a message, a post), and declares presence, so every caller that is not a module,
// models included, needs a person's proof for each call. There is no session for it: one proof,
// one send.
//
// Starting the module costs nothing: no scan, no process, no timer. The folders are read on the
// first apps.list, and each cache expires when it is read. Every contact with the Mac goes
// through env.js, which a test builds over fakes.

import { checkInput } from "../../core/modules/index.js";
import { makeEnv, AppsError } from "./env.js";
import { adapters } from "./adapters/index.js";
import { installed, DEFAULT_DIRS } from "./installed.js";

export const TARGETS_TTL_MS = 60 * 1000;
export const LIST_MAX = 100;

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
      description: "Apps installed on this Mac: name, bundle id, path, and tier (how Vyre reaches it: connector, intents, script, or ax for its UI). Filter with q; names that start with q come first.",
      input: { type: "object", properties: { q: str, limit: { type: "integer", description: `Most rows, default 20, at most ${LIST_MAX}.` } } },
      async run({ q = "", limit = 20 }) {
        const rows = await apps.find({ q, limit: Math.min(LIST_MAX, Math.max(1, limit)) });
        return {
          apps: rows.map(r => {
            const a = registry.find(r.name) || registry.find(r.bundleId);
            return { name: r.name, bundleId: r.bundleId, path: r.path, tier: a ? a.tier : "ax" };
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
        const key = `${a.id}\u0000${q}`;
        const hit = targetCache.get(key);
        let targets;
        if (hit && env.now() - hit.at <= TARGETS_TTL_MS) targets = hit.targets;
        else {
          targets = await a.targets(q, env);
          // Expired entries go on write, so a stream of different queries cannot grow the map.
          const now = env.now();
          for (const [k, v] of targetCache) if (now - v.at > TARGETS_TTL_MS) targetCache.delete(k);
          targetCache.set(key, { at: now, targets });
        }
        return { targets: targets.slice(0, Math.max(1, limit)) };
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
