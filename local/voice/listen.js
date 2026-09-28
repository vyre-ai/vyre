// @ts-check
// listen: one push-to-talk utterance, from key down to the finished words.
//
// The Capsule opens /v1/streams/voice/listen when the key goes down and sends 16 kHz mono
// linear16 PCM as binary frames while it is held, then {"type":"end"} when it comes up. This
// side fetches the key, opens the provider, relays what the provider hears as it hears it, and
// ends with {"type":"done","text"}. One connection is one utterance; nothing outlives it.
//
// People start talking the instant the key goes down, before the key is out of the vault or
// the provider has answered. So audio that arrives early is held and sent the moment the
// provider is open, never dropped: losing the first word is the failure people notice most.
//
// Audio and transcripts are never logged and never emitted. Errors are fixed words and a
// status; none echoes a value, the key least of all.
//
// A browser's WebSocket can't set x-vyre-caller (native-core, 28 Sep), so the Deck mints a
// one-use ticket first, through voice.listen (index.js), the same shape as term.attach/Glass: an
// ordinary tool call vyred's usual caller/ancestry checks already gate, minting a 30 s ticket
// this stream spends on the handshake. A caller that CAN set the header (the native Capsule)
// skips the round trip and connects directly, as it always has; the ticket is the whole
// authority when one is given, same as term's, and is checked before the label/peer fallback.

import crypto from "node:crypto";
import { accept, connect, refuse } from "./ws.js";
import { DEFAULTS, VoiceError, deepgramListen, offline, origin, settings, statusError, transcribe } from "./providers.js";

/** Callers on this Mac that may talk to it. A tailnet peer never may: the mic is this machine's.
 *  "deck" (chat's push-to-talk, native-core, 28 Sep) is the Deck served locally on this same Mac,
 *  never a remote one: `info.peer` below refuses those regardless of what they claim as caller. */
export const LOCAL = ["capsule", "local", "cli", "deck"];
/** Five minutes of 16 kHz linear16. One held key is one utterance, not a recording session. */
export const MAX_BYTES = 5 * 60 * 32_000;
/** How long a stream may sit with no frame at all before it is closed. Only while one is open. */
const IDLE_MS = 30_000;
/** How long to wait for the provider's last words after the key comes up. */
const TAIL_MS = 5_000;
/** A ticket's life, same as term's (core/term/index.js). */
const TICKET_MS = 30_000;

const kindOf = caller => String(caller || "").replace(/[\s:]agent:.*$/s, "");
/** The mic is the person's, physically: "cli agent:kit" is a model running under a CLI wrapper,
 *  not the person, whatever kindOf() would otherwise call it (reviewer, 28 Sep). Checked at both
 *  gates: voice.listen (index.js, the ticket-minting tool call) and here, for a direct connect. */
export const isAgentCaller = caller => /(?:^|[\s:])agent:/.test(String(caller || ""));
const token = () => crypto.randomBytes(24).toString("base64url");

/**
 * @param {{ vault: { fetch(name: string): Promise<string> }, config: any, log: (m: string) => void }} deps
 */
