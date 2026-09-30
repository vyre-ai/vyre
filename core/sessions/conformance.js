// @ts-check
// The session provider contract (ADR 0030), and the test every provider must pass.
//
// A provider is a driver the Switchboard runs sessions on: Claude Code (built in, on the Agent
// SDK or the CLI), or one a module adds later (Codex, an ACP agent) with no change to the core:
//
//   module.json   "does": { "providers": ["codex"] }
//   start(ctx)    ctx.provider("codex", { id: "codex", capabilities: {...}, run(o) { ... } })
//   a session     threads.start { provider: "codex", ... }
//
// run(o) starts one session and returns { pid, alive, write(obj), stop(grace), interrupt(), setMode?(mode) }.
//   o: { id, resume, cwd, env, model, system: {mode, text}|null, name, budgetUsd, tools, settings,
//        subreaper, uid, gid, onSpawn({pid, pgid, sid}), onMessage(m), onExit(code, signal, stderr) }
//   write takes { type: "user", message: { role: "user", content } } for a turn and
//   { type: "control_response", response: { request_id, response: {behavior, ...} } } for an answer.
//   onMessage gets the session wire messages the Switchboard reads (translate.js):
//     { type: "system", subtype: "init", session_id, model }
//     { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } }
//     { type: "assistant", message: { id, content: [{ type: "text"|"tool_use"|"thinking", ... }] } }
//     { type: "user", message: { content: [{ type: "tool_result", tool_use_id, is_error }] } }
//     { type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name, input, tool_use_id } }
//     { type: "control_cancel_request", request_id }
//     { type: "rate_limit_event", rate_limit_info }
//     { type: "result", is_error, result, total_cost_usd, usage }
//   Every process a session runs is spawned through core/sessions/spawn.js (spawnSession), so the
//   peer check sees it: onSpawn before the process can run a tool.
//
// conform() drives a provider through the scenario below against its own test double, which must
// answer these prompts as core/switchboard/testing/fake-claude.js does: any text is echoed as
// "echo: <text>"; "bash <command>" asks permission for Bash and says "Ran it." or "I was not
// allowed to."; an interrupt withdraws an open question and ends the turn.

import { groupAlive } from "./spawn.js";

/**
 * @param {{ run: (o: any) => any, capabilities?: any }} provider
 * @param {{ id: string, cwd: string, env: Record<string, string|undefined>, timeout?: number, extra?: any }} o
 * @returns {Promise<string[]>} what failed; empty means the provider conforms
 */
export async function conform(provider, o) {
  const fails = [];
  const ms = o.timeout || 15_000;
  /** @param {boolean} ok @param {string} what */
  const check = (ok, what) => { if (!ok) fails.push(what); return ok; };

  /** One session, with its messages collected and a way to wait for one. */
  const open = resume => {
    /** @type {any[]} */ const got = [];
    /** @type {{ test: (m: any) => boolean, resolve: (m: any) => void }[]} */ const waits = [];
    /** @type {any} */ let group = null;
    let spawnedBeforeFirst = null, exited = null;
    const proc = provider.run({ id: o.id, resume, cwd: o.cwd, env: o.env, ...(o.extra || {}),
      onSpawn: g => { group = g; },
      onMessage: m => {
        if (spawnedBeforeFirst === null) spawnedBeforeFirst = Boolean(group);
        got.push(m);
        for (const w of [...waits]) if (w.test(m)) { waits.splice(waits.indexOf(w), 1); w.resolve(m); }
      },
      onExit: (code, signal) => { exited = { code, signal }; } });
    const wait = (test, what) => new Promise((resolve, reject) => {
      const found = got.find(test);
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      waits.push({ test, resolve: m => { clearTimeout(t); resolve(m); } });
    });
    const since = n => got.slice(n);
    return { proc, got, wait, since, get group() { return group; }, get spawnedBeforeFirst() { return spawnedBeforeFirst; }, get exited() { return exited; } };
  };
  const user = text => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: o.id });
  const results = s => s.got.filter(m => m.type === "result").length;

  const s = open(false);
  try {
    // 1. A turn streams: init with the session's id, text deltas, one result.
    s.proc.write(user("hello"));
    const init = await s.wait(m => m.type === "system" && m.subtype === "init", "system init");
    check(init.session_id === o.id, "init carries the session id it was started with");
    await s.wait(m => m.type === "result", "the first result");
    const text = s.got.filter(m => m.type === "stream_event" && m.event && m.event.delta && m.event.delta.type === "text_delta").map(m => m.event.delta.text).join("");
    check(text === "echo: hello", `text streams as deltas (got "${text}")`);
    check(Boolean(s.group && s.group.pid && s.group.pgid && s.group.sid), "onSpawn reports pid, pgid and sid");
    check(s.spawnedBeforeFirst === true, "onSpawn comes before the first message");
    check(s.proc.pid === (s.group && s.group.pid), "the session's pid is the spawned one");

    // 2. A permission question, answered, reaches the tool.
    let n = s.got.length;
    s.proc.write(user("bash npm test"));
    const ask = await s.wait(m => m.type === "control_request" && m.request && m.request.subtype === "can_use_tool", "a permission question");
    check(ask.request.tool_name === "Bash" && ask.request.input && ask.request.input.command === "npm test", "the question names the tool and its input");
    s.proc.write({ type: "control_response", response: { subtype: "success", request_id: ask.request_id, response: { behavior: "allow", updatedInput: ask.request.input } } });
    await s.wait(m => m.type === "result" && results(s) >= 2, "the answered turn's result");
    check(s.since(n).some(m => m.type === "user" && m.message && Array.isArray(m.message.content) && m.message.content.some(b => b.type === "tool_result")), "the tool ran after an allow");

    // 3. Interrupt withdraws an open question and ends the turn; the session stays.
    n = s.got.length;
    s.proc.write(user("bash rm -rf build"));
    const ask2 = await s.wait(m => m.type === "control_request" && m.request_id !== ask.request_id && m.request && m.request.subtype === "can_use_tool", "a second question");
    await s.proc.interrupt();
    await s.wait(m => m.type === "control_cancel_request" && m.request_id === ask2.request_id, "the question withdrawn");
    await s.wait(m => m.type === "result" && results(s) >= 3, "the interrupted turn's end");
    check(s.proc.alive, "the session outlives an interrupt");
    s.proc.write(user("again"));
    await s.wait(m => m.type === "result" && results(s) >= 4, "a turn after the interrupt");

    // 4. Stop ends the whole process group.
    const pgid = s.group && s.group.pgid;
    await s.proc.stop(3000);
    check(!s.proc.alive && s.exited !== null, "stop ends the session and reports the exit");
    await new Promise(r => setTimeout(r, 200));
    check(!groupAlive(pgid), "stop takes the whole process group");
  } catch (e) { fails.push(String(/** @type {Error} */ (e).message)); try { await s.proc.stop(1000); } catch {} return fails; }

  // 5. Resume: the same session id comes back.
  const r = open(true);
  try {
    r.proc.write(user("back"));
    const init = await r.wait(m => m.type === "system" && m.subtype === "init", "init on resume");
    check(init.session_id === o.id, "a resumed session keeps its id");
    await r.wait(m => m.type === "result", "the resumed turn");
  } catch (e) { fails.push(String(/** @type {Error} */ (e).message)); }
  finally { await r.proc.stop(2000); }
  return fails;
}
