// @ts-check
// A fake mail provider for tests: an IMAP server and an SMTP server on 127.0.0.1 port 0, plain
// TCP (the adapter allows plain only to loopback, which is what this fake is for).
//
// Tests must never reach a real mailbox (team rules), and a fake that accepts anything would hide
// the bugs that matter here, so this one keeps the score:
// - `seenChanges` records every STORE and every fetch without .PEEK, so a test can prove that a
//   search or a read left the person's unread mail unread.
// - `mailFromCount` counts MAIL FROM, so a test can prove `test()` never starts a message.
// - `sent` holds each accepted message as `{ from, rcpt, data }`, with dot-stuffing undone, so a
//   test sees exactly what a recipient would.
// - `logins` holds each login attempt, IMAP and SMTP, and `commands` every IMAP command line.
// - `searches` holds the criteria of each UID SEARCH, so a test sees the translation.
// Options: `loginDisabled` (IMAP offers only AUTHENTICATE PLAIN), `smtpAuth` (the mechanisms
// EHLO advertises), `refuseRcpt` (addresses RCPT refuses with 550), `silent` (accept the
// connection and never say a word, for timeouts), `echo` (put what the client sent in failure
// replies, the way a careless server does, to prove the client scrubs it).
// Data is the sample world: alex@harlow.example's inbox, mail from Northwind Bakery.

import net from "node:net";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * @typedef {{ uid: number, from?: string, to?: string, subject?: string, date?: string | Date, body?: string,
 *   html?: string, unread?: boolean, raw?: string }} FakeMessage
 * @typedef {{ user?: string, password?: string, messages?: FakeMessage[], uidvalidity?: number,
 *   smtpAuth?: string[], loginDisabled?: boolean, refuseRcpt?: string[], silent?: boolean, echo?: boolean }} FakeMailOpts
 */

/** @param {Date} d */
const internal = d => {
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};

/** The message as the server stores it: bytes with CRLF line ends. @param {FakeMessage} m */
function rawOf(m) {
  if (m.raw) return Buffer.from(m.raw.replace(/\r?\n/g, "\r\n"), "utf8");
  const d = new Date(m.date || Date.UTC(2026, 8, 1));
  const head = [
    `From: ${m.from || "Dana Reyes <dana@northwind-bakery.example>"}`,
    `To: ${m.to || "alex@harlow.example"}`,
    `Subject: ${m.subject ?? "(none)"}`,
    `Date: ${d.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${m.uid}.fake@northwind-bakery.example>`,
    "MIME-Version: 1.0",
  ];
  let body;
  if (m.html !== undefined && m.body !== undefined) {
    head.push('Content-Type: multipart/alternative; boundary="b1"');
    body = ["--b1", "Content-Type: text/plain; charset=utf-8", "", m.body, "--b1", "Content-Type: text/html; charset=utf-8", "", m.html, "--b1--", ""].join("\r\n");
  } else if (m.html !== undefined) {
    head.push("Content-Type: text/html; charset=utf-8");
    body = m.html;
  } else {
    head.push("Content-Type: text/plain; charset=utf-8");
    body = m.body || "";
  }
  return Buffer.from(`${head.join("\r\n")}\r\n\r\n${body.replace(/\r?\n/g, "\r\n")}`, "utf8");
}

/** Header block and text of a stored message. @param {Buffer} raw */
function split(raw) {
  const i = raw.indexOf("\r\n\r\n");
  return i < 0 ? { head: raw, text: Buffer.alloc(0) } : { head: raw.subarray(0, i + 4), text: raw.subarray(i + 4) };
}

/** Only the named header fields, and the blank line. @param {Buffer} head @param {string[]} names */
function fields(head, names) {
  const want = new Set(names.map(n => n.toLowerCase()));
  const out = [];
  let keep = false;
  for (const line of head.toString("latin1").split("\r\n")) {
    if (!line) continue;
    if (/^[ \t]/.test(line)) { if (keep) out.push(line); continue; }
    keep = want.has(line.slice(0, line.indexOf(":")).trim().toLowerCase());
    if (keep) out.push(line);
  }
  return Buffer.from(out.join("\r\n") + "\r\n\r\n", "latin1");
}

