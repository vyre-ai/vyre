// @ts-check
// Recall's tables. This file is a CONTRACT: Memory and Projects read these tables directly
// (reads may join any table; writes go through the owning module). Change a column only with a
// new migration step and a line under "Changed contracts" in docs/work/recall.md.
//
// Identity: a turn is (session, seq). seq is the turn's position in its transcript, counting
// only user and assistant turns with text, from 0. It never changes once written, because a
// grown transcript only appends turns. A rewritten transcript (compaction, a fork) is re-indexed
// from scratch and its seq values restart; anything that points at a turn (Memory's evidence)
// must treat a missing (session, seq) as gone, not as an error.
//
// The FTS rowid is NOT an identity. It is reused after a delete, which once attached vectors to
// text they were never made from. Vectors key on (session, seq, chunk) for that reason.

export const MIGRATIONS = [
  `
  CREATE TABLE recall_sessions (
    id       TEXT PRIMARY KEY,   -- the Claude Code session id, what --resume takes
    file     TEXT NOT NULL,      -- the transcript on this machine
    cwd      TEXT,               -- the real working directory, read from the transcript
    name     TEXT,               -- what /rename called it; the identifier when present
    title    TEXT,               -- the first thing the user typed, redacted, <=120 chars
    started  INTEGER,            -- ms since epoch
    ended    INTEGER,
    turns    INTEGER NOT NULL DEFAULT 0,   -- how many turns are indexed
    human    INTEGER NOT NULL DEFAULT 1,   -- 0 when a program, not a person, started it
    parent   TEXT,               -- the session a subagent ran under, when it is one
    bytes    INTEGER,            -- transcript size when last indexed
    mtime    INTEGER             -- transcript mtime when last indexed
  );
  CREATE INDEX recall_sessions_cwd ON recall_sessions (cwd);
  CREATE INDEX recall_sessions_ended ON recall_sessions (ended);

  -- Every user and assistant turn with text, redacted before it is written.
  CREATE VIRTUAL TABLE recall_turns USING fts5(
    session UNINDEXED, seq UNINDEXED, role UNINDEXED, ts UNINDEXED, text,
    tokenize='porter unicode61'
  );

  -- One row per chunk of one turn: 384 little-endian float32, unit length.
  CREATE TABLE recall_vectors (
    session TEXT NOT NULL, seq INTEGER NOT NULL, chunk INTEGER NOT NULL,
    off INTEGER NOT NULL, v BLOB NOT NULL,
    PRIMARY KEY (session, seq, chunk)
  ) WITHOUT ROWID;

  CREATE TABLE recall_meta (k TEXT PRIMARY KEY, v TEXT);
  `,
  // Which provider and model said a turn (a session is a group chat of accounts): two more UNINDEXED columns, AFTER text so that
  // snippet(recall_turns, 4, ...) still means the text. FTS5 cannot add a column, so the table is rebuilt with every row kept under
  // the same rowid (the dense index and the curator point at rowids). Every turn indexed so far came from a Claude Code transcript.
  `
  CREATE VIRTUAL TABLE recall_turns_next USING fts5(
    session UNINDEXED, seq UNINDEXED, role UNINDEXED, ts UNINDEXED, text, provider UNINDEXED, model UNINDEXED,
    tokenize='porter unicode61'
  );
  INSERT INTO recall_turns_next (rowid, session, seq, role, ts, text, provider, model)
    SELECT rowid, session, seq, role, ts, text, 'claude', NULL FROM recall_turns;
  DROP TABLE recall_turns;
  ALTER TABLE recall_turns_next RENAME TO recall_turns;
  `,
  // What a turn touched, as plain lookup keys (core/transcripts/links.js): kind is file, read, commit or url, ref the path (relative to the session's folder), the
  // short or full hash, or the url. Written by the indexer on the same pass as the turn, keyed on (session, seq) like vectors, never on the FTS rowid. A session's
  // links go when its turns do (a rewrite, a forget).
  `
  CREATE TABLE recall_links (
    session TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
    PRIMARY KEY (session, seq, kind, ref)
  ) WITHOUT ROWID;
  CREATE INDEX recall_links_ref ON recall_links (kind, ref);
  `,
];

// recall_links is the third contract table: Memory's pointer index and the memory_turn tool read it, Recall's indexer writes it.

/** @typedef {{ id: string, file: string, cwd: string|null, name: string|null, title: string|null, started: number, ended: number, turns: number, human: number, parent: string|null }} SessionRow */
/** @typedef {{ session: string, seq: number, role: "user"|"assistant", ts: number, text: string, provider: string|null, model: string|null }} TurnRow */
