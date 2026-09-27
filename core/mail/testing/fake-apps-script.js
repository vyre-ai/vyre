// @ts-check
// A fake Apps Script web app for tests, on 127.0.0.1 port 0. Tests never reach Google.
//
// It runs the real core/mail/apps-script.gs in node:vm against a stub Gmail built from
// `messages`, so what the adapter talks to is the script the person pastes, not a second copy of
// its logic. Around it, the HTTP side imitates Google: a POST to the exec path answers a 302 to
// /macros/echo?id=... on the same origin, and a GET there returns the script's JSON once.
//
// What it records, so a test can prove the rules:
// - `posts`: every POST body, without its token.
// - `postUrls`: every POST's URL, which must never carry the token.
// - `echoGets`: every request to the echo path (method, url, headers, body), which must never
//   carry the token or a body.
// - `sent`: every email the stub Gmail sent or replied with.
// Failure modes: `html` answers Google's sign-in HTML, `redirectTo` sends the 302 to another
// origin, `slow` waits that many ms before answering, `huge` makes the echo answer 3 MB,
// `redirect: false` answers the POST directly.
// Sample world: alex@harlow.example's mailbox and dana@northwind-bakery.example.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";

const SRC = fs.readFileSync(new URL("../apps-script.gs", import.meta.url), "utf8");

/**
 * @typedef {{ id: string, thread_id: string, from: string, to: string, cc?: string, subject: string,
 *   date: string, message_id: string, body: string, attachments?: string[], unread?: boolean, reply_to?: string }} FakeMessage
 * @typedef {{ kind: "send" | "reply", to: string, cc: string, bcc: string, subject: string, body: string, thread_id?: string, in_reply_to?: string }} FakeSent
 */

/** Sample messages: Dana writing to Alex, and Alex's answer. */
export function sampleMessages() {
  return [
    { id: "18f0a1", thread_id: "t-order", from: "Dana Reyes <dana@northwind-bakery.example>", to: "alex@harlow.example",
      subject: "Order for Friday", date: "2026-09-20T09:00:00.000Z", message_id: "<order-1@northwind-bakery.example>",
      body: "Hi Alex, can we move the Friday order to 40 loaves? Dana", attachments: ["order.pdf"], unread: true },
    { id: "18f0a2", thread_id: "t-lease", from: "Alex Harlow <alex@harlow.example>", to: "dana@northwind-bakery.example",
      subject: "Lease draft", date: "2026-09-21T15:30:00.000Z", message_id: "<lease-1@harlow.example>",
      body: "Dana, the lease draft is attached. Alex", attachments: [] },
    { id: "18f0a3", thread_id: "t-order", from: "Dana Reyes <dana@northwind-bakery.example>", to: "alex@harlow.example",
      cc: "ops@northwind-bakery.example", subject: "Re: Order for Friday", date: "2026-09-22T08:15:00.000Z",
      message_id: "<order-2@northwind-bakery.example>", body: "Also, rye instead of spelt please.", attachments: [] },
  ];
}

/**
 * Load apps-script.gs into a fresh vm context with stub Gmail, Session, PropertiesService and
 * ContentService. `doPost(obj)` runs the script's doPost and returns the parsed JSON it answered.
 * @param {{ token?: string | null, address: string, messages: FakeMessage[], sent?: FakeSent[] }} o
 */