/** Tokens of an IMAP command line: atoms, "strings", literals (already read), and ( lists ) kept as text. */
function tokens(line, literals) {
  const out = [];
  let i = 0, lit = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " ") { i++; continue; }
    if (c === '"') {
      let v = ""; i++;
      while (i < line.length && line[i] !== '"') { if (line[i] === "\\") i++; v += line[i++]; }
      out.push(v); i++;
    } else if (c === "{") {
      i = line.indexOf("}", i) + 1;
      out.push(literals[lit++].toString("utf8"));
    } else if (c === "(") {
      let depth = 0, j = i;
      for (; j < line.length; j++) { if (line[j] === "(") depth++; else if (line[j] === ")" && --depth === 0) break; }
      out.push(line.slice(i, j + 1)); i = j + 1;
    } else {
      let j = i;
      while (j < line.length && line[j] !== " ") {
        if (line[j] === "[") j = line.indexOf("]", j);
        j++;
      }
      out.push(line.slice(i, j)); i = j;
    }
  }
  return out;
}

/** A line reader over a socket, with IMAP literal support. */
function reader(sock) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  const pump = () => {
    while (waiters.length) {
      const w = waiters[0];
      if (w.n < 0) {
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        waiters.shift(); const l = buf.subarray(0, i); buf = buf.subarray(i + 2); w.resolve(l);
      } else {
        if (buf.length < w.n) return;
        waiters.shift(); const b = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.resolve(b);
      }
    }
  };
  sock.on("data", d => { buf = Buffer.concat([buf, d]); pump(); });
  sock.on("close", () => { for (const w of waiters.splice(0)) w.resolve(null); });
  sock.on("error", () => {});
  return {
    /** @returns {Promise<Buffer | null>} */
    line: () => new Promise(resolve => { waiters.push({ n: -1, resolve }); pump(); }),
    /** @returns {Promise<Buffer | null>} */
    bytes: n => new Promise(resolve => { waiters.push({ n, resolve }); pump(); }),
  };
}

/** @param {string} set "3,5:7" @param {number[]} uids */
function inSet(set, uids) {
  const out = new Set();
  const max = Math.max(0, ...uids);
  for (const part of set.split(",")) {
    const [a, b] = part.split(":").map(x => (x === "*" ? max : Number(x)));
    const lo = Math.min(a, b ?? a), hi = Math.max(a, b ?? a);
    for (const u of uids) if (u >= lo && u <= hi) out.add(u);
  }
  return [...out].sort((x, y) => x - y);
}

/** @param {string} s "7-Sep-2026" */
const parseDay = s => {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  return m ? Date.UTC(Number(m[3]), MONTHS.indexOf(m[2]), Number(m[1])) : NaN;
};

/**
 * Start the fake IMAP and SMTP servers; both close when the test ends.
 * @param {import("node:test").TestContext} t @param {FakeMailOpts} [opts]
 */
