// @ts-check
// sight: one screen service for the user's Mac and every agent's computer (ADR 0036, part 1).
//
// Glass, the Deck, the Capsule, chat and the phone each want the same three things about a
// screen: which screens there are, what is on one now, and what was just done on it. Before this
// module each surface asked computers, hands-desktop, chrome and screen on its own, and each got
// a different shape. Here a target is "mac" (the Mac this vyred runs on) or "agent:<name>" (a
// computer in Glass), and every surface asks the same four tools.
//
// It owns nothing but a short history of steps. It reads other modules only through ctx.call, it
// learns of actions from their acted events, and it polls nothing.
//
// What never leaves here: the Mac's screen text, selection and field values go only to the person
// who asked for them, never into an event or the table; a caller that came over the tailnet gets
// nothing about the Mac (the Mac's pixels and words stay on the Mac); a URL keeps its origin and
// path, never its query or fragment; from hands.acted only the control's role is kept, never its
// name or identifier; and a blind place (the floor) stays blind in every part.

export const KEEP = 500;
const AGENT = /^[a-z][a-z0-9-]{0,40}$/;
const SUMMARY_MAX = 200;
// Who may emit each acted event. A module can only emit types its manifest declares, but two
// manifests could declare the same type; only the acting module's own account counts.
const SOURCES = { "desktop.acted": "hands-desktop", "chrome.acted": "chrome", "hands.acted": "hands" };
// Reads, not steps. sight.now's own look at an agent's controls makes chrome emit one, and "the
// agent is doing this now" must not show a person's glance as the agent's work.
const READS = new Set(["snapshot", "screenshot"]);
const CALLERS = ["cli", "local", "deck", "capsule", "module"];

/** An error with a code the registry passes through to the caller. */
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * A URL with its query and fragment gone. Not a URL at all: cut at the first ? or #.
 * @param {unknown} u @returns {string|null}
 */
