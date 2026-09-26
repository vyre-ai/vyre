// @ts-check
// One place for Chat's URLs, since they are spelled in three files (index.js, nav.js, session.js).
// A project-less thread uses /chat/thread/:thread (deck's js/app.js, commit f33b339): a flat
// /chat/:thread can't coexist with /chat/:project, since match() picks a route by segment count
// only, so "thread" is a literal prefix segment instead.

/** @param {{ id: string, project?: string|null }} t */
export const threadHref = t => t.project ? `/chat/${encodeURIComponent(t.project)}/${encodeURIComponent(t.id)}` : `/chat/thread/${encodeURIComponent(t.id)}`;
/** @param {string} slug */
export const projectHref = slug => `/chat/${encodeURIComponent(slug)}`;
