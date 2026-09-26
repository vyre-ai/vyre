// @ts-check
// recall — search over every turn of every Claude Code session on this machine.
//
// Full-text search (FTS5) over every user and assistant turn, re-ranked by local embeddings
// when the optional model is installed. The index is built from the transcript files by
// core/transcripts, the only code that reads them, and lives in Recall's tables
// (core/recall/schema.js), which Memory and Projects read directly.
//
// Indexing starts after vyred is up and then runs every `recall.every` minutes (default 5), in
// the background, one pass at a time. It yields between files, so vyred keeps answering while
// a first index of a large corpus is under way. Vectors are filled in after each pass, one turn
// at a time, most recent sessions first; until they exist, search is full-text and says so.
//
// Settings, all optional, under "recall" in config.json:
//   every      minutes between passes (default 5; 0 turns the timer off)
//   vectors    false to never load the model
//   download   false to never fetch the model weights (then they must already be in `models`)
//   models     where the weights live (default <VYRE_HOME>/models)

import os from "node:os";
import path from "node:path";
import { MIGRATIONS } from "./schema.js";
import { Indexer } from "./indexer.js";
import { search, thread, sessions } from "./search.js";
import { load as loadModel, cached } from "./embed.js";
import { Dense } from "./dense.js";

/** @type {import("./embed.js").Embedder | null} */
let injected = null;

/**
 * Use this embedder instead of loading the model. For tests: they must never download weights,
 * and must pass whether or not the optional package is installed.
 * @param {import("./embed.js").Embedder | null} e
 */
export function useEmbedder(e) { injected = e; }

/**
 * The transcript folders to read. Under `node --test` the real ~/.claude is never read, whatever
 * the config says: a test that starts vyred with default settings would otherwise index every
 * real conversation on the machine into its temp home. Tests point `transcripts` at fixtures.
 * @param {string[]} folders
 */
export function readable(folders) {
  if (!process.env.NODE_TEST_CONTEXT) return folders;
  const real = path.join(os.homedir(), ".claude") + path.sep;
  return folders.filter(f => !(path.resolve(f) + path.sep).startsWith(real));
}

