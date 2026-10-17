// @ts-check
// The Vyre Mac app's own window, driven the way a person would use it: find what is on screen by its words, click it with a real mouse event, type into the focused field. It speaks the app's driven mode
// (local/capsule/native/Sources/Agent/AgentDrive.swift, started only in a test home) over the app's stdin and stdout, one JSON line each way. TEST ONLY: never started on a person's Mac.
import { spawn } from "node:child_process";
import readline from "node:readline";

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

export class MacPage {
  /** @param {string} bin the app's executable @param {Record<string, string>} env */
  constructor(bin, env) {
    this.child = spawn(bin, [], { env: { ...process.env, ...env, VYRE_CAPSULE_DRIVE: "1", VYRE_CAPSULE_TEST: "1" }, stdio: ["pipe", "pipe", "inherit"] });
    /** @type {((m: any) => void)[]} */ this.waiting = [];
    this.exited = /** @type {number | null} */ (null);
    this.child.on("exit", c => { this.exited = c ?? -1; for (const w of this.waiting.splice(0)) w({ error: `the app exited (${c})` }); });
    readline.createInterface({ input: /** @type {any} */ (this.child.stdout) }).on("line", l => {
      let m; try { m = JSON.parse(l); } catch { return; }
      if (m && m.ready) { this.ready = true; return; }
      const w = this.waiting.shift(); if (w) w(m);
    });
    this.ready = false;
  }
  async started(ms = 30_000) { const end = Date.now() + ms; while (!this.ready) { if (this.exited !== null) throw new Error(`the app exited (${this.exited}) before it was ready`); if (Date.now() > end) throw new Error("the app did not report ready"); await sleep(100); } }
  /** @param {any} cmd @param {number} [ms] */
  send(cmd, ms = 30_000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no answer to ${JSON.stringify(cmd).slice(0, 120)}`)), ms);
      this.waiting.push(m => { clearTimeout(t); res(m); });
      this.child.stdin?.write(JSON.stringify(cmd) + "\n");
    });
  }
  async open() { const r = /** @type {any} */ (await this.send({ web: "open" })); if (r.error) throw new Error(r.error); return r; }
  /** Runs a function or a statement list in the page and returns what it returned. @param {Function | string} what @param {any} [arg] */
  async evaluate(what, arg) {
    const js = typeof what === "function" ? `return (${what.toString()})(${JSON.stringify(arg ?? null)});` : what;
    const r = /** @type {any} */ (await this.send({ web: "eval", js }));
    if (r.error) throw new Error(String(r.error).slice(0, 300));
    return r.value === undefined || r.value === null ? null : JSON.parse(r.value);
  }
  async text() { return String(await this.evaluate(() => document.body.innerText) || ""); }
  /** The screen's point for the element whose own text is `text` (a button, a choice), a field by its placeholder or its label, or a control by its aria-label. */
  async find(/** @type {"text" | "field" | "aria"} */ kind, /** @type {string} */ text, timeout = 30_000) {
    const end = Date.now() + timeout;
    for (;;) {
      const pt = await this.evaluate(({ kind, text }) => {
        const all = [...document.querySelectorAll("*")];
        /** @type {Element | null} */ let el = null;
        const own = (/** @type {Element} */ e) => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim();
        if (kind === "text") el = all.filter(e => own(e) === text)[0] || all.filter(e => own(e).startsWith(text))[0] || null;
        else if (kind === "aria") el = document.querySelector(`[aria-label="${text.replace(/"/g, '\\"')}"]`);
        else {
          const inputs = [...document.querySelectorAll("input, textarea")];
          el = inputs.find(i => i.getAttribute("placeholder") === text || i.getAttribute("aria-label") === text || i.getAttribute("name") === text) || null;
          if (!el) { const label = all.find(e => own(e) === text && !/^(input|textarea)$/i.test(e.tagName)); const box = label && label.closest("div"); el = box ? box.querySelector("input, textarea") : null; if (!el && label && label.parentElement) el = label.parentElement.parentElement && label.parentElement.parentElement.querySelector("input, textarea"); }
        }
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      }, { kind, text });
      if (pt) return pt;
      if (Date.now() > end) throw new Error(`no ${kind} "${text}" on the screen within ${timeout / 1000} s`);
      await sleep(400);
    }
  }
  /** @param {{ x: number, y: number }} p */
  async clickAt(p) { const r = /** @type {any} */ (await this.send({ web: "click", x: p.x, y: p.y })); if (!r.ok) throw new Error("the click did not go through"); await sleep(250); }
  async click(/** @type {string} */ text, timeout = 30_000) { await this.clickAt(await this.find("text", text, timeout)); }
  async clickAria(/** @type {string} */ label, timeout = 30_000) { await this.clickAt(await this.find("aria", label, timeout)); }
  /** Click the field, then type into it as the keyboard would. @param {string} field @param {string} value */
  async fill(field, value, timeout = 30_000) {
    await this.clickAt(await this.find("field", field, timeout));
    await this.evaluate((v) => { const e = /** @type {any} */ (document.activeElement); if (e && e.select) e.select(); document.execCommand("insertText", false, v); return true; }, value);
    await sleep(250);
  }
  /** Wait until the screen's words include `text`. @returns {Promise<string>} the screen's text */
  async waitFor(/** @type {string} */ text, timeout = 30_000) {
    const end = Date.now() + timeout; let last = "";
    for (;;) { last = await this.text(); if (last.replace(/\s+/g, " ").includes(text)) return last; if (Date.now() > end) throw new Error(`"${text}" never showed (${timeout / 1000} s). The screen says: ${last.replace(/\s+/g, " ").slice(0, 300)}`); await sleep(400); }
  }
  /** @param {string} file */
  async shot(file) { await this.send({ web: "shot", path: file }, 15_000).catch(() => {}); }
  stop() { try { this.child.kill("SIGTERM"); } catch { /* gone */ } }
}
