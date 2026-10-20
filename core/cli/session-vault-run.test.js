// @ts-check
// `vyre vault run --item` inside an agent's session (core/cli/session.js vaultRun), over a fake socket: the values arrive sealed to the run's own key, the program gets them under their
// canonical names, its output shows every secret as [hidden: NAME] (encoded forms too), a refusal runs nothing, and `vyre call vault.use.env` is not a way around it. Sample values only.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { run, vaultRun } from "./session.js";
import { sealFor } from "../vault/crypto.js";

const SECRET = `nw_${crypto.randomBytes(10).toString("hex")}`;

/** A fake session socket that answers vault.use.env as the daemon would: sealed to the key the run sent. */
function rig(answer = /** @type {any} */ (null)) {
  const seen = /** @type {any[]} */ ([]);
  const req = async (/** @type {string} */ method, /** @type {string} */ url, /** @type {any} */ body, /** @type {any} */ opts) => {
    seen.push({ method, url, body, opts });
    if (answer) return answer;
    return { data: { box: sealFor(body.key, { env: { NORTHWIND_API_KEY: SECRET, NORTHWIND_ACCOUNT_ID: "acct_042" }, hidden: ["NORTHWIND_API_KEY"] }, "vault-run", "vault-run"), names: ["NORTHWIND_API_KEY", "NORTHWIND_ACCOUNT_ID"] } };
  };
  const errs = /** @type {string[]} */ ([]);
  return { seen, req, errs, err: (/** @type {string} */ s) => errs.push(s) };
}

const collect = () => { const s = new PassThrough(); let text = ""; s.on("data", c => { text += c.toString("utf8"); }); return { s, text: () => text }; };

test("the program gets the fields under their canonical names; its output hides the secret in every form and keeps the plain value", async () => {
  const r = rig();
  const out = collect(), errOut = collect();
  const script = "const k = process.env.NORTHWIND_API_KEY; console.log(k, Buffer.from(k).toString('base64'), process.env.NORTHWIND_ACCOUNT_ID); console.error('key=' + encodeURIComponent(k)); console.error(Buffer.from(k).toString('hex').toUpperCase(), [...k].reverse().join(''))";
  const code = await vaultRun(["--item", "Northwind CRM", "--", process.execPath, "-e", script], { req: /** @type {any} */ (r.req), ident: { caller: "mcp:agent:kit" }, err: r.err, stdout: out.s, stderr: errOut.s });
  assert.equal(code, 0, r.errs.join("\n"));
  assert.equal(out.text().trim(), "[hidden: NORTHWIND_API_KEY] [hidden: NORTHWIND_API_KEY] acct_042");
  assert.equal(errOut.text().trim(), "key=[hidden: NORTHWIND_API_KEY]\n[hidden: NORTHWIND_API_KEY] [hidden: NORTHWIND_API_KEY]", "the wide and deep forms too: hex in capitals, reversed");
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].url, "/v1/tools/vault.use.env");
  assert.deepEqual(r.seen[0].body.items, ["Northwind CRM"]);
  assert.equal(r.seen[0].body.command, "node");
  assert.equal(r.seen[0].opts.caller, "mcp:agent:kit");
});

test("a refusal runs nothing and says why; bad arguments are a usage line; vyre call vault.use.env is refused", async () => {
  const r = rig({ error: { code: "denied", message: "northwind-crm is not allowed in scripts" } });
  const out = collect();
  assert.equal(await vaultRun(["--item", "northwind-crm", "--", process.execPath, "-e", "console.log('ran')"], { req: /** @type {any} */ (r.req), ident: {}, err: r.err, stdout: out.s, stderr: out.s }), 1);
  assert.equal(out.text(), "", "the program never started");
  assert.match(r.errs.at(-1) || "", /not allowed in scripts/);
  const b = rig();
  assert.equal(await vaultRun(["northwind-crm", "--", "true"], { req: /** @type {any} */ (b.req), ident: {}, err: b.err }), 2);
  assert.equal(await vaultRun(["--item", "northwind-crm"], { req: /** @type {any} */ (b.req), ident: {}, err: b.err }), 2);
  assert.equal(b.seen.length, 0);
  const errs = /** @type {string[]} */ ([]);
  const code = await run(["call", "vault.use.env", '{"items":["northwind-crm"],"key":"x"}'], { env: { VYRE_SOCKET: "/s", VYRE_THREAD: "t" }, request: /** @type {any} */ (async () => { throw new Error("must not be called"); }), out: () => {}, err: s => errs.push(s) });
  assert.equal(code, 2);
  assert.match(errs.join(""), /vyre vault run --item/);
});
