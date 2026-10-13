// @ts-check
// linked-provider: the one shape a linked source takes, so Google Drive, SharePoint and a GitHub repo plug into Files > Linked the same way. Nothing here names a vendor: a link is
// { provider, source }, where `source` is whatever that provider needs to find the folder (a Drive folder id; a repo, branch and path) and only the provider reads it.
//
// Every method gets the link and the PERSON the call is for (their identity decides what the source shows, never more than the source allows) and returns plain data:
//   list(link, person, { token? })        -> { entries: [{ id, path, name, mime, size, modified, rev, deleted? }], next, full }   `path` is relative to the link's root; `token` is the provider's
//                                            opaque change token from the last call (a Drive changes pageToken, a git commit sha); `full` true means "this is everything", so drop what is not listed
//   read(link, person, entry)             -> { bytes: Uint8Array, mime, rev }                                                    fetched when opened, never copied ahead
//   write(link, person, path, bytes, { baseRev? }) -> { id, rev }                     a stale baseRev answers code "conflict" (a Drive edit; a git commit or a branch plus a pull request, per link)
//   rename(link, person, entry, toPath)   -> { id, rev }
//   delete(link, person, entry)           -> { deleted: true }                         (a Drive trash; a git commit that removes the file)
//   versions(link, person, entry)         -> [{ rev, modified, by?, note? }]           (Drive revisions; git history)
export const PROVIDER_METHODS = Object.freeze(["list", "read", "write", "rename", "delete", "versions"]);
const ID = /^[a-z][a-z0-9-]{0,31}$/;

/** @param {any} p @returns {any} the provider, when it has the whole shape */
export function assertProvider(p) {
  if (!p || typeof p.id !== "string" || !ID.test(p.id)) throw new Error(`linked provider: bad id ${JSON.stringify(p && p.id)}`);
  for (const m of PROVIDER_METHODS) if (typeof p[m] !== "function") throw new Error(`linked provider ${p.id}: missing ${m}`);
  return p;
}
