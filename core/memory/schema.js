// @ts-check
// Memory's tables. The curator is the only writer; everything else reads through the tools.
//
// Two layers. The observation layer (memory_obs, memory_cues) is what extraction found in each
// turn, kept per (session, seq) so a new turn costs one extraction and a rewritten transcript
// costs dropping one session's rows. The graph layer (nodes, edges, evidence, short forms) is
// derived from the observations on every pass, so it can never drift from them.

export const MIGRATIONS = [
  `
  -- What extraction found in one turn. node is a stable id ("name:Dana Reyes",
  -- "email:dana@harlowlegal.com"); whether a name is a person or an organisation is decided
  -- later, over the whole corpus, so it is not part of the id.
  CREATE TABLE memory_obs (
    session TEXT NOT NULL, seq INTEGER NOT NULL, node TEXT NOT NULL,
    n INTEGER NOT NULL,              -- times in this turn
    initial INTEGER NOT NULL,        -- 1 when every occurrence began a sentence
    ts INTEGER NOT NULL DEFAULT 0,   -- the turn's own time
    PRIMARY KEY (session, seq, node)
  ) WITHOUT ROWID;
  CREATE INDEX memory_obs_node ON memory_obs (node);

  -- Phrasings that say how two things relate, as written: "Dana Reyes (dana@...)" is email_of,
  -- "Sam Okafor at Northwind Bakery" is works_at.
  CREATE TABLE memory_cues (
    session TEXT NOT NULL, seq INTEGER NOT NULL, rel TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL,
    ts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session, seq, rel, a, b)
  ) WITHOUT ROWID;

  -- How far each session has been read: every seq below upto is in memory_obs.
  CREATE TABLE memory_curated (session TEXT PRIMARY KEY, upto INTEGER NOT NULL, at INTEGER NOT NULL);

  CREATE TABLE memory_nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,              -- person | org | name | email | domain | repo
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    role TEXT,                       -- own | tool | mail | hub | NULL (an outside party: a client, their people)
    sessions INTEGER NOT NULL DEFAULT 0,   -- distinct sessions, subagents folded onto their parent
    mentions INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER, last_seen INTEGER
  );

  -- valid_from is NOT NULL, with 0 meaning "atemporal: true for as long as we have known".
  -- SQLite's UNIQUE treats every NULL as distinct, so in the prototype a NULL here meant
  -- ON CONFLICT never fired and every pass appended a second copy of each edge (25,127 edges
  -- became 38,013 on one re-run). The constraint makes that mistake impossible to write.
  CREATE TABLE memory_edges (
    id INTEGER PRIMARY KEY,
    src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1,
    valid_from INTEGER NOT NULL DEFAULT 0,  -- when it became true, on the sessions' clock
    valid_to INTEGER,                       -- when it stopped; NULL while it holds
    observed INTEGER NOT NULL,              -- when the curator last confirmed it
    confidence REAL NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX memory_edges_key ON memory_edges (src, rel, dst, valid_from);
  CREATE INDEX memory_edges_dst ON memory_edges (dst, rel);

  -- The turns behind each edge. A fact nobody can trace is not kept: an edge whose evidence
  -- is gone is deleted on the next pass.
  CREATE TABLE memory_evidence (
    edge INTEGER NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL,
    PRIMARY KEY (edge, session, seq)
  ) WITHOUT ROWID;
  CREATE INDEX memory_evidence_session ON memory_evidence (session);

  -- Short forms the curator learned, with the precision it measured: the share of sessions
  -- saying the form that are about the thing. "Harlow" for Harlow Legal is safe; a common
  -- given name for a firm that shares it is not, and only measuring tells them apart.
  CREATE TABLE memory_shortforms (
    node TEXT NOT NULL, form TEXT NOT NULL, precision REAL NOT NULL, sessions INTEGER NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (node, form)
  );

  -- Steering. A weight on a node, never prose in a prompt. scope is '*' or a project folder.
  CREATE TABLE memory_focus (
    node TEXT NOT NULL, scope TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('pin','mute')),
    at INTEGER NOT NULL, who TEXT,
    PRIMARY KEY (node, scope)
  );

  CREATE TABLE memory_runs (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, sessions INTEGER NOT NULL, turns INTEGER NOT NULL,
    nodes INTEGER NOT NULL, edges INTEGER NOT NULL, ms INTEGER NOT NULL
  );
  `,
  `
  -- Facts other modules taught through ctx.memory.teach. fact is the checked fact as JSON, in a
  -- fixed key order, so teaching the same thing twice is the same row. at is when it was first
  -- taught (or last changed); it never moves on an identical re-teach.
  CREATE TABLE memory_taught (
    module TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, fact TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (module, kind, key)
  );

  -- The lessons behind each edge: memory_evidence's counterpart for taught facts, with
  -- {module, kind, key} where a transcript fact has (session, seq).
  CREATE TABLE memory_lessons (
    edge INTEGER NOT NULL, module TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
    PRIMARY KEY (edge, module, kind, key)
  ) WITHOUT ROWID;
  `,
  `
  -- Small durable values. graph_version goes up by one whenever the graph a surface would draw
  -- changes (a derive that wrote something, a pin, a mute), so the Deck can poll with it as a
  -- cursor and survive a restart of vyred.
  CREATE TABLE memory_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
  INSERT INTO memory_meta (k, v) VALUES ('graph_version', 0);
  `,
  `
  -- Rooms (docs/adr/0007-intelligence.md, decision 1). A room is a project (its folders and the
  -- threads picked into it) or 'unfiled'. Every derived row says which room it belongs to; '*'
  -- is the main graph. A room's rows are computed from its own sessions and lessons only.
  CREATE TABLE memory_rooms (
    slug TEXT PRIMARY KEY, name TEXT NOT NULL,
    folders TEXT NOT NULL,           -- JSON list of folders
    threads TEXT NOT NULL            -- JSON list of picked session ids
  );

  -- What one room knows of a node: this room's kind, role, counts and dates, never another's.
  CREATE TABLE memory_room_nodes (
    room TEXT NOT NULL, id TEXT NOT NULL,
    kind TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, role TEXT,
    sessions INTEGER NOT NULL DEFAULT 0, mentions INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER, last_seen INTEGER,
    PRIMARY KEY (room, id)
  ) WITHOUT ROWID;

  -- Edges gain their room, the newest supporting turn over all evidence (seen, for decay at read
  -- time), a conflict mark, where the belief came from (extract, taught, user) and the rule that
  -- produced it (for counting corrections per rule).
  ALTER TABLE memory_edges ADD COLUMN room TEXT NOT NULL DEFAULT '*';
  ALTER TABLE memory_edges ADD COLUMN seen INTEGER;
  ALTER TABLE memory_edges ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE memory_edges ADD COLUMN origin TEXT NOT NULL DEFAULT 'extract';
  ALTER TABLE memory_edges ADD COLUMN rule TEXT;
  DROP INDEX memory_edges_key;
  CREATE UNIQUE INDEX memory_edges_key ON memory_edges (room, src, rel, dst, valid_from);
  CREATE INDEX memory_edges_room ON memory_edges (room, src, rel);

  -- Short forms per room: every claimant is kept, and the one in view wins at read time.
  DROP TABLE memory_shortforms;
  CREATE TABLE memory_shortforms (
    room TEXT NOT NULL, node TEXT NOT NULL, form TEXT NOT NULL, precision REAL NOT NULL, sessions INTEGER NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (room, node, form)
  );

  -- What the user said about a fact (decision 4): wrong, ended, replace, confirm, add, and the
  -- merge and split of nodes. Applied in derive after the votes, so they are never derived away.
  -- scope is '*' or a room's slug. undone is set by memory.uncorrect; the row stays for history.
  CREATE TABLE memory_corrections (
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    src TEXT NOT NULL, rel TEXT, dst TEXT,
    object TEXT,                     -- replace: the new object's node id
    at INTEGER,                      -- ended, replace: when it stopped being true
    scope TEXT NOT NULL DEFAULT '*',
    note TEXT, who TEXT,
    created INTEGER NOT NULL,
    undone INTEGER
  );

  -- Every existing home derives once more, so its rows get rooms.
  INSERT INTO memory_meta (k, v) VALUES ('rederive', 1);
  `,
  `
  -- Extraction learned titles, clients, deadlines and middle initials, and reads user turns
  -- apart from Claude's. Turns already read have none of that, so every home reads them again
  -- once, in the background, the way a first pass does.
  INSERT INTO memory_meta (k, v) VALUES ('reread', 1);
  `,
  `
  -- One organisation written several ways ("Keel & Ash", "Keel & Ash Architects") is one node
  -- when the spellings share a domain: the longest spelling names it and the others are kept
  -- here, per room, so a prompt that uses them still finds it.
  CREATE TABLE memory_aliases (
    room TEXT NOT NULL, node TEXT NOT NULL, alias TEXT NOT NULL,
    PRIMARY KEY (room, node, alias)
  ) WITHOUT ROWID;
  CREATE INDEX memory_aliases_alias ON memory_aliases (room, alias);
  INSERT OR REPLACE INTO memory_meta (k, v) VALUES ('rederive', 1);
  `,
  `
  -- Personal facts (docs/work/memory-iq.md): what the user's own turns say about them and the
  -- people and things in their life. Claims are per turn; everything below them is derived.
  CREATE TABLE memory_me_claims (
    session TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL DEFAULT 0,
    subj TEXT NOT NULL, rel TEXT NOT NULL, obj TEXT NOT NULL,
    conf REAL NOT NULL, method TEXT NOT NULL,   -- rule | indirect | assistant | model
    PRIMARY KEY (session, seq, subj, rel, obj)
  ) WITHOUT ROWID;
  -- How far each session has been read, and who "she" meant at that point (JSON), so a session
  -- that grows by one turn carries its focus into it.
  CREATE TABLE memory_me_cursor (session TEXT PRIMARY KEY, upto INTEGER NOT NULL, at INTEGER NOT NULL, focus TEXT);
  CREATE TABLE memory_me_entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, first_seen INTEGER, last_seen INTEGER);
  CREATE TABLE memory_me_aliases (alias TEXT NOT NULL, entity TEXT NOT NULL, PRIMARY KEY (alias, entity)) WITHOUT ROWID;
  CREATE TABLE memory_me_facts (
    id TEXT PRIMARY KEY, subj TEXT NOT NULL, rel TEXT NOT NULL, obj TEXT NOT NULL, obj_label TEXT NOT NULL,
    confidence REAL NOT NULL, first_seen INTEGER, last_seen INTEGER,
    mentions INTEGER NOT NULL, sessions INTEGER NOT NULL, current INTEGER NOT NULL
  );
  CREATE INDEX memory_me_facts_subj ON memory_me_facts (subj, rel);
  CREATE INDEX memory_me_facts_obj ON memory_me_facts (obj);
  CREATE TABLE memory_me_evidence (fact TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (fact, session, seq)) WITHOUT ROWID;
  -- The model pass's spend per day, for its daily cap.
  CREATE TABLE memory_me_budget (day TEXT PRIMARY KEY, usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0);
  -- Sentences with a personal cue that no rule understood: the model pass's candidates.
  CREATE TABLE memory_me_cues (session TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, PRIMARY KEY (session, seq, text)) WITHOUT ROWID;
  `,
  // The model pass (personal/model.js): its runs, and the cues it has read, kept apart from the cues so a full re-read never pays for them twice.
  `CREATE TABLE memory_me_model (id INTEGER PRIMARY KEY, thread TEXT, started INTEGER NOT NULL, finished INTEGER, status TEXT NOT NULL, cues TEXT NOT NULL, facts INTEGER NOT NULL DEFAULT 0, result TEXT); CREATE TABLE memory_me_cues_done (session TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, how TEXT NOT NULL, PRIMARY KEY (session, seq, text)) WITHOUT ROWID;`,
  // What the person or their assistant told memory outright (memory.remember): read as session told:<id>.
  `CREATE TABLE memory_me_told (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, text TEXT NOT NULL, room TEXT, who TEXT);`,
  // The reader (personal/reader.js): user turns waiting for the fast model, and what it said about
  // each text, kept by hash so no turn is paid for twice.
  `CREATE TABLE memory_me_queue (session TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL, pri INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (session, seq)) WITHOUT ROWID;
  CREATE INDEX memory_me_queue_hash ON memory_me_queue (hash);
  CREATE TABLE memory_me_reads (hash TEXT PRIMARY KEY, v INTEGER NOT NULL, at INTEGER NOT NULL, facts TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0) WITHOUT ROWID;`,
  // Source trust (personal/trust.js, ADR 0034): which sessions may teach personal facts. Claude's
  // words no longer do, and every session is read again under the new rules.
  `CREATE TABLE memory_me_trust (session TEXT PRIMARY KEY, ok INTEGER NOT NULL, why TEXT, dev INTEGER NOT NULL DEFAULT 0, v INTEGER NOT NULL) WITHOUT ROWID;
  DELETE FROM memory_me_claims WHERE method NOT IN ('model', 'told');
  DELETE FROM memory_me_cues; DELETE FROM memory_me_cursor;`,
  // Vyre Memory (core/memory/iq/ask.js): the model's reply to each exact answer prompt, kept by its
  // hash, so a question over the same passages is answered the same way and never paid twice.
  `CREATE TABLE memory_iq_asks (hash TEXT PRIMARY KEY, v INTEGER NOT NULL, at INTEGER NOT NULL, reply TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0) WITHOUT ROWID;`,
  // Correcting IQ where it appears (core/memory/iq/fix.js): the answers given, by id, the person's
  // fixes (their local log: never exported), and the personal facts a fix says are not true.
  `CREATE TABLE memory_iq_answers (id TEXT PRIMARY KEY, at INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, via TEXT, facts TEXT NOT NULL, turns TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE memory_iq_fixes (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, answer TEXT NOT NULL, qkey TEXT NOT NULL, question TEXT NOT NULL, kind TEXT NOT NULL,
    action TEXT NOT NULL, old TEXT NOT NULL, text TEXT, facts TEXT NOT NULL, turns TEXT NOT NULL, who TEXT, told INTEGER, undone INTEGER);
  CREATE INDEX memory_iq_fixes_qkey ON memory_iq_fixes (qkey);
  CREATE TABLE memory_me_denied (fact TEXT NOT NULL, fix INTEGER NOT NULL, PRIMARY KEY (fact, fix)) WITHOUT ROWID;`,
  // An agent's correction with no words of the person's behind it (core/memory/iq/heard.js): kept
  // for the person to accept or dismiss in "waiting on you", never applied.
  `CREATE TABLE memory_iq_suggested (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, caller TEXT NOT NULL, thread TEXT, seq INTEGER, input TEXT NOT NULL, why TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open', settled INTEGER, target TEXT, seen INTEGER NOT NULL DEFAULT 1);
  -- The person's turns an agent's correction was applied from: one each, and a cap per thread.
  CREATE TABLE memory_iq_heard (thread TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, caller TEXT NOT NULL, kind TEXT NOT NULL, ref INTEGER NOT NULL, summary TEXT NOT NULL,
    PRIMARY KEY (thread, seq)) WITHOUT ROWID;`,
  // Index tweaks (cheap win, no new tables): three hot lookups were full table scans.
  //   - reader.once() runs "SELECT MAX(started) FROM memory_me_model" on every pump.
  //   - "waiting on you" (heard.js / suggest) filters memory_iq_suggested by state, and by thread.
  //   - stats.iq's "since" query scans memory_iq_fixes WHERE at >= ?.
  `CREATE INDEX memory_me_model_started ON memory_me_model (started);
  CREATE INDEX memory_iq_suggested_state ON memory_iq_suggested (state, thread);
  CREATE INDEX memory_iq_fixes_at ON memory_iq_fixes (at);`,
  // Agent, module and watcher writes (core/memory/write.js, plan 3.4): live the moment they land,
  // attributed from the caller (never the input), read back only as quoted text. One row per
  // item, linked into each project it was filed to; "you" is the person's own room. A row is
  // forgotten when its last link is; nothing is deleted, so every forget can be undone.
  `CREATE TABLE memory_writes (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('fact','note','decision','correction')), text TEXT NOT NULL, subject TEXT, source_ref TEXT,
    from_kind TEXT NOT NULL CHECK (from_kind IN ('person','agent','teammate','assistant','module','watcher','duty')), from_name TEXT NOT NULL, provider TEXT, thread TEXT, seq INTEGER,
    untrusted INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live','corrected','forgotten')), at INTEGER NOT NULL, updated INTEGER NOT NULL) WITHOUT ROWID;
  CREATE INDEX memory_writes_ref ON memory_writes (source_ref, from_kind, from_name);
  CREATE INDEX memory_writes_at ON memory_writes (at);
  CREATE TABLE memory_write_links (write TEXT NOT NULL, project TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live','forgotten')), at INTEGER NOT NULL,
    PRIMARY KEY (write, project)) WITHOUT ROWID;
  CREATE INDEX memory_write_links_project ON memory_write_links (project, state);`,
  // Decisions the person made in their own typed turns (core/memory/decisions.js, plan 3.5): one row
  // per decision, read once per turn (the cursor holds the reader's version). State (current,
  // replaced, reverted) is worked out on read, so a forget or a later decision is never stale.
  `CREATE TABLE memory_decisions (id TEXT PRIMARY KEY, session TEXT NOT NULL, seq INTEGER NOT NULL, project TEXT NOT NULL, cwd TEXT NOT NULL, topic TEXT NOT NULL, label TEXT NOT NULL,
    value TEXT NOT NULL, display TEXT NOT NULL, statement TEXT NOT NULL, revert INTEGER NOT NULL DEFAULT 0, decided_at INTEGER NOT NULL) WITHOUT ROWID;
  CREATE INDEX memory_decisions_project ON memory_decisions (project, topic, decided_at);
  CREATE INDEX memory_decisions_session ON memory_decisions (session);
  CREATE TABLE memory_decisions_cursor (session TEXT PRIMARY KEY, upto INTEGER NOT NULL, v INTEGER NOT NULL) WITHOUT ROWID;`,
  // One corrections listing with its source (plan 3.1E): capsule, chat:<thread> or reader. The
  // reader's cursor per session (chatfix.js) and what a correction of an answer did to a decision
  // (a replace adds the person's decision, a wrong drops the one it says is wrong; undone with it).
  `ALTER TABLE memory_corrections ADD COLUMN source TEXT;
  ALTER TABLE memory_iq_fixes ADD COLUMN source TEXT;
  CREATE TABLE memory_chatfix_cursor (session TEXT PRIMARY KEY, upto INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE memory_decision_fixes (id INTEGER PRIMARY KEY, fix INTEGER NOT NULL, at INTEGER NOT NULL, project TEXT NOT NULL, topic TEXT NOT NULL, action TEXT NOT NULL,
    value TEXT, display TEXT, statement TEXT, source TEXT, undone INTEGER);
  CREATE INDEX memory_decision_fixes_fix ON memory_decision_fixes (fix);`,
  // What Vyre for Chrome learned about each site (lib/site-knowledge.js, team/0.2/chrome-learning-plan.md): one row per
  // origin and per family, the whole record as JSON plus the small card Chrome reads on every arrival, a bounded
  // ring of events for "what changed", and a 24-hour undo for a forgotten record. Structure only, never a value.
  `CREATE TABLE memory_site (key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('origin','family')), rev INTEGER NOT NULL, record TEXT NOT NULL, card TEXT NOT NULL, updated INTEGER NOT NULL, names TEXT NOT NULL DEFAULT '', family TEXT) WITHOUT ROWID;
  CREATE TABLE memory_site_events (id INTEGER PRIMARY KEY, key TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, item TEXT, outcome TEXT);
  CREATE INDEX memory_site_events_key ON memory_site_events (key, at);
  CREATE TABLE memory_site_forgotten (key TEXT PRIMARY KEY, record TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE memory_site_gone (key TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE memory_site_forgotten_items (key TEXT NOT NULL, part TEXT NOT NULL, id TEXT NOT NULL, item TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (key, part, id)) WITHOUT ROWID;`,
];
