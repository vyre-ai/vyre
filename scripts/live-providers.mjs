#!/usr/bin/env node
// @ts-check
// live-providers: the checks that need a real sign-in (team/0.3.1/LIVE-PROVIDERS.md), run through a real vyred on a throwaway home on the TEST BOX
// (never a person's Mac), on the person's own subscriptions, with no API key and no spend:
//   node scripts/live-providers.mjs <check> --home <dir> --codex-home <dir> --grok-home <dir> [--providers codex,grok]
// Codex and Grok are signed in once by the person (`codex login --device-auth`, `grok login --device-auth`) in a home used only for this; the sign-in
// files are copied (never printed) into the throwaway Vyre's own account folders. One JSON line per fact: { check, provider, ok, evidence }.
import fs from "node:fs";
import path from "node:path";

process.env.VYRE_LEGACY_DIRECT_MODEL ??= "1"; process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1"; process.env.VYRE_SESSION_SANDBOX_OFF = "1";
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "smoke";
const flag = (/** @type {string} */ n, /** @type {string} */ d = "") => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const home = path.resolve(flag("home", "/tmp/live-providers-home"));
const providers = flag("providers", "codex,grok").split(",").filter(Boolean);
if (process.platform === "darwin" && !process.env.LIVE_PROVIDERS_MAC_OK) { console.error("live-providers: test box only"); process.exit(2); }

if (providers.includes("claude") || cmd.split(",").some((c) => c === "switch")) { process.env.VYRE_SESSIONS_DRIVER ??= "cli"; process.env.VYRE_CLAUDE_BIN ??= "claude"; process.env.ANTHROPIC_MODEL ??= "claude-sonnet-5-5"; }
const { start } = await import("../core/daemon/index.js");
const { present, asOwner } = await import("../test/helpers.js");

fs.mkdirSync(home, { recursive: true });
const work = fs.realpathSync(fs.mkdtempSync(`${home}-work-`));
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ name: "live-providers", role: "box", sessions: { max_live: 0 }, vault: { keystore: "file", mcp: { port: 0 } }, recall: { every: 0, vectors: false }, files: { roots: [work] }, projectsDir: path.join(home, "projects") }));
const d = await start({ root: home, presence: present, log: () => {}, kernel: true });
asOwner(d, home);
const call = (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {string} */ caller = "cli") => d.registry.call(tool, input, caller);
const must = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await call(tool, input); if (r.error) throw new Error(`${tool}: ${r.error.code} ${r.error.message}`); return r.data; };
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const say = (/** @type {string} */ check, /** @type {string} */ provider, /** @type {boolean} */ ok, /** @type {string} */ evidence) => console.log(JSON.stringify({ check, provider, ok, evidence: String(evidence).slice(0, 500) }));

/** The account folder of a login account, with the person's sign-in copied in. */
async function account(/** @type {string} */ provider) {
  const src = flag(`${provider}-home`);
  if (!src) throw new Error(`--${provider}-home is required`);
  const a = await must("sessions.accounts.add", { provider, label: `live-${provider}`, kind: "login", is_default: true });
  const id = String(a.id || (a.account && a.account.id));
  const dest = path.join(home, "accounts", id);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const dir = provider === "codex" ? ".codex" : ".grok";
  fs.cpSync(path.join(src, dir), path.join(dest, dir), { recursive: true });
  for (const f of fs.readdirSync(path.join(dest, dir))) { if (/^auth\.json$/.test(f)) fs.chmodSync(path.join(dest, dir, f), 0o600); }
  return { id, dest };
}

/** Answer asks as the person would: allow a Vyre tool, deny anything else (a check can change this). */
const asks = /** @type {any[]} */ ([]);
let askPolicy = (/** @type {any} */ a) => (/vyre/i.test(String(a.tool || a.title || "")) ? "allow" : "deny");
const answered = new Set();
const person = setInterval(async () => {
  try {
    const r = await call("threads.asks", {});
    for (const a of Array.isArray(r.data) ? r.data : []) {
      const id = a.id || a.ask; if (!id || answered.has(id)) continue; answered.add(id); asks.push(a);
      await call("threads.answer", { ask: id, decision: askPolicy(a), message: "live-providers" });
    }
  } catch { /* next tick */ }
}, 700);

