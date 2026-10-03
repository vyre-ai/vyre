// Headless Space bootstrap: user, workspace, activation, service API key, login closed.
// usage: SVC_PASS=... node bootstrap.mjs <base> <email> <displayName> [subdomain] [domain]
import fs from "node:fs";
const [,, base, email, name, sub, domain = "twenty.internal:3000"] = process.argv;
const pass = process.env.SVC_PASS;
const origin = sub ? `http://${sub}.${domain}` : base;
async function gq(path, query, token) {
  const r = await fetch(base + "/" + path, { method: "POST", headers: { "content-type": "application/json", origin: base, ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}
const t0 = Date.now(); const step = {};
const lap = (k) => { step[k] = Date.now() - t0; };
let su;
try { su = (await gq("metadata", `mutation{signUp(email:"${email}",password:"${pass}"){tokens{accessOrWorkspaceAgnosticToken{token}}}}`)).signUp; }
catch { su = (await gq("metadata", `mutation{signIn(email:"${email}",password:"${pass}"){tokens{accessOrWorkspaceAgnosticToken{token}}}}`)).signIn; }
lap("signUp");
const agn = su.tokens.accessOrWorkspaceAgnosticToken.token;
const nw = (await gq("metadata", `mutation{signUpInNewWorkspace(input:{displayName:"${name}"${sub ? `,subdomain:"${sub}"` : ""}}){loginToken{token} workspace{id}}}`, agn)).signUpInNewWorkspace;
lap("workspace");
const tk = await gq("metadata", `mutation{getAuthTokensFromLoginToken(loginToken:"${nw.loginToken.token}",origin:"${origin}"){tokens{accessOrWorkspaceAgnosticToken{token}}}}`);
const acc = tk.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
await gq("metadata", `mutation{activateWorkspace(data:{}){id}}`, acc);
lap("activate");
const roles = await gq("metadata", `{getRoles{id label}}`, acc);
const role = roles.getRoles.find((r) => r.label === "Admin") || roles.getRoles[0];
const exp = new Date(Date.now() + 365 * 864e5).toISOString();
const ak = await gq("metadata", `mutation{createApiKey(input:{name:"vyre-gateway",expiresAt:"${exp}",roleId:"${role.id}"}){id}}`, acc);
const tok = await gq("metadata", `mutation{generateApiKeyToken(apiKeyId:"${ak.createApiKey.id}",expiresAt:"${exp}"){token}}`, acc);
lap("apiKey");
let closed = "no";
try { await gq("metadata", `mutation{updateWorkspace(data:{isPasswordAuthEnabled:false}){id}}`, acc); closed = "password login disabled on workspace"; } catch (e) { closed = "FAILED: " + e.message.slice(0, 160); }
lap("close");
fs.writeFileSync(`key-${nw.workspace.id}.txt`, tok.generateApiKeyToken.token, { mode: 0o600 });
console.log(JSON.stringify({ workspaceId: nw.workspace.id, role: role.label, totalMs: Date.now() - t0, stepsMsCumulative: step, closed }));
