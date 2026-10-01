// @ts-check
// A fake IMAP server for imap.js and push.js tests, on 127.0.0.1 port 0 over plain TCP (the
// client's `connect` seam gives it a plain socket, so no TLS is needed). Speaks the parts the
// client uses: a greeting, AUTHENTICATE XOAUTH2 (checked against the token the test expects),
// CAPABILITY, SELECT, IDLE/DONE, NOOP, UID FETCH of header fields, LOGOUT. `deliver` adds a
// message and tells idling sessions with an untagged EXISTS the way a real server does.

import net from "node:net";

/**
 * @param {{ after: (fn: () => any) => void }} t
 * @param {{ gmail?: boolean, idle?: boolean, token?: string | (() => string), user?: string, validity?: number, busy?: boolean }} [opts]
 */
export async function startFakeImap(t, opts = {}) {
  const messages = [];
  let nextUid = 100;
  const sessions = new Set();
  const commands = [];
  const state = { idle: opts.idle !== false, refuse: false, busy: Boolean(opts.busy), authAttempts: 0, connections: 0, validity: opts.validity || 7 };

  const header = m => `From: ${m.from}\r\nTo: ${m.to || "alex@harlowlegal.com"}\r\nSubject: ${m.subject || "hello"}\r\nDate: ${m.date || "Tue, 29 Sep 2026 09:00:00 +0000"}\r\nMessage-ID: <${m.id}>\r\n\r\n`;
  const seq = uid => messages.findIndex(m => m.uid === uid) + 1;

  const server = net.createServer(sock => {
    state.connections++;
    const s = { sock, idling: null, pending: [], buf: "", awaitingEmpty: null, authed: false };
    sessions.add(s);
    sock.on("close", () => sessions.delete(s));
    sock.on("error", () => {});
    if (state.busy) { sock.write("* BYE Too many simultaneous connections.\r\n"); sock.end(); return; }
    sock.write("* OK IMAP ready\r\n");
    sock.on("data", d => {
      s.buf += d.toString("utf8");
      let i;
      while ((i = s.buf.indexOf("\r\n")) >= 0) { const line = s.buf.slice(0, i); s.buf = s.buf.slice(i + 2); handle(s, line); }
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  t.after(() => { for (const s of sessions) s.sock.destroy(); return new Promise(r => server.close(r)); });

  function handle(s, line) {
    if (s.awaitingEmpty) { const tag = s.awaitingEmpty; s.awaitingEmpty = null; s.sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); return; }
    if (s.idling) {
      if (line.toUpperCase() === "DONE") { const tag = s.idling; s.idling = null; commands.push("DONE"); flush(s); s.sock.write(`${tag} OK IDLE terminated\r\n`); }
      return;
    }
    const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
    if (!m) return;
    const [, tag, cmdRaw, rest = ""] = m;
    const cmd = cmdRaw.toUpperCase();
    commands.push(cmd === "AUTHENTICATE" ? "AUTHENTICATE XOAUTH2" : `${cmd}${rest ? " " + rest : ""}`);
    if (cmd === "AUTHENTICATE") {
      state.authAttempts++;
      const b64 = rest.split(" ")[1] || "";
      const want = typeof opts.token === "function" ? opts.token() : opts.token;
      const okCred = !state.refuse && Buffer.from(b64, "base64").toString("utf8") === `user=${opts.user || "alex@harlowlegal.com"}\x01auth=Bearer ${want}\x01\x01`;
      if (okCred) { s.authed = true; s.sock.write(`${tag} OK authenticated\r\n`); return; }
      s.awaitingEmpty = tag;
      s.sock.write("+ eyJzdGF0dXMiOiI0MDAifQ==\r\n");
      return;
    }
    if (!s.authed) { s.sock.write(`${tag} NO not authenticated\r\n`); return; }
    if (cmd === "CAPABILITY") { s.sock.write(`* CAPABILITY IMAP4rev1 AUTH=XOAUTH2${state.idle ? " IDLE" : ""}${opts.gmail ? " X-GM-EXT-1" : ""}\r\n${tag} OK done\r\n`); return; }
    if (cmd === "SELECT") {
      s.sock.write(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY ${state.validity}] ok\r\n* OK [UIDNEXT ${nextUid}] ok\r\n${tag} OK [READ-WRITE] selected\r\n`);
      return;
    }
    if (cmd === "IDLE") { s.idling = tag; s.sock.write("+ idling\r\n"); flush(s); return; }
    if (cmd === "NOOP") { flush(s); s.sock.write(`${tag} OK noop\r\n`); return; }
    if (cmd === "UID") {
      const f = /^FETCH (\d+):\* /i.exec(rest);
      const from = f ? Number(f[1]) : 1;
      let hit = messages.filter(x => x.uid >= from);
      if (!hit.length && messages.length) hit = [messages[messages.length - 1]];
      for (const x of hit) { const h = header(x); s.sock.write(`* ${seq(x.uid)} FETCH (UID ${x.uid}${opts.gmail && /X-GM-MSGID/i.test(rest) ? ` X-GM-MSGID ${BigInt("1700000000000000000") + BigInt(x.uid)}` : ""} BODY[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)] {${Buffer.byteLength(h)}}\r\n${h})\r\n`); }
      s.sock.write(`${tag} OK fetched\r\n`);
      return;
    }
    if (cmd === "LOGOUT") { s.sock.write(`* BYE bye\r\n${tag} OK logout\r\n`); s.sock.end(); return; }
    s.sock.write(`${tag} BAD unknown\r\n`);
  }
  function flush(s) { while (s.pending.length) s.sock.write(s.pending.shift()); }

  return {
    port, messages, commands, sessions, state,
    /** Add a message (a body is never stored: the client must not need one). Returns its uid. */
    deliver(msg = {}) {
      const uid = nextUid++;
      messages.push({ uid, id: msg.id || `m${uid}@mail.example`, from: msg.from || "Northwind Bakery <orders@northwind.example>", ...msg });
      for (const s of sessions) { const line = `* ${messages.length} EXISTS\r\n`; if (s.idling) s.sock.write(line); else s.pending.push(line); }
      return uid;
    },
    /** Cut every connection, the way a NAT or a restart does. */
    dropAll() { for (const s of sessions) s.sock.destroy(); },
    idlers: () => [...sessions].filter(s => s.idling).length,
    live: () => sessions.size,
  };
}