/** Send text and wait until the thread is idle again; the assistant's items since. */
async function turn(/** @type {string} */ thread, /** @type {string} */ text, /** @type {any} */ extra = {}, /** @type {number} */ ms = 420_000) {
  const before = await must("threads.items", { thread });
  const last = (before.items || []).reduce((/** @type {number} */ m, /** @type {any} */ x) => Math.max(m, x.id || 0), 0);
  const g0 = (await call("threads.get", { thread })).data || {};
  const lastEvent = (g0.events || []).reduce((/** @type {number} */ m, /** @type {any} */ e) => Math.max(m, e.id || 0), 0);
  await must("threads.send", { thread, text, ...extra });
  const t0 = Date.now();
  for (;;) {
    await sleep(1500);
    const g = (await call("threads.get", { thread })).data || {};
    if ((g.events || []).some((/** @type {any} */ e) => e.type === "thread.finished" && e.id > lastEvent)) { await sleep(1000); break; }
    if (Date.now() - t0 > ms) { const a = (await call("threads.asks", {})).data; const tail = (g.events || []).slice(-4).map((/** @type {any} */ e) => e.type + ":" + JSON.stringify(e.payload).slice(0, 160)); throw new Error("the turn did not finish in time; open asks " + JSON.stringify(a).slice(0, 400) + "; last events " + JSON.stringify(tail)); }
  }
  return await must("threads.items", { thread, since: last });
}
const textOf = (/** @type {any} */ items) => (Array.isArray(items && items.items) ? items.items : []).filter((/** @type {any} */ x) => x.role === "assistant" || x.kind === "assistant" || x.type === "assistant").map((/** @type {any} */ x) => String(x.text || x.content || "")).join("\n");

const here = path.dirname(new URL(import.meta.url).pathname);
const fixture = (/** @type {string} */ f) => fs.readFileSync(path.join(here, "fixtures", f));
const items = (/** @type {any} */ r) => (Array.isArray(r && r.items) ? r.items : []);
const said = (/** @type {any} */ r) => items(r).filter((/** @type {any} */ x) => x.kind === "assistant").map((/** @type {any} */ x) => String(x.text || "")).join("\n");
const tools = (/** @type {any} */ r) => items(r).filter((/** @type {any} */ x) => x.kind === "tool");
/** @type {string | null} */ let projectSlug = null;
let skillMade = false;
const start1 = async (/** @type {string} */ provider, /** @type {string} */ acctId, /** @type {string} */ prompt) => {
  if (!projectSlug) { fs.mkdirSync(path.join(work, "okafor"), { recursive: true }); const pr = await must("projects.create", { name: "okafor", home: path.join(work, "okafor") }); projectSlug = String(pr.slug || "okafor"); }
  const t = await must("threads.start", { project: projectSlug, provider, account: acctId, purpose: "chat" });
  const thread = String(t.id || t.thread);
  const r = await turn(thread, prompt);
  return { thread, r };
};

/** The id of the newest event of a thread, so a wait can look only at what came after. */
const lastEventOf = async (/** @type {string} */ thread) => ((await call("threads.get", { thread, limit: 400 })).data.events || []).reduce((/** @type {number} */ m, /** @type {any} */ e) => Math.max(m, e.id || 0), 0);
/** Wait for the next thread.finished after an event id; the finished event, and the words said since (completed text blocks). */
async function finished(/** @type {string} */ thread, /** @type {number} */ after, /** @type {number} */ ms = 420_000) {
  const t0 = Date.now();
  for (;;) {
    await sleep(1500);
    const ev = ((await call("threads.get", { thread, limit: 400 })).data || {}).events || [];
    const fin = ev.find((/** @type {any} */ e) => e.type === "thread.finished" && e.id > after);
    if (fin) { await sleep(800); const ev2 = ((await call("threads.get", { thread, limit: 400 })).data || {}).events || []; return { fin, said: ev2.filter((/** @type {any} */ e) => e.id > after && e.type === "thread.text" && e.payload && e.payload.done && !e.payload.notice).map((/** @type {any} */ e) => String(e.payload.text)).join("\n"), events: ev2.filter((/** @type {any} */ e) => e.id > after) }; }
    if (Date.now() - t0 > ms) throw new Error("the turn did not finish in time");
  }
}