export async function startFakeMail(t, opts = {}) {
  const user = opts.user ?? "alex@harlow.example";
  const password = opts.password ?? "correct horse battery";
  const uidvalidity = opts.uidvalidity ?? 1712;
  const box = (opts.messages || []).map(m => ({ ...m, seen: !m.unread, bytes: rawOf(m), at: new Date(m.date || Date.UTC(2026, 8, 1)) }));
  const fake = {
    /** @type {{ from: string, rcpt: string[], data: string }[]} */ sent: [],
    /** @type {{ proto: string, user: string, ok: boolean, mech: string }[]} */ logins: [],
    /** @type {string[]} */ seenChanges: [],
    /** @type {string[]} */ commands: [],
    /** @type {string[]} */ searches: [],
    mailFromCount: 0,
    imap: { host: "127.0.0.1", port: 0, tls: /** @type {"none"} */ ("none") },
    smtp: { host: "127.0.0.1", port: 0, tls: /** @type {"none"} */ ("none") },
    /** A full adapter config for this fake. @param {Record<string, any>} [extra] */
    config(extra = {}) {
      return { address: user, imap: { ...fake.imap }, smtp: { ...fake.smtp }, auth: { item: "mail-alex" }, ...extra };
    },
  };
  const sockets = new Set();
  const track = s => { sockets.add(s); s.on("close", () => sockets.delete(s)); };
  const echo = v => (opts.echo ? ` (you sent ${v})` : "");

  const imapServer = net.createServer(async sock => {
    track(sock);
    if (opts.silent) return;
    const rd = reader(sock);
    const say = s => { if (!sock.destroyed) sock.write(typeof s === "string" ? s + "\r\n" : s); };
    const caps = `IMAP4rev1 AUTH=PLAIN${opts.loginDisabled ? " LOGINDISABLED" : ""}`;
    say(`* OK [CAPABILITY ${caps}] fake imap ready`);
    let authed = false, selected = false;
    for (;;) {
      let line = await rd.line();
      if (line === null) return;
      const literals = [];
      let text = line.toString("utf8");
      for (let m; (m = /\{(\d+)(\+?)\}$/.exec(text));) {
        if (!m[2]) say("+ go ahead");
        const lit = await rd.bytes(Number(m[1]));
        if (lit === null) return;
        literals.push(lit);
        const rest = await rd.line();
        if (rest === null) return;
        text = text + "\u0000" + rest.toString("utf8");
      }
      // Literals are marked by {n} followed by our NUL join; the tokenizer consumes them in order.
      const clean = text.replace(/\{\d+\+?\}\u0000/g, "{}");
      fake.commands.push(clean);
      const tk = tokens(clean, literals);
      const tag = tk[0], cmd = String(tk[1] || "").toUpperCase();
      const args = tk.slice(2);
      const ok = (s = "done") => say(`${tag} OK ${s}`);
      if (cmd === "CAPABILITY") { say(`* CAPABILITY ${caps}`); ok(); }
      else if (cmd === "NOOP") ok();
      else if (cmd === "LOGOUT") { say("* BYE see you"); ok(); sock.end(); return; }
      else if (cmd === "LOGIN") {
        if (opts.loginDisabled) { say(`${tag} NO LOGIN is disabled`); continue; }
        const good = args[0] === user && args[1] === password;
        fake.logins.push({ proto: "imap", user: args[0], ok: good, mech: "LOGIN" });
        if (good) { authed = true; ok("logged in"); } else say(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials${echo(args[1])}`);
      } else if (cmd === "AUTHENTICATE" && String(args[0]).toUpperCase() === "PLAIN") {
        say("+ ");
        const b = await rd.line();
        if (b === null) return;
        const [, u, p] = Buffer.from(b.toString("latin1"), "base64").toString("utf8").split("\0");
        const good = u === user && p === password;
        fake.logins.push({ proto: "imap", user: u, ok: good, mech: "PLAIN" });
        if (good) { authed = true; ok("authenticated"); } else say(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials${echo(b.toString("latin1"))}`);
      } else if (!authed) say(`${tag} BAD log in first`);
      else if (cmd === "EXAMINE" || cmd === "SELECT") {
        if (String(args[0]).toUpperCase() !== "INBOX") { say(`${tag} NO no such mailbox`); continue; }
        selected = true;
        say(`* ${box.length} EXISTS`);
        say("* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)");
        say(`* OK [UIDVALIDITY ${uidvalidity}] UIDs valid`);
        say(`* OK [UIDNEXT ${Math.max(0, ...box.map(m => m.uid)) + 1}] next`);
        ok(cmd === "EXAMINE" ? "[READ-ONLY] examined" : "[READ-WRITE] selected");
      } else if (!selected) say(`${tag} BAD select a mailbox first`);
      else if (cmd === "STORE" || (cmd === "UID" && String(args[0]).toUpperCase() === "STORE")) {
        fake.seenChanges.push(clean); ok();
      } else if (cmd === "UID" && String(args[0]).toUpperCase() === "SEARCH") {
        const crit = args.slice(1);
        fake.searches.push(crit.join(" "));
        let list = box.slice();
        for (let i = 0; i < crit.length; i++) {
          const k = String(crit[i]).toUpperCase();
          const has = (s, v) => s.toLowerCase().includes(String(v).toLowerCase());
          const hdr = (m, name) => { const f = fields(split(m.bytes).head, [name]).toString("utf8"); return f.slice(f.indexOf(":") + 1); };
          if (k === "CHARSET") { i++; continue; }
          if (k === "ALL") continue;
          if (k === "UNSEEN") { list = list.filter(m => !m.seen); continue; }
          const v = crit[++i];
          if (k === "FROM" || k === "TO" || k === "SUBJECT") list = list.filter(m => has(hdr(m, k), v));
          else if (k === "TEXT") list = list.filter(m => has(m.bytes.toString("utf8"), v));
          else if (k === "SINCE") { const d = parseDay(v); list = list.filter(m => m.at.getTime() >= d); }
          else { say(`${tag} BAD unknown search key ${k}`); list = null; break; }
        }
        if (!list) continue;
        say(`* SEARCH${list.map(m => " " + m.uid).join("")}`);
        ok();
      } else if (cmd === "UID" && String(args[0]).toUpperCase() === "FETCH") {
        const uids = inSet(String(args[1]), box.map(m => m.uid));
        const spec = String(args[2] || "").replace(/^\(|\)$/g, "");
        const items = spec.match(/BODY(?:\.PEEK)?\[[^\]]*\](?:<\d+\.\d+>)?|[A-Z0-9.]+/gi) || [];
        for (const uid of uids) {
          const m = box.find(x => x.uid === uid);
          if (!m) continue;
          const parts = [Buffer.from(`* ${box.indexOf(m) + 1} FETCH (UID ${uid}`, "latin1")];
          for (const item of items) {
            const u = item.toUpperCase();
            if (u === "UID") continue;
            if (u === "INTERNALDATE") parts.push(Buffer.from(` INTERNALDATE "${internal(m.at)}"`));
            else if (u === "FLAGS") parts.push(Buffer.from(` FLAGS (${m.seen ? "\\Seen" : ""})`));
            else if (u === "RFC822.SIZE") parts.push(Buffer.from(` RFC822.SIZE ${m.bytes.length}`));
            else if (u.startsWith("BODY")) {
              const x = /^BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i.exec(item);
              if (!x) continue;
              if (!x[1]) { fake.seenChanges.push(`${uid} ${item}`); m.seen = true; }
              const sec = x[2].toUpperCase();
              const { head, text } = split(m.bytes);
              let data = sec === "" ? m.bytes : sec === "TEXT" ? text : sec === "HEADER" ? head
                : sec.startsWith("HEADER.FIELDS") ? fields(head, sec.replace(/^HEADER\.FIELDS\s*\(|\)$/g, "").trim().split(/\s+/)) : Buffer.alloc(0);
              let name = `BODY[${x[2]}]`;
              if (x[3] !== undefined) { data = data.subarray(Number(x[3]), Number(x[3]) + Number(x[4])); name += `<${x[3]}>`; }
              parts.push(Buffer.from(` ${name} {${data.length}}\r\n`, "latin1"), data);
            } else if (u === "RFC822" || u === "RFC822.TEXT") {
              fake.seenChanges.push(`${uid} ${item}`); m.seen = true;
              parts.push(Buffer.from(` ${u} {${m.bytes.length}}\r\n`), m.bytes);
            }
          }
          parts.push(Buffer.from(")\r\n"));
          say(Buffer.concat(parts));
        }
        ok();
      } else say(`${tag} BAD unknown command`);
    }
  });

  const mechs = (opts.smtpAuth || ["PLAIN", "LOGIN"]).join(" ");
  const smtpServer = net.createServer(async sock => {
    track(sock);
    if (opts.silent) return;
    const rd = reader(sock);
    const say = s => { if (!sock.destroyed) sock.write(s + "\r\n"); };
    say("220 fake.northwind-bakery.example ESMTP ready");
    let authed = false, from = "", rcpt = [];
    const check = (u, p, mech, sent) => {
      const good = u === user && p === password;
      fake.logins.push({ proto: "smtp", user: u, ok: good, mech });
      if (good) { authed = true; say("235 2.7.0 accepted"); } else say(`535 5.7.8 bad credentials${echo(sent)}`);
    };
    for (;;) {
      const l = await rd.line();
      if (l === null) return;
      const line = l.toString("utf8");
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "EHLO") say(`250-fake.northwind-bakery.example hello\r\n250-AUTH ${mechs}\r\n250 8BITMIME`);
      else if (verb === "HELO") say("250 hello");
      else if (verb === "NOOP") say("250 ok");
      else if (verb === "QUIT") { say("221 bye"); sock.end(); return; }
      else if (verb === "RSET") { from = ""; rcpt = []; say("250 ok"); }
      else if (verb === "AUTH") {
        const [, mech, initial] = line.split(" ");
        const m = String(mech).toUpperCase();
        if (!mechs.split(" ").includes(m)) { say("504 5.5.4 mechanism not offered"); continue; }
        if (m === "PLAIN") {
          let b = initial;
          if (!b) { say("334 "); const x = await rd.line(); if (x === null) return; b = x.toString("latin1"); }
          const [, u, p] = Buffer.from(b, "base64").toString("utf8").split("\0");
          check(u, p, "PLAIN", b);
        } else {
          say("334 VXNlcm5hbWU6");
          const u = await rd.line(); if (u === null) return;
          say("334 UGFzc3dvcmQ6");
          const p = await rd.line(); if (p === null) return;
          check(Buffer.from(u.toString("latin1"), "base64").toString("utf8"), Buffer.from(p.toString("latin1"), "base64").toString("utf8"), "LOGIN", p.toString("latin1"));
        }
      } else if (verb === "MAIL") {
        fake.mailFromCount++;
        if (!authed) { say("530 5.7.0 authentication required"); continue; }
        from = (/<([^>]*)>/.exec(line) || [])[1] || ""; rcpt = [];
        say("250 2.1.0 ok");
      } else if (verb === "RCPT") {
        const a = (/<([^>]*)>/.exec(line) || [])[1] || "";
        if (!from) { say("503 5.5.1 MAIL first"); continue; }
        if ((opts.refuseRcpt || []).map(x => x.toLowerCase()).includes(a.toLowerCase())) { say(`550 5.1.1 <${a}> no such user`); continue; }
        rcpt.push(a); say("250 2.1.5 ok");
      } else if (verb === "DATA") {
        if (!rcpt.length) { say("503 5.5.1 RCPT first"); continue; }
        say("354 go ahead");
        const lines = [];
        for (;;) {
          const d = await rd.line();
          if (d === null) return;
          const s = d.toString("utf8");
          if (s === ".") break;
          lines.push(s.startsWith(".") ? s.slice(1) : s);
        }
        fake.sent.push({ from, rcpt, data: lines.join("\r\n") });
        from = ""; rcpt = [];
        say("250 2.0.0 queued");
      } else say("502 5.5.2 unknown command");
    }
  });

  const listen = srv => new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(/** @type {net.AddressInfo} */ (srv.address()).port));
  });
  fake.imap.port = await listen(imapServer);
  fake.smtp.port = await listen(smtpServer);
  t.after(() => {
    for (const s of sockets) s.destroy();
    return Promise.all([imapServer, smtpServer].map(s => new Promise(r => s.close(() => r(undefined)))));
  });
  return fake;
}
