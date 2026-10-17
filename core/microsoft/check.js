// @ts-check
// check (Microsoft 365): walks the firm app's setup in order and names the first step that is missing, in words an owner can act on. It reads only: one token request per app, and one read of
// each attested person's inbox folder (never a message). Nothing it returns holds a secret; messages from Microsoft are scrubbed of every value the credential library has touched.

/** @param {string} m */
const kind403 = m => /ApplicationAccessPolicy|Access to OData is disabled/i.test(m) ? "policy" : /Insufficient privileges|Authorization_RequestDenied|not granted/i.test(m) ? "consent" : "unknown";

const FIX = {
  app: "Add the firm app: microsoft.add with a name, the firm's email domain, and a vault item holding tenant_id, client_id and client_secret.",
  secret: "Check the vault item: tenant_id and client_id must match the app registration in Entra, and client_secret must be a current secret value (not its id). A secret expires: create a new one under Certificates and secrets, then update the item.",
  people: "Record each person's work email with microsoft.members.email, so the app knows which mailbox is theirs.",
  consent: "In Entra, open the app registration, API permissions, add the Microsoft Graph APPLICATION permissions Mail.Read, Calendars.Read and Files.Read.All, then choose Grant admin consent for the tenant.",
  policy: "The tenant blocks this mailbox for the app. Add the person to the staff group the app is limited to (ApplicationAccessPolicy or RBAC for Applications), wait up to an hour, and check again.",
  mailbox: "Microsoft does not know this mailbox. Check the work email recorded for this person.",
  unknown: "Microsoft refused the read. Check the app's permissions and the tenant's access policy, then check again.",
};

/**
 * @param {{ accounts: { all(): any[] }, emails: { all(): { person: string, email: string }[], get(person: string): any }, creds: any, request: (acct: any, req: any) => Promise<any>, derive: (all: any[], member: any) => any[], scopes: string[] }} d
 */
export async function checkSetup(d) {
  /** @type {{ step: string, ok: boolean, say: string, fix?: string }[]} */ const steps = [];
  const push = (step, ok, say, fix) => steps.push({ step, ok, say, ...(fix ? { fix } : {}) });
  const apps = d.accounts.all();
  if (!apps.length) { push("app", false, "No firm Microsoft 365 app is added.", FIX.app); return done(steps); }
  push("app", true, `${apps.length === 1 ? "The firm app" : "The firm apps"} ${apps.map(a => a.name).join(", ")} ${apps.length === 1 ? "is" : "are"} added.`);
  let tokens = true;
  for (const a of apps) {
    try { await d.creds.headers(a.auth, { scopes: d.scopes }); push(`secret:${a.name}`, true, `${a.name} signs in to Microsoft.`); }
    catch (e) { tokens = false; push(`secret:${a.name}`, false, `${a.name} could not sign in: ${d.creds.scrub(String(/** @type {any} */ (e)?.message || e)).slice(0, 240)}`, FIX.secret); }
  }
  if (!tokens) return done(steps);
  const people = d.emails.all();
  if (!people.length) { push("people", false, "No work email is recorded for anyone.", FIX.people); return done(steps); }
  push("people", true, `${people.length} work ${people.length === 1 ? "email is" : "emails are"} recorded.`);
  for (const p of people) {
    let accts;
    try { accts = d.derive(apps.map(a => ({ ...a, firm: true })), d.emails.get(p.person)); }
    catch (e) { push(`mailbox:${p.person}`, false, d.creds.scrub(String(/** @type {any} */ (e)?.message || e)).slice(0, 240), FIX.people); continue; }
    try { await d.request(accts[0], { path: "/mailFolders/inbox", query: { $select: "id" } }); push(`mailbox:${p.person}`, true, `${p.email} can be read.`); }
    catch (e) {
      const err = /** @type {any} */ (e), msg = d.creds.scrub(String(err?.message || err));
      const k = err && err.code === "not_found" ? "mailbox" : err && err.code === "forbidden" ? kind403(msg) : "unknown";
      push(`mailbox:${p.person}`, false, `${p.email} could not be read: ${msg.slice(0, 240)}`, FIX[k]);
    }
  }
  return done(steps);
}

/** @param {{ step: string, ok: boolean, say: string, fix?: string }[]} steps */
function done(steps) {
  const bad = steps.find(s => !s.ok);
  return { ok: !bad, steps, next: bad ? bad.fix : "The firm app is set up. Every recorded mailbox can be read." };
}