const checks = {
  /** 1: a streamed turn, with a Vyre tool call answered. */
  async chat(/** @type {string} */ p, /** @type {{id:string}} */ acct) {
    const { thread, r } = await start1(p, acct.id, "Call your Vyre tool that counts what is waiting on me (search for it with tools_find if you need to), then reply with only the number it returned.");
    const g = (await call("threads.get", { thread })).data || {};
    const streamed = (g.events || []).filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload && e.payload.delta).length;
    const ts = tools(r);
    say("chat-stream", p, streamed > 0 && /\d/.test(said(r)), `streamed deltas ${streamed}; reply ${JSON.stringify(said(r)).slice(0, 80)}`);
    say("chat-tool", p, ts.length > 0 && /\d/.test(said(r)), `tool items ${JSON.stringify(ts.map((/** @type {any} */ x) => JSON.stringify(x.name || x.tool || x.call || x.title || x).slice(0, 70)))}; asks seen ${asks.length}`);
  },
  /** 4: Claude to Codex to Grok and back to Claude, then a question only the earlier turns answer. */
  async switch(/** @type {string} */ p, /** @type {any} */ _acct, /** @type {any} */ accts) {
    if (p !== "codex") return; // once, from the first provider's turn
    if (!projectSlug) { fs.mkdirSync(path.join(work, "okafor"), { recursive: true }); const pr = await must("projects.create", { name: "okafor", home: path.join(work, "okafor") }); projectSlug = String(pr.slug || "okafor"); }
    const t = await must("threads.start", { project: projectSlug, provider: "claude", purpose: "chat" });
    const thread = String(t.id || t.thread);
    let ev = await lastEventOf(thread);
    await must("threads.send", { thread, text: "Remember this code word for later: AMBER-92. Reply with only: noted" });
    let f = await finished(thread, ev); say("switch-1-claude", "claude", f.fin.payload.ok !== false && /noted/i.test(f.said), `reply ${JSON.stringify(f.said).slice(0, 100)}`);
    const hop = async (/** @type {string} */ provider, /** @type {string} */ text) => {
      ev = await lastEventOf(thread);
      const r = await call("threads.switch", { thread, provider, ...(accts[provider] ? { account: accts[provider].id } : {}), text });
      if (r.error) throw new Error(`switch to ${provider}: ${r.error.code} ${r.error.message}`);
      return finished(thread, ev);
    };
    f = await hop("codex", "A second fact for later: the client is Okafor Holdings. Also, in one short sentence, what code word did I give you earlier?");
    say("switch-2-codex", "codex", /AMBER-92/i.test(f.said), `reply ${JSON.stringify(f.said).slice(0, 160)}`);
    f = await hop("grok", "A third fact: the hearing is on 14 March. In one short sentence, what are the code word and the client name from earlier?");
    say("switch-3-grok", "grok", /AMBER-92/i.test(f.said) && /Okafor/i.test(f.said), `reply ${JSON.stringify(f.said).slice(0, 160)}`);
    f = await hop("claude", "Back to you. Reply on one line with the code word, the client name and the hearing date, in that order, from what was said in this conversation.");
    say("switch-4-back-to-claude", "claude", /AMBER-92/i.test(f.said) && /Okafor/i.test(f.said) && /14 March|March 14/i.test(f.said), `reply ${JSON.stringify(f.said).slice(0, 200)}`);
  },
  /** 2: a held send: the model asks to send, the Gate holds it, and nothing leaves before the yes (the proof never says yes). */
  async held(/** @type {string} */ p, /** @type {any} */ acct) {
    const { r } = await start1(p, acct && acct.id, "Send an email to nobody@example.invalid with the subject \"hello\" and the body \"test\", using your Vyre mail tool. Report exactly what happened to it, including any approval id.");
    const text = said(r);
    const id = (/ap_[0-9a-f-]{36}/.exec(text) || [])[0] || "";
    const items_ = (await call("approvals.items", {})).data;
    const list = Array.isArray(items_) ? items_ : Array.isArray(items_ && items_.items) ? items_.items : [];
    const waiting = id ? list.filter((/** @type {any} */ x) => JSON.stringify(x).includes(id)) : [];
    const claimsSent = /\b(was|has been|got) sent\b|sent successfully/i.test(text) && !/not sent|wasn.t sent|did not send|nothing (ran|left)/i.test(text);
    say("held-send", p, Boolean(id) && waiting.length > 0 && !claimsSent, `approval ${id ? id.slice(0, 12) + "..." : "none"}; waiting in approvals.items ${waiting.length}; the model says it was not sent: ${!claimsSent}; reply ${JSON.stringify(text).slice(0, 160)}`);
    if (process.env.LP_DEBUG) { console.log("ITEMS", JSON.stringify(list).slice(0, 500)); for (const x of tools(r)) console.log("TOOL", p, JSON.stringify(x.tool).slice(0, 300)); }
  },
  /** 6: Vyre-native by default: a plain ask reaches for records or Flows with no mention of them. */
  async native(/** @type {string} */ p, /** @type {any} */ acct) {
    const { thread, r } = await start1(p, acct && acct.id, "I just signed a new client, Dana Whitfield, a probate matter with a hearing on March 14. Keep track of this for me so I do not lose it, and tell me in one line what you did.");
    const g = (await call("threads.get", { thread, limit: 400 })).data || {};
    const calls = (g.events || []).filter((/** @type {any} */ e) => e.type === "thread.tool").map((/** @type {any} */ e) => JSON.stringify(e.payload));
    const blob = calls.join("\n");
    const vyre = /records[._]|flows[._]|work[._]|projects[._]|tasks[._]|memory[._]|goals[._]|planner[._]|time[._]/i.test(blob);
    const own = /TodoWrite|apply_patch|Write\b|notes?\.md|todo\.md/i.test(blob);
    say("native-default", p, vyre && !own, `vyre-way ${vyre}; own-file-way ${own}; tools ${JSON.stringify(calls.map((/** @type {string} */ c) => (/"(name|tool)":"([^"]+)"/.exec(c) || [])[2]).filter(Boolean)).slice(0, 300)}; reply ${JSON.stringify(said(r)).slice(0, 160)}`);
    if (process.env.LP_DEBUG) for (const c of calls.slice(0, 12)) console.log("EV", p, c.slice(0, 400));
  },
  /** 7: what each provider's harness reports, as the store holds it. */
  async harness(/** @type {string} */ p, /** @type {any} */ acct) {
    await start1(p, acct && acct.id, "Reply with the single word: ok");
    const h = await call("sessions.harness.get", { provider: p });
    say("harness-caps", p, !h.error && Boolean(h.data), JSON.stringify(h.error || h.data).slice(0, 450));
  },
  /** 5: one skill, approved once, runs in all three (the code is only in the skill). */
  async skill(/** @type {string} */ p, /** @type {any} */ acct) {
    if (!projectSlug) { fs.mkdirSync(path.join(work, "okafor"), { recursive: true }); const pr = await must("projects.create", { name: "okafor", home: path.join(work, "okafor") }); projectSlug = String(pr.slug || "okafor"); }
    if (!skillMade) {
      const body = "---\nname: okafor-greeting-code\ndescription: Use when the person asks for the Okafor greeting code.\n---\n\nThe Okafor greeting code is BLUEBIRD-77. Reply with that code and nothing else.\n";
      const dr = await must("skills.draft", { name: "okafor-greeting-code", level: "project", scope: projectSlug, kind: "skill", body });
      const ap = await call("skills.approve", { name: "okafor-greeting-code", level: "project", scope: projectSlug, version: dr.version || 1 });
      if (ap.error) throw new Error("skills.approve: " + JSON.stringify(ap.error));
      skillMade = true;
    }
    const { r } = await start1(p, acct && acct.id, "What is the Okafor greeting code? Use the skill for it if there is one; reply with the code only.");
    say("skill-materialised", p, /BLUEBIRD-77/.test(said(r)), `reply ${JSON.stringify(said(r)).slice(0, 160)}`);
  },
  /** 10: tools_find end to end: the model sees the finder's answer and picks, on a spread of the sealed asks (the finder's own ranking is scored beside it). Providers run side by side. */
  async find(/** @type {string} */ p, /** @type {any} */ acct) {
    const { PERSON_ONLY, HUMAN_ONLY } = await import("../core/presence/index.js");
    const { catalogOf, indexOf, find } = await import("../harness/mcp/core-tools.js");
    const catalog = catalogOf(d.registry.listTools("mcp:agent:kit").filter((/** @type {any} */ x) => !x.name.startsWith("harness.") && !PERSON_ONLY.has(x.name) && !HUMAN_ONLY.has(x.name)).map((/** @type {any} */ x) => ({ name: x.name, description: String(x.description || ""), input: x.input })));
    const have = new Set(catalog.map((/** @type {any} */ c) => c.name));
    const index = indexOf(catalog);
    const sealed = JSON.parse(fs.readFileSync(path.join(here, "..", "test", "fixtures", "tools-find-sealed.json"), "utf8"));
    const want = Number(flag("asks", "30"));
    const answerable = sealed.filter((/** @type {any} */ x) => x.expect.some((/** @type {string} */ e) => have.has(e)));
    const step = Math.max(1, Math.floor(answerable.length / want));
    const asksSet = answerable.filter((/** @type {any} */ _x, /** @type {number} */ i) => i % step === 0).slice(0, want);
    const norm = (/** @type {string} */ x) => String(x).toLowerCase().replace(/[.\-]/g, "_");
    let picked = 0, inTop5 = 0, ran = 0;
    /** @type {string[]} */ const misses = [];
    if (!projectSlug) { fs.mkdirSync(path.join(work, "okafor"), { recursive: true }); const pr = await must("projects.create", { name: "okafor", home: path.join(work, "okafor") }); projectSlug = String(pr.slug || "okafor"); }
    for (const x of asksSet) {
      const exp = x.expect.filter((/** @type {string} */ e) => have.has(e)).map(norm);
      const top5 = find(index, x.intent, 5).map((/** @type {any} */ g) => norm(g.name));
      const t = await must("threads.start", { project: projectSlug, provider: p, ...(acct ? { account: acct.id } : {}), purpose: "chat" });
      const thread = String(t.id || t.thread);
      let reply = "";
      try { reply = said(await turn(thread, `Task for you: "${x.intent}". Use your Vyre tool finder (tools_find) once to find the right tool for it, then reply with ONLY the exact name of the tool you would call. Do not call it.`)); } catch (e) { reply = "ERROR " + /** @type {Error} */ (e).message; }
      await call("threads.stop", { thread }).catch(() => {});
      ran++;
      const ok = exp.some((/** @type {string} */ e) => norm(reply).includes(e));
      if (ok) picked++; else misses.push(`${x.id} ${x.intent.slice(0, 50)} => ${reply.slice(0, 60).replace(/\n/g, " ")} (wanted ${exp.slice(0, 2).join("|")})`);
      if (exp.some((/** @type {string} */ e) => top5.includes(e))) inTop5++;
    }
    say("find-live", p, picked / Math.max(1, ran) >= 0.8, `${picked} of ${ran} picked an accepted tool (${Math.round((100 * picked) / Math.max(1, ran))}%); the finder's own top 5 held one for ${inTop5} of ${ran}; misses ${JSON.stringify(misses.slice(0, 6)).slice(0, 700)}`);
  },
  /** First-turn MCP readiness: a fresh session is asked at once whether it has the Vyre finder; repeated, per provider. */
  async mcpready(/** @type {string} */ p, /** @type {any} */ acct) {
    const n = Number(flag("n", "8"));
    let yes = 0; /** @type {string[]} */ const no = [];
    for (let i = 0; i < n; i++) {
      const { thread, r } = await start1(p, acct && acct.id, "Call the Vyre tool tools_find with the query \"what is waiting on me\", then reply with only the exact name of the first tool it returned. If you have no such tool, reply NOTOOL.");
      await call("threads.stop", { thread }).catch(() => {});
      const t = said(r).trim();
      if (/[a-z]+_[a-z_]+/i.test(t) && !/notool/i.test(t)) yes++; else no.push(t.slice(0, 50));
    }
    say("mcp-ready-first-turn", p, yes === n, `${yes} of ${n} fresh sessions had the Vyre finder on their first turn; no-answers ${JSON.stringify(no).slice(0, 200)}`);
  },
  /** 9: an outside agent (the provider's own CLI on its own identity, no Vyre session) holds a Vault MCP pass; its ask to see a value is declined and stays declined, and the value never reaches it. */
  async outside(/** @type {string} */ p, /** @type {any} */ _acct) {
    const { spawnSync } = await import("node:child_process");
    const SECRET = "sk-live-OUTSIDE-9917";
    const put = await call("vault.put", { name: `acme-${p}`, kind: "api-credential", description: "Acme", hosts: ["https://api.acme-proof.test"], fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["api.acme-proof.test"], endpoints: [{ method: "GET", path: "/v1/status", kind: "read" }] }), secret: SECRET } });
    if (put.error) throw new Error("vault.put: " + JSON.stringify(put.error));
    const pass = await must("vault.mcp.pass.create", { name: `outside-${p}`, items: [`acme-${p}`], reveal: true });
    if (!pass.url) throw new Error("the Vault MCP has no address (vault.mcp.port)");
    const tmp = fs.mkdtempSync(path.join("/tmp", `lp-outside-${p}-`));
    const env = { ...process.env, HOME: tmp, VYRE_VAULT_TOKEN: pass.token };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    /** @type {string[]} */ const argv = [];
    const prompt = `You are an outside agent with a Vault MCP server named vault. Do these steps with its tools and report each result in one line: 1) vault_list. 2) vault_reveal_ask for the item acme-${p} with why "proof". 3) Poll vault_reveal_ask with the id you were given, up to 4 times, 4 seconds apart, until it answers. Then say plainly whether you were able to see the value, and quote the value if you were.`;
    let bin = "", cwd = tmp;
    if (p === "codex") {
      fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true }); fs.copyFileSync(path.join(flag("codex-home"), ".codex", "auth.json"), path.join(tmp, ".codex", "auth.json"));
      env.CODEX_HOME = path.join(tmp, ".codex");
      spawnSync("codex", ["mcp", "add", "vault", "--url", pass.url, "--bearer-token-env-var", "VYRE_VAULT_TOKEN"], { env, encoding: "utf8" });
      bin = "codex"; argv.push("exec", "--skip-git-repo-check", "-s", "read-only", prompt);
    } else if (p === "grok") {
      fs.cpSync(path.join(flag("grok-home"), ".grok"), path.join(tmp, ".grok"), { recursive: true });
      spawnSync("grok", ["mcp", "add", "--transport", "http", "vault", pass.url, "--header", `Authorization: Bearer ${pass.token}`], { env, encoding: "utf8" });
      bin = "grok"; argv.push("-p", prompt, "--always-approve");
    } else {
      fs.writeFileSync(path.join(tmp, "mcp.json"), JSON.stringify({ mcpServers: { vault: { type: "http", url: pass.url, headers: { Authorization: `Bearer ${pass.token}` } } } }), { mode: 0o600 });
      env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";
      bin = "claude"; argv.push("-p", prompt, "--mcp-config", path.join(tmp, "mcp.json"), "--strict-mcp-config", "--allowedTools", "mcp__vault__vault_list mcp__vault__vault_reveal_ask mcp__vault__vault_request", "--model", "claude-sonnet-5-5");
    }
    let declined = 0, stop = false;
    const decliner = (async () => { while (!stop) { try { const it = (await call("approvals.items", {})).data; for (const x of Array.isArray(it) ? it : Array.isArray(it && it.items) ? it.items : []) { const a = x && x.answers && x.answers.find((/** @type {any} */ y) => y.tool === "vault.mcp.reveal.clear"); if (a) { const r = await call("vault.mcp.reveal.clear", a.input); if (!r.error) declined++; } } } catch { /* next */ } await sleep(600); } })();
    const run = await new Promise((resolve) => { import("node:child_process").then(({ spawn }) => { const c = spawn(bin, argv, { env, cwd, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; c.stdout.on("data", (b) => { out += b; }); c.stderr.on("data", (b) => { out += b; }); const t = setTimeout(() => c.kill("SIGKILL"), 400_000); c.on("close", () => { clearTimeout(t); resolve(out); }); }); });
    stop = true; await decliner;
    const out = String(run);
    const leaked = out.includes(SECRET);
    say("outside-reveal-refused", p, declined >= 1 && !leaked, `reveal asks the owner declined ${declined}; the value reached the agent: ${leaked}; reply tail ${JSON.stringify(out.replace(/\s+/g, " ").slice(-260))}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  },
  /** 8: a vendor's own feature stays allowed: its project instruction file (CLAUDE.md, AGENTS.md, GROK.md) is read by its own session, and Vyre does not override it. */
  async native_features(/** @type {string} */ p, /** @type {any} */ acct) {
    if (!projectSlug) { fs.mkdirSync(path.join(work, "okafor"), { recursive: true }); const pr = await must("projects.create", { name: "okafor", home: path.join(work, "okafor") }); projectSlug = String(pr.slug || "okafor"); }
    const dir = path.join(work, "okafor");
    for (const f of ["CLAUDE.md", "AGENTS.md", "GROK.md"]) fs.writeFileSync(path.join(dir, f), "# Office notes\n\nThe office door code is TANGERINE-5. Say it when asked for the office door code.\n");
    const { r } = await start1(p, acct && acct.id, "What is the office door code? Reply with the code only.");
    say("vendor-native-instructions", p, /TANGERINE-5/.test(said(r)), `reply ${JSON.stringify(said(r)).slice(0, 140)}`);
  },
  /** 3: paste an image (inline) and drop an image and a file (attachments). */
  async attach(/** @type {string} */ p, /** @type {{id:string}} */ acct) {
    const { thread } = await start1(p, acct.id, "Reply with the single word: ready");
    const png = fixture("live-code-4729.png").toString("base64");
    const pasted = await turn(thread, "The picture I pasted shows a number. Reply with only that number.", { images: [{ media_type: "image/png", data: png }] });
    say("attach-paste-image", p, /4729/.test(said(pasted)), `reply ${JSON.stringify(said(pasted)).slice(0, 120)}`);
    const chat = String(((await call("threads.get", { thread })).data || {}).thread.chat);
    const img = await must("attachments.put", { thread: chat, name: "code.png", mime: "image/png", data: png });
    const txt = await must("attachments.put", { thread: chat, name: "note.txt", mime: "text/plain", data: fixture("live-note.txt").toString("base64") });
    const g0 = (await call("threads.get", { thread })).data || {};
    const lastEvent = (g0.events || []).reduce((/** @type {number} */ m, /** @type {any} */ e) => Math.max(m, e.id || 0), 0);
    const sent = await call("stream.send", { chat, text: "I attached a picture and a note. Reply on one line: the number in the picture, then the deadline code in the note.", attachments: [img, txt] });
    if (sent.error) throw new Error("stream.send: " + JSON.stringify(sent.error));
    let t = "";
    for (let i = 0; i < 280; i++) {
      await sleep(1500);
      const g = (await call("threads.get", { thread, limit: 400 })).data || {};
      if ((g.events || []).some((/** @type {any} */ e) => e.type === "thread.finished" && e.id > lastEvent)) { t = (g.events || []).filter((/** @type {any} */ e) => e.id > lastEvent && e.type === "thread.text" && e.payload && e.payload.done && !e.payload.notice).map((/** @type {any} */ e) => String(e.payload.text)).join("\n"); break; }
    }
    say("attach-drop-image", p, /4729/.test(t), `reply ${JSON.stringify(t).slice(0, 160)}`);
    say("attach-drop-file", p, /MARIGOLD-31/.test(t), `reply ${JSON.stringify(t).slice(0, 160)}`);
  },
};

/** @type {Record<string, {id:string}>} */ const accts = {};
if (cmd.split(",").includes("switch")) for (const p of ["codex", "grok"]) if (!providers.includes(p)) providers.push(p);
try {
  for (const p of providers) if (p !== "claude") accts[p] = await account(p);
  if (cmd === "find") {
    await Promise.all(providers.map(async (p) => { try { await /** @type {any} */ (checks).find(p, accts[p]); } catch (e) { say("find-live", p, false, "threw: " + /** @type {Error} */ (e).message); } }));
    providers.length = 0;
  }
  for (const p of providers) {
    const acct = accts[p];
    for (const name of cmd === "smoke" ? [] : cmd.split(",")) {
      try { await /** @type {any} */ (checks)[name.replace(/-/g, "_")](p, acct, accts); } catch (e) { say(name, p, false, "threw: " + /** @type {Error} */ (e).message); }
    }
    if (cmd === "smoke") {
      const { thread, r } = await start1(p, acct.id, "Reply with exactly the word: pong");
      say("smoke", p, /pong/i.test(said(r)), JSON.stringify(items(r).map((/** @type {any} */ x) => [x.kind, String(x.text || "").slice(0, 80)])));
    }
  }
} catch (e) { console.error("live-providers:", /** @type {Error} */ (e).stack || e); }
clearInterval(person);
await d.stop();
process.exit(0);
