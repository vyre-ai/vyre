// @ts-check
// microsoft: Microsoft 365 mail, calendar and OneDrive through the Space's FIRM app (an Azure app with app-only Graph permissions), read-only.
//
// The owner adds the app once (microsoft.add: owner only, the secret stays in the vault). Every call then acts as ONE mailbox: a team member's own attested work email, or the owner's own
// attested work email, never a mailbox named in the input (lib/member-scope.js and member-account.js). The tenant must restrict the app to the firm's staff group (ApplicationAccessPolicy or RBAC
// for Applications): without that restriction a firm app can reach every mailbox in the tenant, and nothing here can make it narrower than the tenant allows.
// Nothing is sent from here and nothing is written: no send, no draft, no event. Nothing runs in the background.
import { Credentials } from "../../lib/connectors/auth.js";
import { scopeFor, requireOwner, emailProblem } from "../../lib/member-scope.js";
import { MIGRATIONS, check, store, memberEmails, EMAIL } from "./accounts.js";
import { forMember } from "./member-account.js";
import { graph, tools as graphTools } from "./graph.js";

const str = { type: "string" }, int = { type: "integer" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const clamp = (v, lo, hi, d) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d);
const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const PEOPLE = ["cli", "local", "deck", "capsule", "module"];

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const accounts = store(ctx.store.db), emails = memberEmails(ctx.store.db), now = () => Date.now();
    const creds = new Credentials({ fetchItem: (item, field) => ctx.vault.fetch(item, field ? { field } : {}), log: (m, f) => ctx.log(m, f) });
    const g = graphTools(graph({ creds }));
    const memberOf = id => emails.get(id);

    /** Run a tool body and scrub what comes back, errors included; codes pass through. */
    const safe = fn => async (input, meta) => {
      try { return creds.scrubAll(await fn(input, meta)); } catch (e) {
        const err = /** @type {any} */ (e);
        throw Object.assign(new Error(creds.scrub(String(err?.message || err))), { code: typeof err?.code === "string" ? err.code : "failed" });
      }
    };

    /** The one mailbox this call acts as. A member: their own. The owner (or the home's own work): the owner's attested work email, or a plain refusal. */
    const mailboxes = async meta => {
      const scoped = await scopeFor({ kernel: ctx.kernel, all: () => accounts.all(), memberOf, derive: forMember }, meta);
      if (scoped) return scoped;
      const owner = ctx.kernel && typeof ctx.kernel.owner === "string" ? ctx.kernel.owner : null;
      const rec = owner ? memberOf(owner) : null;
      if (!rec) throw fail("set your own work email first (microsoft.members.email with your own person id), then the firm app can act as you", "no_account");
      return forMember(accounts.all(), rec);
    };
    const first = async meta => (await mailboxes(meta))[0];

    ctx.tool("microsoft.accounts", {
      description: "The firm Microsoft 365 app: name and domain, never a secret. Owner only.",
      input: obj({}), callers: PEOPLE,
      run: safe(async (_, meta) => { await requireOwner(ctx.kernel, meta); return accounts.all().map(a => ({ name: a.name, domain: a.domain, item: a.auth.item, added: a.added })); }),
    });

    ctx.tool("microsoft.add", {
      description: "Add the firm Microsoft 365 app: a name, the firm's email domain, and the vault item holding tenant_id, client_id and client_secret of an Azure app with APPLICATION permissions Mail.Read, Calendars.Read and Files.Read.All. Restrict the app to the staff group in the tenant (ApplicationAccessPolicy or RBAC for Applications) first: without it the app reaches every mailbox. Owner only.",
      input: obj({ name: str, domain: str, item: str, base: str }, ["name", "domain", "item"]), callers: PEOPLE,
      run: safe(async (input, meta) => {
        await requireOwner(ctx.kernel, meta);
        const problem = check(input); if (problem) throw fail(problem);
        const acct = accounts.put(input, now());
        for (const a of [acct]) creds.invalidate(a.auth, ["https://graph.microsoft.com/.default"]);
        ctx.events.emit("microsoft.added", { name: acct.name });
        return { name: acct.name, domain: acct.domain, item: acct.auth.item };
      }),
    });

    ctx.tool("microsoft.remove", {
      description: "Remove the firm Microsoft 365 app. The vault item stays. Owner only.",
      input: obj({ name: str }, ["name"]), callers: PEOPLE,
      run: safe(async ({ name }, meta) => { await requireOwner(ctx.kernel, meta); const removed = accounts.remove(name); if (removed) ctx.events.emit("microsoft.removed", { name }); return { removed }; }),
    });

    ctx.tool("microsoft.members.email", {
      description: "The work email the firm app may act as for a person: { person, email } sets or edits it, { person } alone clears it, no input lists them. Owner only; a member never sets their own.",
      input: obj({ person: str, email: str }), callers: PEOPLE,
      run: safe(async ({ person, email }, meta) => {
        await requireOwner(ctx.kernel, meta);
        if (person === undefined) return emails.all();
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(person))) throw fail("person must be a member id");
        if (email === undefined) return { removed: emails.clear(person) };
        if (!EMAIL.test(String(email))) throw fail("email must be an address");
        const why = emailProblem({ email: String(email), person, firmKeys: accounts.all(), taken: e => emails.holder(e) });
        if (why) throw fail(why);
        emails.set(person, email, null, now());
        return { person, email: String(email).toLowerCase() };
      }),
    });

    ctx.tool("microsoft.mail.search", {
      description: "Search your Microsoft 365 mail, newest first: [{id, from, subject, date, snippet, url}]. You see your own mailbox only.",
      input: obj({ q: str, limit: int }, ["q"]),
      run: safe(async ({ q, limit }, meta) => g.mailSearch(await first(meta), { q, limit: clamp(limit, 1, 25, 10) })),
    });
    ctx.tool("microsoft.mail.read", {
      description: "Read one of your Microsoft 365 messages (id) as plain text with headers. Bodies are capped near 20,000 characters.",
      input: obj({ id: str }, ["id"]),
      run: safe(async ({ id }, meta) => g.mailRead(await first(meta), { id })),
    });
    ctx.tool("microsoft.calendar.list", {
      description: "Your Microsoft 365 calendar between two ISO times (at most a year apart): [{id, title, start, end, where, organizer, url}], times in UTC.",
      input: obj({ from: str, to: str, limit: int }, ["from", "to"]),
      run: safe(async ({ from, to, limit }, meta) => g.calendarList(await first(meta), { from, to, limit: clamp(limit, 1, 100, 25) })),
    });
    ctx.tool("microsoft.drive.search", {
      description: "Search your OneDrive by words in the name or text: [{id, name, type, modified, url}].",
      input: obj({ q: str, limit: int }, ["q"]),
      run: safe(async ({ q, limit }, meta) => g.driveSearch(await first(meta), { q, limit: clamp(limit, 1, 25, 10) })),
    });
    ctx.tool("microsoft.drive.read", {
      description: "Read one OneDrive file (id) as text when it is plain text; any other file gives its name and link. Capped near 20,000 characters.",
      input: obj({ id: str }, ["id"]),
      run: safe(async ({ id }, meta) => g.driveRead(await first(meta), { id })),
    });

    return { async stop() {} };
  },
};