export function listener({ vault, config, log }) {
  /** @type {Set<() => void>} */
  const open = new Set();
  /** @type {Map<string, number>} one-use tickets from voice.listen, ticket -> expires. */
  const tickets = new Map();

  /** A fresh one-use ticket and the path a WebSocket connects to with it (index.js's voice.listen). */
  const issue = () => {
    for (const [k, exp] of tickets) if (exp <= Date.now()) tickets.delete(k);
    const ticket = token();
    tickets.set(ticket, Date.now() + TICKET_MS);
    return { path: `/v1/streams/voice/listen?ticket=${encodeURIComponent(ticket)}` };
  };

  /** The upgrade handler: vyred calls it with the raw socket and the caller it established. */
  const handle = (req, socket, head, info = {}) => {
    const tk = info.url ? info.url.searchParams.get("ticket") : null;
    if (tk) {
      // The ticket is the whole authority, as for term's (core/term/index.js): spent the moment
      // it is seen, whatever the outcome, so a retried or observed ticket never works twice.
      const exp = tickets.get(tk);
      tickets.delete(tk);
      if (info.peer || !exp || exp <= Date.now()) {
        refuse(socket, 403, "Forbidden", { error: { code: "denied", message: "that ticket is spent, expired, or this is not a local connection" } });
        return;
      }
    } else if (info.peer || isAgentCaller(info.caller) || !LOCAL.includes(kindOf(info.caller))) {
      refuse(socket, 403, "Forbidden", { error: { code: "denied", message: "voice listens only for this Mac's own Capsule, not for a peer" } });
      return;
    }
    const peer = accept(req, socket, head);
    if (!peer) return;
    session(peer).catch(() => { try { peer.close(1011); } catch {} });
  };

  /** @param {import("./ws.js").Peer} client */
  async function session(client) {
    const s = settings(config);
    const p = s.provider;
    /** @type {Buffer[]} */
    let early = [];
    let bytes = 0, ended = false, finished = false;
    let committed = "";
    /** @type {import("./ws.js").Peer|null} */
    let up = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let idle = null, tail = null;
    // What the key coming up does. Until the provider is chosen and open it does nothing, and
    // `ended` alone remembers it, so an end that beats the vault is honoured once it is ready.
    let onEnd = () => {};

    const stop = () => fail(new VoiceError("stopped", "vyred is stopping"));
    open.add(stop);
    const finish = (/** @type {any} */ last) => {
      if (finished) return;
      finished = true;
      open.delete(stop);
      if (idle) clearTimeout(idle);
      if (tail) clearTimeout(tail);
      early = [];
      if (last) client.json(last);
      client.close(1000);
      if (up) { try { up.close(1000); } catch {} up = null; }
    };
    const fail = (/** @type {any} */ e) => {
      const code = e instanceof VoiceError ? e.code : "provider_error";
      if (!(e instanceof VoiceError)) log(`listen failed: ${code}`);
      finish({ type: "error", code, message: e instanceof VoiceError ? e.message : "the stream failed" });
    };
    const poke = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => fail(new VoiceError("idle", "no audio arrived for 30 seconds")), IDLE_MS); };
    poke();

    // What the Capsule sends, from the first byte on, whatever state the provider is in.
    // The Capsule went away (or was closed by finish): drop the provider with it.
    client.on("close", () => finish(null));
    client.on("message", m => {
      if (finished) return;
      poke();
      if (m.binary) {
        if (ended) return;
        bytes += m.binary.length;
        if (bytes > MAX_BYTES) { fail(new VoiceError("too_long", "one utterance is at most five minutes")); return; }
        if (up && s.provider === "deepgram") up.binary(m.binary); else early.push(m.binary);
        return;
      }
      let msg;
      try { msg = JSON.parse(String(m.text)); } catch { msg = null; }
      if (msg && msg.type === "end" && !ended) { ended = true; onEnd(); }
    });

    // The key: out of the vault for this one connection, and gone with it.
    let key = "";
    try { key = String((await vault.fetch(DEFAULTS[p].item)) || ""); }
    catch { key = ""; }
    if (finished) return;
    if (!key) { fail(new VoiceError("no_key", `no ${DEFAULTS[p].name} key is saved for voice; add one in Settings`)); return; }
    let base;
    try { base = origin(p, s.endpoints); } catch (e) { fail(e); return; }

    if (!DEFAULTS[p].streaming) {
      // Held until release, then one request. The key stays in this closure until then.
      client.json({ type: "listening", provider: p, streaming: false });
      onEnd = async () => {
        const pcm = Buffer.concat(early); early = [];
        if (!pcm.length) { finish({ type: "done", text: "" }); return; }
        try {
          const text = await transcribe(p, base, key, pcm);
          key = "";
          if (text) client.json({ type: "final", text });
          finish({ type: "done", text });
        } catch (e) { key = ""; fail(e); }
      };
      if (ended) onEnd();
      return;
    }

    const { url, headers } = deepgramListen(base, key);
    key = "";
    const r = await connect(url, { headers });
    if (finished) { if (r.peer) r.peer.close(1000); return; }
    if (r.unreachable) { fail(offline(p)); return; }
    if (!r.peer) { fail(statusError(p, /** @type {number} */ (r.status))); return; }
    up = r.peer;
    client.json({ type: "listening", provider: p, streaming: true });
    for (const b of early) up.binary(b);
    early = [];

    let interim = "";
    up.on("message", m => {
      if (finished || !m.text) return;
      let msg;
      try { msg = JSON.parse(m.text); } catch { return; }
      if (msg.type !== "Results") return;
      const text = String(msg.channel?.alternatives?.[0]?.transcript || "").trim();
      // text is always the whole utterance so far, so the Capsule just shows it.
      if (msg.is_final) {
        interim = "";
        if (!text) return;
        committed = committed ? `${committed} ${text}` : text;
        client.json({ type: "final", text: committed });
      } else {
        if (text === interim) return;
        interim = text;
        client.json({ type: "partial", text: committed && text ? `${committed} ${text}` : committed || text });
      }
    });
    up.on("close", code => {
      up = null;
      if (finished) return;
      // After CloseStream, Deepgram sends its last finals and closes: that is the end.
      if (ended) finish({ type: "done", text: committed });
      else fail(new VoiceError("provider_error", `${DEFAULTS[p].name} closed the stream (code ${code})`));
    });
    onEnd = () => {
      if (!up) { finish({ type: "done", text: committed }); return; }
      // Deepgram flushes what it still holds, sends the last finals, and closes.
      up.json({ type: "CloseStream" });
      tail = setTimeout(() => finish({ type: "done", text: committed }), TAIL_MS);
    };
    if (ended) onEnd();
  }

  return {
    handle,
    issue,
    /** Streams open right now. Zero means nothing of this module is running. */
    get open() { return open.size; },
    /** End every open stream, for the module's stop(). */
    stop() { for (const s of [...open]) s(); },
  };
}
