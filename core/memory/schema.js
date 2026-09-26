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
];