export function loadScript(o) {
  const sent = o.sent || [];
  const msgs = o.messages;
  const byDate = (a, b) => Date.parse(a.date) - Date.parse(b.date);

  const threadOf = id => ({
    getId: () => id,
    getMessages: () => msgs.filter(m => m.thread_id === id).sort(byDate).map(wrap),
  });
  /** @param {FakeMessage} m */
  function wrap(m) {
    return {
      getId: () => m.id,
      getThread: () => threadOf(m.thread_id),
      getFrom: () => m.from,
      getTo: () => m.to,
      getCc: () => m.cc || "",
      getReplyTo: () => m.reply_to || "",
      getSubject: () => m.subject,
      getDate: () => new Date(m.date),
      getPlainBody: () => m.body,
      getHeader: name => (name === "Message-ID" ? m.message_id : ""),
      getAttachments: () => (m.attachments || []).map(n => ({ getName: () => n })),
      reply: (body, opts = {}) => {
        sent.push({ kind: "reply", to: m.reply_to || m.from, cc: opts.cc || "", bcc: opts.bcc || "",
          subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, body, thread_id: m.thread_id, in_reply_to: m.message_id });
      },
    };
  }
  /** A small Gmail query: rfc822msgid:, from:, to:, subject:, is:unread, other words anywhere. */
  function matches(m, q) {
    for (const [, key, val, word] of String(q).matchAll(/(\w+):(\S+)|(\S+)/g)) {
      const v = String(val || word).toLowerCase();
      if (key === "rfc822msgid") { if (m.message_id.replace(/^<|>$/g, "").toLowerCase() !== v.replace(/^<|>$/g, "")) return false; }
      else if (key === "from" || key === "to" || key === "subject") { if (!String(m[key]).toLowerCase().includes(v)) return false; }
      else if (key === "is") { if (v === "unread" && !m.unread) return false; }
      else if (key === "newer_than") continue;
      else if (!`${m.from} ${m.to} ${m.subject} ${m.body}`.toLowerCase().includes(String(word || `${key}:${val}`).toLowerCase())) return false;
    }
    return true;
  }
  const GmailApp = {
    search(q, start, max) {
      const hits = msgs.filter(m => matches(m, q));
      const latest = new Map();
      for (const m of hits) { const cur = latest.get(m.thread_id); if (!cur || byDate(cur, m) < 0) latest.set(m.thread_id, m); }
      return [...latest.values()].sort((a, b) => byDate(b, a)).slice(start, start + max).map(m => threadOf(m.thread_id));
    },
    getMessageById(id) { const m = msgs.find(x => x.id === id); if (!m) throw new Error("Invalid argument: id"); return wrap(m); },
    sendEmail(to, subject, body, opts = {}) { sent.push({ kind: "send", to, cc: opts.cc || "", bcc: opts.bcc || "", subject, body }); },
  };
  const ContentService = {
    MimeType: { JSON: "application/json" },
    createTextOutput(s) { const out = { content: s, mime: "", setMimeType(t) { out.mime = t; return out; }, getContent: () => s }; return out; },
  };
  const ctx = vm.createContext({
    GmailApp,
    ContentService,
    Session: { getEffectiveUser: () => ({ getEmail: () => o.address }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k === "VYRE_TOKEN" ? o.token ?? null : null) }) },
  });
  vm.runInContext(SRC, ctx, { filename: "apps-script.gs" });
  return {
    sent,
    /** @param {string} contents the raw POST body */
    raw(contents) { return ctx.doPost({ postData: { contents, type: "application/json" } }); },
    /** @param {unknown} body */
    doPost(body) {
      const out = ctx.doPost({ postData: { contents: JSON.stringify(body), type: "application/json" } });
      return { json: JSON.parse(out.getContent()), mime: out.mime };
    },
  };
}

/**
 * Start the fake. It closes when the test ends.
 * @param {{ after: (fn: () => any) => void }} t
 * @param {{ token: string, address: string, messages?: FakeMessage[], redirect?: boolean, html?: boolean,
 *   redirectTo?: string, slow?: number, huge?: boolean }} o
 */
export async function startFakeAppsScript(t, { token, address, messages = sampleMessages(), redirect = true, html = false, redirectTo, slow = 0, huge = false }) {
  /** @type {FakeSent[]} */ const sent = [];
  /** @type {any[]} */ const posts = [];
  /** @type {string[]} */ const postUrls = [];
  /** @type {{ method: string, url: string, headers: Record<string, any>, body: string }[]} */ const echoGets = [];
  const script = loadScript({ token, address, messages, sent });
  /** @type {Map<string, string>} */ const echoes = new Map();
  const execPath = "/macros/s/AKfycbFakeDeployment0123456789/exec";

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const u = new URL(req.url || "/", "http://fake");
      if (u.pathname === "/macros/echo") {
        echoGets.push({ method: req.method || "", url: req.url || "", headers: { ...req.headers }, body: raw });
        const id = u.searchParams.get("id") || "";
        const content = echoes.get(id);
        echoes.delete(id);
        if (huge) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, data: "x".repeat(3 * 1024 * 1024) })); return; }
        if (content === undefined) { res.writeHead(404, { "content-type": "text/html" }); res.end("<html><body>Sorry, unable to open the file at this time.</body></html>"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(content);
        return;
      }
      if (req.method !== "POST" || u.pathname !== execPath) { res.writeHead(404); res.end(); return; }
      postUrls.push(req.url || "");
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      if (parsed && typeof parsed === "object") { const { token: _t, ...rest } = parsed; posts.push(rest); } else posts.push(parsed);
      if (slow) await new Promise(r => setTimeout(r, slow));
      if (res.destroyed) return;
      if (html) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html><head><title>Sign in - Google Accounts</title></head><body>Sign in to continue</body></html>");
        return;
      }
      const content = script.raw(raw).getContent();
      if (!redirect) { res.writeHead(200, { "content-type": "application/json" }); res.end(content); return; }
      const id = crypto.randomBytes(12).toString("hex");
      echoes.set(id, content);
      res.writeHead(302, { location: `${redirectTo || ""}/macros/echo?id=${id}&lib=fake` });
      res.end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${addr.port}`;
  t.after(() => new Promise(r => { server.closeAllConnections?.(); server.close(() => r(undefined)); }));
  return { url: origin + execPath, origin, sent, posts, postUrls, echoGets, messages };
}
