// @ts-check
// Fake IMAP and SMTP servers for the mail module's tests: 127.0.0.1, port 0, a self-signed
// certificate openssl makes at run time (no key is ever in the repo). They speak just enough of
// each protocol to exercise the clients, record what the client said, and never relay anything.

import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Wire } from "../wire.js";
import { parse } from "../imap.js";
import { SCRATCH } from "../../../test/scratch.mjs";

export const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** @type {{ cert: string, key: string } | null} */
let made = null;
/** A certificate for 127.0.0.1, made once per process. */
export function testCert() {
  if (made) return made;
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-mail-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(dir, "k.pem"),
      "-out", path.join(dir, "c.pem"), "-subj", "/CN=mail.harlow.example", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-days", "1"], { stdio: "ignore" });
    made = { cert: fs.readFileSync(path.join(dir, "c.pem"), "utf8"), key: fs.readFileSync(path.join(dir, "k.pem"), "utf8") };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return made;
}

/** Listen on 127.0.0.1:0 in the clear or in TLS; `serve(socket, secure)` owns each connection. */
async function listen(t, implicit, serve) {
  const { cert, key } = testCert();
  const sockets = new Set();
  const server = implicit
    ? tls.createServer({ cert, key }, s => { sockets.add(s); serve(s, true); })
    : net.createServer(s => { sockets.add(s); serve(s, false); });
  server.on("tlsClientError", () => {});
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const close = () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r(undefined)); });
  t.after(close);
  return { port: /** @type {any} */ (server.address()).port, close };
}

/** Server-side STARTTLS on a wire. */
async function upgrade(w) {
  const { cert, key } = testCert();
  w.detach();
  const s = new tls.TLSSocket(w.socket, { isServer: true, secureContext: tls.createSecureContext({ cert, key }) });
  await new Promise((resolve, reject) => { s.once("secure", resolve); s.once("error", reject); });
  w.attach(s);
}

/**
 * A fake SMTP submission server.
 * @param {any} t
 * @param {{ mode?: "tls"|"starttls", users?: Record<string, string>, mechs?: string[] }} [o]
 */
export async function fakeSmtp(t, { mode = "starttls", users = {}, mechs = ["PLAIN", "LOGIN"] } = {}) {
  /** @type {string[]} */
  const transcript = [];
  /** @type {{ from: string, to: string[], wire: string, data: string, secure: boolean }[]} */
  const messages = [];
  const authed = [];
  const srv = await listen(t, mode === "tls", async (socket, implicit) => {
    const w = new Wire(socket, { timeout: 10_000, what: "the client" });
    let secure = implicit, user = null, from = "", to = [];
    const say = line => { transcript.push("S: " + line); w.writeLine(line); };
    const read = async () => { const l = await w.readLine(); transcript.push("C: " + l); return l; };
    try {
      say("220 mail.harlow.example ESMTP fake");
      for (;;) {
        const line = await read();
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO") {
          const caps = ["mail.harlow.example", ...(mode === "starttls" && !secure ? ["STARTTLS"] : []), ...(secure ? [`AUTH ${mechs.join(" ")}`] : []), "8BITMIME"];
          caps.forEach((c, i) => say(`250${i === caps.length - 1 ? " " : "-"}${c}`));
        } else if (verb === "STARTTLS") {
          say("220 2.0.0 ready");
          await upgrade(w);
          secure = true;
        } else if (verb === "AUTH") {
          const [, mech, arg] = line.split(" ");
          let u = "", p = "";
          if (mech.toUpperCase() === "PLAIN") {
            const parts = Buffer.from(arg || "", "base64").toString("utf8").split("\0");
            u = parts[1]; p = parts[2];
          } else if (mech.toUpperCase() === "LOGIN") {
            say("334 VXNlcm5hbWU6");
            u = Buffer.from(await read(), "base64").toString("utf8");
            say("334 UGFzc3dvcmQ6");
            p = Buffer.from(await read(), "base64").toString("utf8");
          }
          if (u in users && users[u] === p) { user = u; authed.push({ user: u, mech: mech.toUpperCase() }); say("235 2.7.0 Authentication successful"); }
          else say("535 5.7.8 Authentication credentials invalid");
        } else if (verb === "MAIL") {
          if (!user) { say("530 5.7.0 Authentication required"); continue; }
          from = /<([^>]*)>/.exec(line)?.[1] || ""; to = [];
          say("250 2.1.0 OK");
        } else if (verb === "RCPT") {
          to.push(/<([^>]*)>/.exec(line)?.[1] || "");
          say("250 2.1.5 OK");
        } else if (verb === "DATA") {
          say("354 End data with <CR><LF>.<CR><LF>");
          const lines = [];
          for (;;) {
            const l = await w.readLine();
            if (l === ".") break;
            lines.push(l);
          }
          transcript.push(`C: <${lines.length} lines of data>`);
          messages.push({ from, to, wire: lines.join("\r\n"), data: lines.map(l => (l.startsWith(".") ? l.slice(1) : l)).join("\r\n"), secure });
          say("250 2.0.0 OK queued as FAKE1");
        } else if (verb === "QUIT") {
          say("221 2.0.0 Bye");
          w.close();
          return;
        } else say("502 5.5.2 not implemented");
      }
    } catch { w.close(); }
  });
  return { ...srv, transcript, messages, authed };
}

