// @ts-check
// voice: push-to-talk for the Capsule and its side view, and optional spoken replies.
//
// The Mac's mic is captured by the Capsule shell (swift/Mic.swift, or bin/vyre-mic until the
// shell exists) and streamed to vyred at /v1/streams/voice/listen; see listen.js for the frames.
// This module holds no audio and no key between calls. The key lives in the Vault
// (voice-deepgram-key, voice-openai-key, voice-elevenlabs-key), put there by a person from the
// Capsule's Settings with vault.put and vault.grant. This module only fetches it, for one
// stream or one reply, and sends it to the provider it belongs to and nowhere else.
//
// At idle it does nothing: no timer, no socket, no poll. `online` in voice.status is one TCP
// connect made when asked.

import crypto from "node:crypto";
import { Readable } from "node:stream";
import * as config from "../../core/config/index.js";
import { listener, LOCAL } from "./listen.js";
import { DEFAULTS, PROVIDERS, VoiceError, origin, reachable, settings, speak } from "./providers.js";

/** A spoken reply is a sentence or two, not a document. */
const MAX_SPEAK = 2000;
/** How long a speech ticket waits to be redeemed before its audio is dropped. */
const TICKET_MS = 30_000;

const kindOf = caller => String(caller || "").replace(/[\s:]agent:.*$/s, "");

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void>, idle(): { streams: number, tickets: number } }> }} */
export default {
  async start(ctx) {
    const fetchKey = name => ctx.vault.fetch(name);
    const listen = listener({ vault: { fetch: fetchKey }, config: ctx.config, log: ctx.log });
    ctx.upgrade("listen", listen.handle);

    /** Speech waiting for its one caller: ticket to the provider's unread body. */
    /** @type {Map<string, { body: ReadableStream<Uint8Array>, type: string, timer: ReturnType<typeof setTimeout> }>} */
    const tickets = new Map();
    const drop = t => { const x = tickets.get(t); if (!x) return; tickets.delete(t); clearTimeout(x.timer); x.body.cancel().catch(() => {}); };

    /** Whether a key is saved and granted, from the Vault's listing: no value is released to tell. */
    const keyState = async p => {
      const r = await ctx.call("vault.list", { filter: DEFAULTS[p].item });
      if (r.error) return "no_vault";
      const item = (r.data.items || []).find(i => i.name === DEFAULTS[p].item);
      if (!item) return "missing";
      return (item.grants || []).some(g => g.module === "voice" && !g.watcher) ? "ready" : "not_granted";
    };

    const refusePeer = meta => {
      if (meta && meta.peer) throw new VoiceError("denied", "voice is for this Mac's own Capsule, not for a tailnet peer");
    };

    ctx.tool("voice.status", {
      description: "The speech provider, whether its key is saved (never the key), whether replies are spoken, and whether the provider can be reached right now.",
      callers: LOCAL,
      input: { type: "object", properties: {} },
      run: async (_input, meta) => {
        refusePeer(meta);
        const s = settings(ctx.config);
        const key = await keyState(s.provider);
        let base = null, endpoint = "default";
        try { base = origin(s.provider, s.endpoints); if (base !== DEFAULTS[s.provider].origin) endpoint = "test override"; }
        catch (e) { endpoint = /** @type {Error} */ (e).message; }
        return {
          provider: s.provider, providers: [...PROVIDERS], item: DEFAULTS[s.provider].item,
          key: key === "ready", key_state: key,
          speak: s.speak, voice: s.voice,
          streaming: DEFAULTS[s.provider].streaming, mode: DEFAULTS[s.provider].streaming ? "streaming" : "on-release",
          online: base ? await reachable(base) : false, endpoint,
          stream: "/v1/streams/voice/listen", format: { encoding: "linear16", sample_rate: 16000, channels: 1 },
        };
      },
    });

    ctx.tool("voice.settings", {
      description: "Change the speech provider, whether replies are spoken, or the voice. The key itself is saved through the Vault, never here.",
      callers: LOCAL,
      input: { type: "object", properties: { provider: { type: "string", enum: [...PROVIDERS] }, speak: { type: "boolean" }, voice: { type: "string" } } },
      run: async (input, meta) => {
        refusePeer(meta);
        const patch = {};
        if (input.provider !== undefined) patch.provider = input.provider;
        if (input.speak !== undefined) patch.speak = input.speak;
        if (input.voice !== undefined) {
          const v = String(input.voice).trim();
          if (v.length > 80 || /[^A-Za-z0-9._-]/.test(v)) throw new VoiceError("bad_input", "a voice is a provider's voice id: letters, digits, dot, dash and underscore");
          patch.voice = v || null;
        }
        if (Object.keys(patch).length) config.save({ voice: patch }, ctx.paths.root, ctx.config);
        const s = settings(ctx.config);
        return { provider: s.provider, speak: s.speak, voice: s.voice };
      },
    });

    ctx.tool("voice.speak", {
      description: "Say a reply aloud through the speech provider. Returns a one-time ticket; GET /v1/voice/speech?ticket= on vyred's socket streams the audio (audio/mpeg) to the caller holding it.",
      callers: LOCAL,
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async ({ text }, meta) => {
        refusePeer(meta);
        const s = settings(ctx.config);
        if (!s.speak) throw new VoiceError("speak_off", "spoken replies are off; turn them on in Settings");
        const said = String(text).trim();
        if (!said) throw new VoiceError("bad_input", "nothing to say");
        if (said.length > MAX_SPEAK) throw new VoiceError("bad_input", `a spoken reply is at most ${MAX_SPEAK} characters`);
        const base = origin(s.provider, s.endpoints);
        let key = "";
        try { key = String((await ctx.vault.fetch(DEFAULTS[s.provider].item)) || ""); } catch { key = ""; }
        if (!key) throw new VoiceError("no_key", `no ${DEFAULTS[s.provider].name} key is saved for voice; add one in Settings`);
        const audio = await speak(s.provider, base, key, said, s.voice);
        key = "";
        const ticket = crypto.randomBytes(24).toString("base64url");
        tickets.set(ticket, { ...audio, timer: setTimeout(() => drop(ticket), TICKET_MS) });
        return { ticket, url: `/v1/voice/speech?ticket=${ticket}`, type: audio.type, expires_in: TICKET_MS / 1000 };
      },
    });

    // The audio of one voice.speak, streamed as the provider sends it so playback can start
    // before synthesis ends. The bytes stay off the tool path, whose results can reach logs
    // and transcripts; audio must reach neither.
    ctx.route("speech", (req, res, { caller, url }) => {
      const ticket = url.searchParams.get("ticket") || "";
      const x = tickets.get(ticket);
      if (req.method !== "GET" || !LOCAL.includes(kindOf(caller)) || !x) {
        res.writeHead(req.method !== "GET" ? 405 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found", message: "no such speech ticket here" } }));
        return;
      }
      tickets.delete(ticket); clearTimeout(x.timer);
      res.writeHead(200, { "content-type": x.type, "cache-control": "no-store" });
      const body = Readable.fromWeb(/** @type {any} */ (x.body));
      body.on("error", () => res.destroy());
      res.on("close", () => body.destroy());
      body.pipe(res);
    });

    return {
      async stop() { listen.stop(); for (const t of [...tickets.keys()]) drop(t); },
      /** What is live right now, for the idle-cost check: both zero means nothing is scheduled. */
      idle: () => ({ streams: listen.open, tickets: tickets.size }),
    };
  },
};