export default {
  /** @param {any} ctx */
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const opts = ctx.config.recall || {};
    const every = opts.every ?? 5;
    const folders = readable(ctx.config.transcripts || []);
    // Every vector in memory for retrieval by meaning; dropped whenever a pass writes, rebuilt on
    // the next hybrid search.
    const dense = new Dense(db);
    const indexer = new Indexer(db, {
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
      log: ctx.log,
    });

    let stopped = false;
    const isStopped = () => stopped;

    // One pass at a time. A caller that asks while one is running gets the next pass, which
    // starts when the current one ends and skips everything that one already did.
    /** @type {Promise<any>} */
    let chain = Promise.resolve();
    let running = false;
    /** @type {any} */
    let lastError = null;
    const pass = () => {
      const p = chain.then(async () => {
        if (stopped) return null;
        running = true;
        try {
          const s = await indexer.run(folders, { stopped: isStopped });
          if (s.turns || s.reindexed) dense.invalidate();
          return s;
        }
        finally { running = false; vectorLoop(); }
      });
      chain = p.catch(e => { lastError = e.message; ctx.log(`index pass failed: ${e.message}`); });
      return p;
    };

    // Vectors: lazily loaded, and never fatal.
    const vec = {
      on: opts.vectors !== false,
      why: opts.vectors === false ? "turned off in config.json (recall.vectors)" : "not loaded yet",
      /** @type {import("./embed.js").Embedder | null} */
      embedder: null,
      /** @type {Promise<import("./embed.js").Embedder | null> | null} */
      loading: null,
      busy: false, again: false,
      /** @type {Promise<void>} */
      done: Promise.resolve(),
    };
    const embedder = () => {
      if (!vec.on) return Promise.resolve(null);
      if (vec.embedder) return Promise.resolve(vec.embedder);
      if (!vec.loading) {
        const models = opts.models || path.join(ctx.paths.root, "models");
        // The one network call Recall ever makes, once. Said out loud, so a first `vyre status`
        // explains the wait instead of looking stuck.
        vec.why = injected || cached(models) ? "loading the model" : "downloading the search model (23 MB, once)";
        vec.loading = (injected ? Promise.resolve({ embedder: injected })
          : loadModel({ cacheDir: models, download: opts.download !== false }))
          .then(r => {
            if (r.embedder) { vec.embedder = r.embedder; vec.why = `on (${r.embedder.model})`; return r.embedder; }
            vec.on = false; vec.why = r.why || "unavailable";
            ctx.log(`vectors off: ${vec.why}`);
            return null;
          });
      }
      return vec.loading;
    };
    const vectorLoop = () => {
      if (!vec.on || stopped) return;
      if (vec.busy) { vec.again = true; return; }
      vec.busy = true;
      vec.done = (async () => {
        try {
          do {
            vec.again = false;
            if (!indexer.pending().length) continue;
            const e = await embedder();
            if (!e || stopped) break;
            const r = await indexer.vectorize(e, { stopped: isStopped });
            if (r.turns) dense.invalidate();
            if (r.turns) ctx.log(`embedded ${r.turns} turns into ${r.chunks} vectors in ${r.ms}ms`);
          } while (vec.again && !stopped);
        } catch (e) { vec.why = `embedding failed: ${/** @type {Error} */ (e).message}`; ctx.log(vec.why); }
        finally { vec.busy = false; }
      })();
    };

    const stringArray = { type: "array", items: { type: "string" } };
    ctx.tool("recall.search", {
      description: "Search every Claude Code session on this machine for turns about something. Returns the best turns with their session's name, title and folder.",
      input: { type: "object", required: ["q"], properties: {
        q: { type: "string" }, limit: { type: "integer" }, project_cwds: stringArray,
        role: { type: "string", enum: ["user", "assistant"] }, hybrid: { type: "boolean" },
        per_session: { type: "integer" },
      } },
      run: async input => {
        // No model load for a corpus with no vectors yet: that would cost seconds and change nothing.
        const any = db.prepare("SELECT 1 FROM recall_vectors LIMIT 1").get();
        const e = input.hybrid === false || !any ? null : await embedder();
        return (await search(db, input, e, dense)).hits;
      },
    });
    ctx.tool("recall.thread", {
      description: "One session and its turns, in order. Takes a session id or an unambiguous prefix of one.",
      input: { type: "object", required: ["session"], properties: {
        session: { type: "string" }, from: { type: "integer" }, limit: { type: "integer" } } },
      run: async input => thread(db, input),
    });
    ctx.tool("recall.sessions", {
      description: "Indexed sessions, newest first, optionally only those in or under a folder, since a time, or started by a person.",
      input: { type: "object", properties: {
        cwd: { type: "string" }, since: { type: "number" }, human: { type: "boolean" }, limit: { type: "integer" } } },
      run: async input => sessions(db, input),
    });
    ctx.tool("recall.index", {
      description: "Index new and changed transcripts now. Returns what the pass did.",
      input: { type: "object", properties: {} },
      run: async () => pass(),
    });
    ctx.tool("recall.status", {
      description: "How much is indexed, when the last pass ran, and whether search can rank by meaning.",
      input: { type: "object", properties: {} },
      run: async () => {
        const n = sql => Number(/** @type {any} */ (db.prepare(sql).get()).n);
        const turns = n("SELECT COUNT(*) n FROM recall_turns");
        const embedded = n("SELECT COUNT(*) n FROM recall_vectors WHERE chunk = 0");
        const last = /** @type {any} */ (db.prepare("SELECT v FROM recall_meta WHERE k = 'last_index'").get());
        return {
          sessions: n("SELECT COUNT(*) n FROM recall_sessions"), turns,
          folders, every, indexing: running, last: last ? JSON.parse(String(last.v)) : null, error: lastError,
          vectors: { on: vec.on, why: vec.why, embedded, pending: Math.max(0, turns - embedded), embedding: vec.busy, dense: dense.stats() },
        };
      },
    });

    // After start returns, so vyred's startup never waits on a pass.
    const first = setTimeout(() => { pass().catch(() => {}); }, 0);
    const timer = every > 0 ? setInterval(() => { if (!running) pass().catch(() => {}); }, every * 60_000) : null;
    timer?.unref();

    return {
      async stop() {
        stopped = true;
        clearTimeout(first);
        if (timer) clearInterval(timer);
        await chain;
        await vec.done;
      },
    };
  },
};
