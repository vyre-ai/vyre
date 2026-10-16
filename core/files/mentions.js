// @ts-check
// The files module's first migration step. It created the table that remembered which single file a chat's #tag let a thread read, for the box's VyreDrive shares; the shares and the tag are gone, but the
// store numbers a module's steps by position and a box that already ran this one keeps its table, so the step stays in the list and the list never reorders (migrations.js).

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
