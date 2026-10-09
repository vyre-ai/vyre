// @ts-check
// A procedure the person keeps repeating becomes a skill DRAFT in the skills library (R031-44), through the one path every skill takes: the person (or the project's owner) approves it on one card, it is
// versioned, and it reaches every AI session at its level. Learn still proposes its own skill (learn.skills); this is the mirror, so a lesson is not stranded in a second inbox.
// A project's procedure is drafted at the project level, any other at the person's own level. Failure never stops learning: a library that is not there leaves the learn proposal as it was.

/** The call that drafts a proposed skill into the library. @param {{ name: string, body: string, scope?: any }} s a learn skill (scope "all" or { project }) @returns {{ name: string, body: string, project?: string }} */
export function libraryInput(s) {
  const project = s && s.scope && typeof s.scope === "object" && typeof s.scope.project === "string" ? s.scope.project : "";
  return { name: String(s.name), body: String(s.body), ...(project ? { project } : {}) };
}

/** @param {(tool: string, input: any) => Promise<any>} call @param {{ name: string, body: string, scope?: any }} s @param {(m: string) => void} [log] @returns {Promise<boolean>} whether the draft was made */
export async function toLibrary(call, s, log = () => {}) {
  try {
    const r = await call("skills.draft.learned", libraryInput(s));
    if (r && r.error) { log(`skill ${s.name} not drafted into the library: ${r.error.message}`); return false; }
    return true;
  } catch (e) { log(`skill ${s.name} not drafted into the library: ${/** @type {Error} */ (e).message}`); return false; }
}
