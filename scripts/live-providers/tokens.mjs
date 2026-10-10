// @ts-check
// The token proof on real subscriptions (R031-00n, live): the standard tasks of scripts/lib/token-proof.js run as the assistant juno, each in a fresh thread, on Claude Code and on Codex (and
// Grok), in the world scripts/token-proof-world.mjs seeds. Called by `token-proof-world.mjs live`. Correctness is the proof's own (the right tool was called and returned without an error, and
// the answer holds the seeded fact); the calls are read at the registry (what the daemon was asked by a model session), so every provider is judged the same way. Tokens and time come from the
// thread's own usage events. No API key: Claude on the person's subscription token, Codex and Grok on their signed-in accounts.
import fs from "node:fs";
import path from "node:path";

/** @param {{ args: string[], flag: (n: string, d?: string) => string, d: any, call: (t: string, i?: any) => Promise<any>, must: (t: string, i?: any) => Promise<any>, clearTodos: () => Promise<number>, teammateAgent: () => string | null, home: string }} ctx */
export async function tokensMain(ctx) {
  const { flag, d, call, must, clearTodos, teammateAgent } = ctx;
  const { TASKS, used } = await import("../lib/token-proof.js");
  const providers = flag("providers", "claude,codex").split(",").filter(Boolean);
  const ids = flag("only") ? flag("only").split(",") : ["recall", "todo", "record", "flow", "connection", "vault", "file", "teammate", "doc", "skill"];
  const out = flag("out", fs.mkdtempSync(`${ctx.home}-live-`)); fs.mkdirSync(out, { recursive: true });
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

  /** @type {Record<string, string | undefined>} */ const accounts = {};
  for (const p of providers) {
    if (p === "claude") continue;
    const src = flag(`${p}-home`);
    if (!src) throw new Error(`--${p}-home is required`);
    const a = await must("sessions.accounts.add", { provider: p, label: `live-${p}`, kind: "login", is_default: true });
    const id = String(a.id || (a.account && a.account.id));
    const dest = path.join(ctx.home, "accounts", id);
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    const dir = p === "codex" ? ".codex" : ".grok";
    fs.cpSync(path.join(src, dir), path.join(dest, dir), { recursive: true });
    accounts[p] = id;
  }

  // What the daemon was asked by a model session, with whether it answered without an error.
  /** @type {{ name: string, ok: boolean, caller: string }[]} */ let seen = [];
  const orig = d.registry.call.bind(d.registry);
  d.registry.call = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => {
    const r = await orig(tool, input, caller, meta);
    if (/^(mcp|harness)/.test(String(caller || ""))) seen.push({ name: tool, ok: !(r && r.error), caller: String(caller) });
    return r;
  };

  /** Answer the asks of the proof's own thread as the person would: a Vyre tool is allowed, anything else is refused. */
  let allowed = 0, refused = 0; const done = new Set();
  const person = setInterval(async () => {
    try {
      const r = await orig("threads.asks", {}, "cli");
      for (const a of Array.isArray(r.data) ? r.data : []) {
        const id = a.id || a.ask; if (!id || done.has(id)) continue; done.add(id);
        const mine = a.kind === "permission" && /vyre/i.test(String(a.tool || a.title || ""));
        await orig("threads.answer", mine ? { ask: id, decision: "allow" } : { ask: id, decision: "deny", message: "not part of the proof" }, "cli");
        if (mine) allowed++; else refused++;
      }
    } catch { /* next tick */ }
  }, 300);
  person.unref();

  /** @type {any[]} */ const rows = [];
  for (const task of TASKS.filter((t) => ids.includes(t.id))) for (const p of providers) {
    const tm = teammateAgent();
    if (tm) { await call("agents.stop", { agent: tm }); for (const th of ((await call("agents.threads", { agent: tm })).data || []).map((/** @type {any} */ x) => x.id || x.thread)) if (th) await call("threads.delete", { thread: th }); }
    await call("agents.stop", { agent: "juno" });
    for (const th of ((await call("agents.threads", { agent: "juno" })).data || []).map((/** @type {any} */ x) => x.id || x.thread)) if (th) await call("threads.delete", { thread: th });
    await clearTodos();
    seen = [];
    const t0 = Date.now();
    let thread = "", error = "";
    try {
      const t = await must("threads.start", { agent: "juno", provider: p, ...(accounts[p] ? { account: accounts[p] } : {}), purpose: "agent" });
      thread = String(t.id || t.thread);
      const g0 = (await call("threads.get", { thread, limit: 400 })).data || {};
      const after = (g0.events || []).reduce((/** @type {number} */ m, /** @type {any} */ e) => Math.max(m, e.id || 0), 0);
      await must("threads.send", { thread, text: task.prompt, surface: "deck" });
      let g = null;
      for (let i = 0; i < 400; i++) {
        await sleep(1500);
        g = (await call("threads.get", { thread, limit: 600 })).data || {};
        if ((g.events || []).some((/** @type {any} */ e) => e.type === "thread.finished" && e.id > after)) break;
      }
      await sleep(1000);
      g = (await call("threads.get", { thread, limit: 600 })).data || {};
      const ev = (g.events || []).filter((/** @type {any} */ e) => e.id > after);
      const text = ev.filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload && e.payload.done && !e.payload.notice).map((/** @type {any} */ e) => String(e.payload.text)).join("\n");
      const usage = ev.filter((/** @type {any} */ e) => e.type === "thread.usage" && e.payload && e.payload.tokens).map((/** @type {any} */ e) => e.payload.tokens);
      const sum = (/** @type {string} */ k) => usage.reduce((/** @type {number} */ a, /** @type {any} */ u) => a + (Number(u[k]) || 0), 0);
      const max = (/** @type {string} */ k) => usage.reduce((/** @type {number} */ a, /** @type {any} */ u) => Math.max(a, Number(u[k]) || 0), 0);
      const fin = ev.find((/** @type {any} */ e) => e.type === "thread.finished");
      const calls = seen.map((c) => ({ name: c.name, ok: c.ok }));
      const toolOk = used(calls, task.tools), answerOk = !task.answer || task.answer.test(text);
      rows.push({ task: task.id, provider: p, pass: Boolean(toolOk && answerOk && text.trim()), toolOk, answerOk, ms: Date.now() - t0, calls: calls.length, tools: [...new Set(calls.map((c) => c.name))].slice(0, 8),
        tokens: { input_sum: sum("input"), output_sum: sum("output"), cache_read_sum: sum("cache_read"), cache_write_sum: sum("cache_write"), input_max: max("input"), output_max: max("output"), events: usage.length },
        cost_usd: fin && fin.payload ? fin.payload.cost_usd : null, ok_finished: fin ? fin.payload.ok !== false : false, text: text.slice(0, 160) });
    } catch (e) { error = /** @type {Error} */ (e).message; rows.push({ task: task.id, provider: p, pass: false, error }); }
    console.log(JSON.stringify(rows[rows.length - 1]));
    fs.writeFileSync(path.join(out, "rows.json"), JSON.stringify(rows, null, 1));
    if (thread) await call("threads.stop", { thread }).catch(() => {});
  }
  clearInterval(person);
  /** @type {Record<string, any>} */ const summary = {};
  for (const p of providers) {
    const r = rows.filter((x) => x.provider === p);
    summary[p] = { tasks: r.length, passed: r.filter((x) => x.pass).length, seconds: Math.round(r.reduce((a, x) => a + (x.ms || 0), 0) / 1000), calls: r.reduce((a, x) => a + (x.calls || 0), 0),
      input_tokens: r.reduce((a, x) => a + ((x.tokens && x.tokens.input_sum) || 0) + ((x.tokens && x.tokens.cache_read_sum) || 0) + ((x.tokens && x.tokens.cache_write_sum) || 0), 0), output_tokens: r.reduce((a, x) => a + ((x.tokens && x.tokens.output_sum) || 0), 0), failed: r.filter((x) => !x.pass).map((x) => x.task) };
  }
  console.log("SUMMARY " + JSON.stringify(summary));
  console.log(`asks the proof answered for the person: ${allowed} allowed, ${refused} refused; rows in ${path.join(out, "rows.json")}`);
  return 0;
}
