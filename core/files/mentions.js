// @ts-check
// mentions: the table a # file tag once recorded per-thread grants in. The tag now names a file in the Space's Drive and grants nothing (space-drive.js: reading stays under the
// reader's own grants), so the table is unused. A released migration is never edited or dropped (test/migrations-append-only.test.js), so the step stays.

export const MIGRATIONS = [`
  CREATE TABLE files_mention_grants (
    thread TEXT NOT NULL,
    share TEXT NOT NULL,
    path TEXT NOT NULL,         -- relative to the share, no leading slash
    real TEXT NOT NULL,         -- the file's real path when it was tagged
    said TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (thread, share, path)
  );
`];
