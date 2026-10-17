// @ts-check
// provisioned: what the firm key lets a member act as, shown beside her own connections (the Vault's Apps list). That is her Google Workspace account (core/google derives it from her attested work email) and her Microsoft 365 account (microsoft.accounts answers for the caller alone).
// It reads the google module as her (the module hop carries her chain), keeps the address and the app, and drops everything else. Only an account derived for HER (its member is her id) is kept, whatever the module answered: another member's address, or the firm key's own, never shows. Nothing is stored and nothing is shareable: whoever uses the account does it
// through the firm key as her own mailbox, which the google module decides.

import { MEMBER_SURFACES, memberOf } from "./me.js";

/** @param {{ ctx: any, tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o */
export function register({ ctx, tool }) {
  tool("vault.me.provisioned", MEMBER_SURFACES, "The accounts the firm key lets you act as, for your own list of apps: the app and the address, never a credential.", { type: "object", properties: {}, required: [] },
    async (_input, meta) => {
      const person = await memberOf(ctx.kernel, meta);
      const r = await ctx.call("google.accounts", {}).catch(() => null);
      const rows = r && Array.isArray(r.data) ? r.data : [];
      const ms = await ctx.call("microsoft.accounts", {}).catch(() => null);
      const mrows = ms && Array.isArray(ms.data) ? ms.data : [];   // the firm app's answer for the caller alone: her address, never the app's secret
      return { accounts: [
        ...rows.filter((/** @type {any} */ a) => a && a.member === person && typeof a.email === "string" && a.email).map((/** @type {any} */ a) => ({ app: "Google Workspace", account: String(a.email) })),
        ...mrows.filter((/** @type {any} */ a) => a && typeof a.email === "string" && a.email).map((/** @type {any} */ a) => ({ app: "Microsoft 365", account: String(a.email) })),
      ] };
    });
}