export function bareUrl(u) {
  if (typeof u !== "string" || !u) return null;
  try {
    const x = new URL(u);
    if (x.protocol === "http:" || x.protocol === "https:") return x.origin + x.pathname;
    return `${x.protocol}${x.host ? "//" + x.host : ""}${x.pathname}`;
  } catch { return u.split(/[?#]/)[0]; }
}

/**
 * A summary as a step keeps it: one line, any URL in it bare, and short.
 * @param {unknown} s @returns {string}
 */
export function cleanSummary(s) {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  const bare = one.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, m => bareUrl(m) || "");
  return bare.length > SUMMARY_MAX ? bare.slice(0, SUMMARY_MAX - 3) + "..." : bare;
}

/** "mac" or "agent:<name>"; anything else is bad input. @param {unknown} t */
export function parseTarget(t) {
  const s = String(t ?? "");
  if (s === "mac") return { kind: "mac", agent: null };
  const m = /^agent:(.+)$/.exec(s);
  if (m && AGENT.test(m[1])) return { kind: "agent", agent: m[1] };
  throw fail("bad_input", `target must be "mac" or "agent:<name>", not "${s}"`);
}

/**
 * Did this call come from off the Mac? A network listener sets meta.peer (the screen module
 * refuses on the same test); the owner's devices, guests and agents' nodes arrive labelled
 * "tailnet:", "tailnet-guest:" or "device:" (core/modules/index.js ownerDevice). The screen module
 * cannot see this itself when sight asks it, because sight calls it as "module:sight".
 * @param {any} meta
 */
export const offMac = meta => Boolean(meta && (meta.peer || /^(tailnet|tailnet-guest|device):/.test(String(meta.caller || ""))));

/** A caller claiming to be an agent, in any of the forms vyred recognizes: "mcp:agent:kit", "harness:agent:kit". */
const AGENT_CLAIM = /(?:^|[\s:])agent:([A-Za-z0-9_-]*)/;

/**
 * The agent name this call's real caller claims to be, when it is not the assistant, or null.
 * sight.watch forwards to computers.watch as "module:sight" (core/modules/index.js's call
 * wrapper), so computers.js's own ownSurface floor (which refuses an ordinary agent claiming a
 * person's surface) never sees who really called; from computers' side every sight-proxied watch
 * looks like the same trusted module, whoever asked. sight still has meta.caller before that
 * relabeling happens, so it checks the same thing itself and refuses before forwarding.
 * @param {any} ctx @param {any} meta
 */
export const agentCaller = async (ctx, meta) => {
  const claim = AGENT_CLAIM.exec(String((meta && meta.caller) || ""));
  if (!claim) return null;
  const r = await ctx.call("agents.list", {});
  if (r.error) return claim[1]; // can't tell who this is: fail closed, treat it as an ordinary agent
  const a = (r.data || []).find(x => x && x.name === claim[1]);
  return a && String(a.kind) === "assistant" ? null : claim[1];
};

/**
 * One acted event as a step, or null when it is not one. Only the named fields are read, so
 * whatever else an acting module puts on its event never reaches the table.
 * @param {{ type: string, source?: string, at?: number, thread?: string|null, payload?: any }} e
 */
export function normalize(e) {
  if (!e || !(e.type in SOURCES) || (e.source !== undefined && e.source !== SOURCES[/** @type {keyof typeof SOURCES} */ (e.type)])) return null;
  const p = e.payload && typeof e.payload === "object" ? e.payload : {};
  const text = v => (typeof v === "string" && v.trim() ? v : null);
  const thread = text(p.thread) || text(p.scope && p.scope.thread) || text(e.thread);
  const call = text(p.call) || text(p.scope && p.scope.call);
  const at = Number.isFinite(e.at) ? Number(e.at) : Date.now();
  if (e.type === "hands.acted") {
    // The Mac's own hands. The selector's name and identifier can be a person's words (a
    // message subject, a contact), so only its role is kept, and the summary is made here.
    const kind = text(p.kind) || "act";
    const role = text(p.selector && p.selector.role);
    const ok = p.acted === true && p.verified === true;
    const why = ok ? null : p.held === true ? "held for the person to approve" : p.acted === true ? "done, but its effect was not seen" : "not done";
    return { target: "mac", agent: text(p.agent) && AGENT.test(p.agent) ? p.agent : null, thread, call,
      action: kind, summary: cleanSummary(`${kind} ${role || "control"}`), ok, why, app: text(p.app) ? cleanSummary(p.app) : null, at };
  }
  const agent = text(p.agent);
  if (!agent || !AGENT.test(agent)) return null;
  const action = text(p.action) || "act";
  if (e.type === "chrome.acted" && READS.has(action)) return null;
  const ok = p.ok === true;
  const app = text(p.app) ? cleanSummary(p.app) : e.type === "chrome.acted" ? "Chrome" : null;
  return { target: `agent:${agent}`, agent, thread, call, action: cleanSummary(action),
    summary: cleanSummary(p.summary), ok, why: ok ? null : (text(p.why) ? cleanSummary(p.why) : null), app, at };
}

/** A control as sight hands it on: where it is and what it is, never its value. @param {any} c */
const control = c => {
  const out = /** @type {any} */ ({});
  if (typeof c.path === "string") out.path = c.path;
  if (typeof c.role === "string") out.role = c.role;
  if (typeof c.name === "string") out.name = c.name;
  if (c.nameless === true) out.nameless = true;
  out.enabled = c.enabled !== false;
  if (c.focused === true) out.focused = true;
  const f = c.frame;
  if (f && [f.x, f.y, f.w, f.h].every(Number.isFinite)) out.frame = { x: f.x, y: f.y, w: f.w, h: f.h };
  return out;
};

/** A step row as the tools return it. @param {any} r */
const stepOf = r => ({
  target: r.target, ...(r.agent ? { agent: r.agent } : {}), ...(r.thread ? { thread: r.thread } : {}), ...(r.call ? { call: r.call } : {}),
  action: r.action, summary: r.summary, ok: Boolean(r.ok), ...(r.why ? { why: r.why } : {}), ...(r.app ? { app: r.app } : {}), at: Number(r.at),
});

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate([
      `CREATE TABLE sight_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, target TEXT NOT NULL, agent TEXT, thread TEXT, call TEXT,
         action TEXT NOT NULL, summary TEXT NOT NULL, ok INTEGER NOT NULL, why TEXT, app TEXT);
       CREATE INDEX sight_steps_target ON sight_steps (target, id);
       CREATE INDEX sight_steps_thread ON sight_steps (thread, id);`,
    ]);
    const db = ctx.store.db;
    const insert = db.prepare("INSERT INTO sight_steps (at, target, agent, thread, call, action, summary, ok, why, app) VALUES (?,?,?,?,?,?,?,?,?,?)");
    // The newest KEEP stay; everything older goes as each step lands, so the table never grows.
    const trim = db.prepare(`DELETE FROM sight_steps WHERE id <= (SELECT id FROM sight_steps ORDER BY id DESC LIMIT 1 OFFSET ${KEEP})`);
    const lastOf = db.prepare("SELECT * FROM sight_steps WHERE target = ? ORDER BY id DESC LIMIT 1");

    /** A tool's data, or null when the tool is missing or failed. */
    const ask = async (tool, input) => {
      try { const r = await ctx.call(tool, input); return r && !r.error ? r.data : null; } catch { return null; }
    };

    const record = e => {
      const s = normalize(e);
      if (!s) return;
      insert.run(s.at, s.target, s.agent, s.thread, s.call, s.action, s.summary, s.ok ? 1 : 0, s.why, s.app);
      trim.run();
      const step = stepOf(s);
      ctx.events.emit("sight.stepped", step, s.thread ? { thread: s.thread } : {});
    };
    const offs = Object.keys(SOURCES).map(type => ctx.events.on(type, e => { try { record(e); } catch (err) { ctx.log(`could not record ${type}: ${/** @type {Error} */ (err).message}`); } }));

    const last = target => { const r = lastOf.get(target); return r ? stepOf(r) : null; };

    /** Is the screen module running here? A wrong-typed input is refused before screen.context
     * runs, so this learns it is there without waking its helper or asking for a grant. */
    const hasScreen = async () => {
      try { const r = await ctx.call("screen.context", { text: "probe" }); return !(r && r.error && r.error.code === "no_such_tool"); } catch { return false; }
    };

    const macNow = async parts => {
      const withText = parts.includes("text");
      const r = await ctx.call("screen.context", withText ? { text: true } : { text: false });
      const base = { target: "mac", kind: "mac", step: last("mac") };
      if (!r || r.error) {
        if (r && r.error && r.error.code !== "no_such_tool") return { ...base, app: null, window: null, url: null, at: Date.now(), why: r.error.message };
        return { ...base, app: null, window: null, url: null, at: Date.now() };
      }
      const d = r.data || {};
      const app = d.app && typeof d.app.name === "string" ? d.app.name : null;
      const window = d.window && typeof d.window.title === "string" ? d.window.title : null;
      const at = Number.isFinite(d.at) ? d.at : Date.now();
      // The floor's places: which app and which window, why, and nothing else, whatever was asked.
      if (d.blind) return { ...base, app, window, url: null, blind: String(d.blind), at };
      const out = /** @type {any} */ ({ ...base, app, window, url: bareUrl(d.url), at });
      if (withText) {
        out.text = typeof d.text === "string" ? d.text : null;
        out.focused = d.focused || null;
        if (d.secure === true) out.secure = true;
        if (d.truncated === true) out.truncated = true;
      }
      return out;
    };

    const agentNow = async (agent, parts) => {
      const target = `agent:${agent}`;
      const view = await ask("computers.get", { agent });
      const step = last(target);
      const out = /** @type {any} */ ({ target, kind: "agent", agent, app: step && step.app ? step.app : null, window: null, url: null, step,
        holder: view && view.takeover ? view.takeover : null, at: Date.now() });
      if (parts.includes("controls")) {
        // Chrome first when the last step was in Chrome, the desktop's tree otherwise; either may
        // be missing on this machine, and then the other is tried.
        const chromeFirst = Boolean(step && step.app === "Chrome");
        const order = chromeFirst ? ["chrome", "desktop"] : ["desktop", "chrome"];
        out.controls = null;
        for (const way of order) {
          if (way === "chrome") {
            const snap = await ask("chrome.snapshot", { agent });
            if (!snap) continue;
            out.app = "Chrome";
            out.window = typeof snap.title === "string" && snap.title ? snap.title : null;
            out.url = bareUrl(snap.url);
            out.controls = (Array.isArray(snap.controls) ? snap.controls : []).map(control);
            break;
          }
          const tree = await ask("hands-desktop.tree", { agent, ...(out.app && out.app !== "Chrome" ? { app: out.app } : {}) });
          if (!tree) continue;
          if (typeof tree.app === "string" && tree.app) out.app = tree.app;
          out.controls = (Array.isArray(tree.controls) ? tree.controls : []).map(control);
          break;
        }
      }
      return out;
    };

    const partsOf = p => (Array.isArray(p) ? p.map(String) : []);

    ctx.tool("sight.targets", {
      description: "Every screen Vyre can show: \"mac\" (this Mac, when the screen module runs here) and one \"agent:<name>\" per computer. Each row says kind, label, whether it is live, and who holds its keyboard.",
      input: { type: "object", properties: {} },
      callers: CALLERS,
      run: async (_, meta) => {
        const targets = [];
        if (!offMac(meta) && (await hasScreen())) targets.push({ target: "mac", kind: "mac", label: "This Mac", live: true });
        const list = await ask("computers.list", {});
        for (const c of (list && Array.isArray(list.computers) ? list.computers : [])) {
          if (!c || typeof c.agent !== "string" || !AGENT.test(c.agent)) continue;
          targets.push({ target: `agent:${c.agent}`, kind: "agent", label: c.agent, live: c.state === "running",
            ...(c.takeover ? { holder: c.takeover } : {}) });
        }
        return { targets };
      },
    });

    ctx.tool("sight.now", {
      description: "What is on one screen now: app, window, URL (without its query), the last step and who holds the keyboard. parts [\"text\"] adds the visible text and focused control, for mac only; parts [\"controls\"] adds an agent's controls (never their values). The Mac is never read for a caller from the tailnet.",
      input: { type: "object", required: ["target"], properties: {
        target: { type: "string", description: "\"mac\" or \"agent:<name>\"" },
        parts: { type: "array", items: { type: "string", enum: ["text", "controls"] } },
      } },
      callers: CALLERS,
      run: async (i, meta) => {
        const t = parseTarget(i.target);
        const parts = partsOf(i.parts);
        if (t.kind === "mac") {
          if (offMac(meta)) throw fail("local_only", "this Mac's screen stays on this Mac and is not available over the tailnet");
          return macNow(parts);
        }
        return agentNow(/** @type {string} */ (t.agent), parts);
      },
    });

    ctx.tool("sight.watch", {
      description: "Open an agent's screen: a one-use ticket for its Glass frame stream (computers.watch). surface names the person's screen, e.g. glass:<device>. The Mac is never streamed: it answers local_only.",
      input: { type: "object", required: ["target"], properties: {
        target: { type: "string" }, surface: { type: "string" }, slow: { type: "boolean" },
      } },
      callers: CALLERS,
      run: async (i, meta) => {
        const t = parseTarget(i.target);
        if (t.kind === "mac") throw fail("local_only", "this Mac's pixels never leave this Mac");
        const claimant = await agentCaller(ctx, meta);
        if (claimant) throw fail("denied", `"${claimant}" is an agent, not a person's screen; sight.watch opens a screen for a person, not for an agent to watch itself`);
        const r = await ctx.call("computers.watch", { agent: t.agent, ...(i.surface !== undefined ? { surface: i.surface } : {}), ...(i.slow !== undefined ? { slow: i.slow } : {}) });
        if (r && r.error && r.error.code === "no_such_tool") return { target: i.target, ticket: null, why: "this machine runs no agent computers" };
        if (!r || r.error) throw fail((r && r.error && r.error.code) || "failed", (r && r.error && r.error.message) || "computers.watch failed");
        return { target: i.target, ...r.data };
      },
    });

    ctx.tool("sight.frame", {
      description: "One still of an agent's screen: a JPEG scaled to maxWidth (160-1280, default 480), base64. For a small \"what the agent is doing now\" view that refreshes on sight.stepped, never on a timer; the live view is sight.watch. Refused while a person is signing in on that computer (the shield). The Mac answers local_only.",
      input: { type: "object", required: ["target"], properties: {
        target: { type: "string" }, maxWidth: { type: "integer", minimum: 160, maximum: 1280 },
      } },
      callers: CALLERS,
      run: async i => {
        const t = parseTarget(i.target);
        if (t.kind === "mac") throw fail("local_only", "this Mac's pixels never leave this Mac");
        const maxWidth = Number.isInteger(i.maxWidth) ? i.maxWidth : 480;
        const r = await ctx.call("hands-desktop.screenshot", { agent: t.agent, format: "jpeg", maxWidth });
        if (r && r.error && r.error.code === "no_such_tool") return { target: i.target, image: null, why: "this machine runs no agent computers" };
        if (!r || r.error) throw fail((r && r.error && r.error.code) || "failed", (r && r.error && r.error.message) || "the screenshot failed");
        const last = db.prepare("SELECT * FROM sight_steps WHERE target = ? ORDER BY id DESC LIMIT 1").get(String(i.target));
        return { target: i.target, image: r.data.image, mime: r.data.mime, maxWidth, at: Date.now(), step: last ? stepOf(last) : null };
      },
    });

    ctx.tool("sight.steps", {
      description: "Recent steps on screens, newest first: action, a short summary, app, outcome, and the thread and tool call that made each. Filter by target or thread. The Mac's steps are left out for a caller from the tailnet.",
      input: { type: "object", properties: {
        target: { type: "string" }, thread: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: KEEP },
      } },
      callers: CALLERS,
      run: async (i, meta) => {
        const far = offMac(meta);
        const where = [], args = [];
        if (i.target !== undefined) {
          const t = parseTarget(i.target);
          if (t.kind === "mac" && far) throw fail("local_only", "this Mac's steps stay on this Mac and are not available over the tailnet");
          where.push("target = ?"); args.push(String(i.target));
        } else if (far) where.push("target <> 'mac'");
        if (i.thread !== undefined) { where.push("thread = ?"); args.push(String(i.thread)); }
        const limit = Math.min(KEEP, Math.max(1, Number.isInteger(i.limit) ? i.limit : 50));
        const rows = db.prepare(`SELECT * FROM sight_steps ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`).all(...args);
        return { steps: rows.map(stepOf) };
      },
    });

    return { async stop() { for (const off of offs) off(); } };
  },
};