// ---- IMAP ----

/** A sample mailbox of three messages in the made-up world. */
export function sampleMailbox() {
  const m = (headers, body) => Buffer.from(Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n" + body, "utf8");
  return [
    { uid: 11, flags: ["\\Seen"], raw: m({
      From: "Dana Harlow <dana@harlow.example>", To: "alex@harlow.example", Subject: "Engagement letter",
      Date: "Mon, 14 Sep 2026 09:00:00 +0000", "Message-ID": "<letter1@harlow.example>",
      "Content-Type": "text/plain; charset=utf-8", "Content-Transfer-Encoding": "quoted-printable",
    }, "Hi Alex,\r\n\r\nThe engagement letter is attached. Caf=C3=A9 at ten?\r\n\r\nDana\r\n") },
    { uid: 12, flags: [], raw: m({
      From: "Juno <juno@northwind.example>", To: "alex@harlow.example", Subject: `=?UTF-8?B?${Buffer.from("Order \u201csourdough\u201d ready").toString("base64")}?=`,
      Date: "Tue, 22 Sep 2026 12:30:00 +0000", "Message-ID": "<order7@northwind.example>", References: "<order6@northwind.example>",
      "MIME-Version": "1.0", "Content-Type": "multipart/alternative; boundary=\"b1\"",
    }, "--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>Your order is <b>ready</b>.</p><p>Pick up &amp; enjoy</p></body></html>\r\n--b1--\r\n") },
    { uid: 15, flags: [], raw: m({
      From: "kit@harlow.example", To: "alex@harlow.example", Cc: "juno@northwind.example", Subject: "Quote \"test\" and more",
      Date: "Fri, 25 Sep 2026 16:00:00 +0000", "Message-ID": "<kit3@harlow.example>",
      "MIME-Version": "1.0", "Content-Type": "multipart/mixed; boundary=\"mix\"",
    }, "--mix\r\nContent-Type: multipart/alternative; boundary=\"alt\"\r\n\r\n--alt\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
      + Buffer.from("Menu draft for Northwind Bakery.\n").toString("base64") + "\r\n--alt\r\nContent-Type: text/html\r\n\r\n<p>Menu draft</p>\r\n--alt--\r\n"
      + "--mix\r\nContent-Type: application/pdf; name=\"menu.pdf\"\r\nContent-Disposition: attachment; filename=\"menu.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--mix--\r\n") },
  ];
}

const header = (raw, name) => {
  const head = raw.toString("utf8").split(/\r\n\r\n/)[0].replace(/\r\n[ \t]+/g, " ");
  return new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head)?.[1] ?? "";
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A fake IMAP server with one read-only INBOX.
 * @param {any} t
 * @param {{ mode?: "tls"|"starttls", users?: Record<string, string>, authPlain?: boolean, messages?: ReturnType<typeof sampleMailbox> }} [o]
 */
export async function fakeImap(t, { mode = "tls", users = {}, authPlain = false, messages = sampleMailbox() } = {}) {
  /** @type {string[]} */
  const commands = [];
  const logins = [];
  const srv = await listen(t, mode === "tls", async (socket, implicit) => {
    const w = new Wire(socket, { timeout: 10_000, what: "the client" });
    let secure = implicit, user = null, open = null;
    const say = line => w.writeLine(line);
    /** A command with its literals: the parts parse() takes. */
    const readCommand = async () => {
      const parts = [];
      let text = "";
      for (;;) {
        const line = await w.readLine();
        parts.push(line);
        text += line;
        const m = /\{(\d+)\}$/.exec(line);
        if (!m) break;
        say("+ go ahead");
        parts.push(await w.readBytes(Number(m[1])));
        text += "<literal>";
      }
      return { parts, text };
    };
    try {
      say(`* OK fake IMAP ready`);
      for (;;) {
        const { parts, text } = await readCommand();
        const v = parse(parts).map(x => (Buffer.isBuffer(x) ? x.toString("utf8") : x));
        const tag = String(v[0]);
        let cmd = String(v[1] || "").toUpperCase();
        let args = v.slice(2);
        if (cmd === "UID") { cmd = "UID " + String(args[0]).toUpperCase(); args = args.slice(1); }
        commands.push(cmd === "LOGIN" ? "LOGIN <hidden>" : text.replace(/^\S+ /, ""));
        if (cmd === "CAPABILITY") {
          say(`* CAPABILITY IMAP4rev1${mode === "starttls" && !secure ? " STARTTLS LOGINDISABLED" : ""}${authPlain && secure ? " AUTH=PLAIN" : ""}`);
          say(`${tag} OK done`);
        } else if (cmd === "STARTTLS") {
          say(`${tag} OK begin TLS`);
          await upgrade(w);
          secure = true;
        } else if (cmd === "LOGIN") {
          const [u, p] = args.map(String);
          if (!secure) say(`${tag} NO [PRIVACYREQUIRED] no login in the clear`);
          else if (u in users && users[u] === p) { user = u; logins.push({ user: u, how: "LOGIN" }); say(`${tag} OK logged in`); }
          else say(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        } else if (cmd === "AUTHENTICATE") {
          say("+ ");
          const [, u, p] = Buffer.from(await w.readLine(), "base64").toString("utf8").split("\0");
          if (u in users && users[u] === p) { user = u; logins.push({ user: u, how: "AUTHENTICATE PLAIN" }); say(`${tag} OK logged in`); }
          else say(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        } else if (cmd === "LOGOUT") {
          say("* BYE"); say(`${tag} OK bye`); w.close(); return;
        } else if (!user) {
          say(`${tag} NO log in first`);
        } else if (cmd === "EXAMINE" || cmd === "SELECT") {
          if (String(args[0]).toUpperCase() !== "INBOX") { say(`${tag} NO no such mailbox`); continue; }
          open = cmd;
          say(`* ${messages.length} EXISTS`); say("* OK [UIDVALIDITY 7] ok"); say(`${tag} OK [READ-ONLY] examined`);
        } else if (!open) {
          say(`${tag} BAD no mailbox open`);
        } else if (cmd === "UID SEARCH") {
          const hits = messages.filter(m => matches(m, args.map(a => (Array.isArray(a) ? "" : String(a ?? "")))));
          say(`* SEARCH${hits.map(m => " " + m.uid).join("")}`); say(`${tag} OK searched`);
        } else if (cmd === "UID FETCH") {
          const want = new Set(String(args[0]).split(",").map(Number));
          const items = JSON.stringify(args.slice(1)).toUpperCase();
          messages.forEach((m, i) => {
            if (!want.has(m.uid)) return;
            let line = `* ${i + 1} FETCH (UID ${m.uid} FLAGS (${m.flags.join(" ")})`;
            if (items.includes("ENVELOPE")) {
              const subject = header(m.raw, "Subject");
              // A subject with a quote goes as a literal, so the client's literal parsing is exercised.
              if (subject.includes("\"")) {
                w.writeLine(`${line} ENVELOPE (${q(header(m.raw, "Date"))} {${Buffer.byteLength(subject)}}`);
                w.write(subject);
                line = "";
              } else line += ` ENVELOPE (${q(header(m.raw, "Date"))} ${q(subject)}`;
              const a = n => addrList(header(m.raw, n));
              line += ` ${a("From")} ${a("From")} ${a("From")} ${a("To")} ${a("Cc")} NIL ${q(header(m.raw, "In-Reply-To"))} ${q(header(m.raw, "Message-ID"))})`;
            }
            if (items.includes("BODY.PEEK[]")) {
              w.writeLine(`${line} BODY[] {${m.raw.length}}`);
              w.write(m.raw);
              line = "";
            }
            w.writeLine(line + ")");
          });
          say(`${tag} OK fetched`);
        } else say(`${tag} BAD unknown command`);
      }
    } catch { w.close(); }
  });
  return { ...srv, commands, logins };
}

/** An IMAP string, or NIL. @param {string} s */
const q = s => (s ? `"${s.replace(/["\\]/g, "\\$&")}"` : "NIL");

/** "Name <a@b>, c@d" to an ENVELOPE address list. @param {string} v */
function addrList(v) {
  if (!v) return "NIL";
  const out = v.split(",").map(x => x.trim()).filter(Boolean).map(x => {
    const m = /^(.*?)\s*<([^@>]+)@([^>]+)>$/.exec(x) || [null, "", ...x.split("@")];
    return `(${q(String(m[1] || "").replace(/^"|"$/g, ""))} NIL ${q(String(m[2]))} ${q(String(m[3]))})`;
  });
  return `(${out.join("")})`;
}

/** Does a message match UID SEARCH keys? @param {{ uid: number, flags: string[], raw: Buffer }} m @param {string[]} keys */
function matches(m, keys) {
  const has = (h, s) => header(m.raw, h).toLowerCase().includes(s.toLowerCase());
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i].toUpperCase();
    if (k === "ALL") continue;
    if (k === "CHARSET") { i++; continue; }
    if (k === "UNSEEN") { if (m.flags.includes("\\Seen")) return false; continue; }
    if (k === "SEEN") { if (!m.flags.includes("\\Seen")) return false; continue; }
    const arg = keys[++i] ?? "";
    if (k === "FROM" || k === "TO" || k === "SUBJECT") { if (!has(k[0] + k.slice(1).toLowerCase(), arg)) return false; continue; }
    if (k === "TEXT") { if (!m.raw.toString("utf8").toLowerCase().includes(arg.toLowerCase())) return false; continue; }
    if (k === "SINCE" || k === "BEFORE") {
      const [d, mon, y] = arg.split("-");
      const at = Date.UTC(Number(y), MONTHS.indexOf(mon.toLowerCase()), Number(d));
      const when = Date.parse(header(m.raw, "Date"));
      if (k === "SINCE" ? when < at : when >= at) return false;
      continue;
    }
    return false;
  }
  return true;
}
