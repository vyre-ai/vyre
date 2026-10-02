// @ts-check
// Why a session stopped, in a sentence a person can act on (#54). The box says `thread.stopped { reason }` with words like
// "exited 1: Claude Code process exited with code 1"; the Deck shows what it means and what to do, with the box's own words under it.
// Pure, so every surface and test says it the same way.

/**
 * @param {string|null|undefined} reason the stop reason from the box
 * @returns {{ line: string, action: "retry"|"sign-in"|null, detail: string }|null} null when the reason is not a failure
 */
export function stopWords(reason) {
  const r = String(reason || "").trim();
  if (!r || /^(idle|restart|rewind|done|exited|stop|stopped)$/i.test(r)) return null;
  const detail = r.slice(0, 300);
  if (/not signed in|sign in|login|unauthori[sz]ed|authenticat|credential|api key|401|403/i.test(r))
    return { line: "This session is not signed in to its AI account, so it could not answer.", action: "sign-in", detail };
  if (/rate.?limit|usage limit|out of (usage|credit)|quota|429|overloaded/i.test(r))
    return { line: "This session hit its usage limit, so it could not answer. Try again later, or choose another account.", action: "retry", detail };
  if (/^exited\b/i.test(r) || /process exited|exit code|signal/i.test(r))
    return { line: "This session's process stopped before it answered.", action: "retry", detail };
  return { line: "This session stopped before it answered.", action: "retry", detail };
}
