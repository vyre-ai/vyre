// @ts-check
// One place for Chat's URLs, since they are spelled in three files (index.js, nav.js, session.js).
// deck/js/app.js's route table has no pattern yet for a thread with no project, so "_" stands in
// for "none" in the project segment; index.js reads it back out. See the note to deck in
// docs/work/gate-chat.md — a flat /chat/:thread would drop this the day the route exists.

/** @param {{ id: string, project?: string|null }} t */
export const threadHref = t => `/chat/${encodeURIComponent(t.project || "_")}/${encodeURIComponent(t.id)}`;
/** @param {string} slug */
export const projectHref = slug => `/chat/${encodeURIComponent(slug)}`;
