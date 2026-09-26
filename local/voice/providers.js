// @ts-check
// providers: where a speech key is allowed to go, and what each provider's speech APIs look like.
//
// A key leaves this machine in exactly one place: the request to the provider it belongs to.
// So the hosts are fixed here, and the only override is for tests, which point a provider at a
// fake on this machine. An override to any other host is refused whatever its scheme: the
// config file is writable by anything running as the user, Claude's shell included, and a
// one-line edit must not be enough to send the key to a stranger.
//
// Deepgram streams: its listen socket takes PCM as it is spoken and answers with interim and
// final words. OpenAI and ElevenLabs are transcribed on release: the audio is held in memory
// while the key is down and sent as one request when it comes up. Both have realtime APIs, but
// their session shapes were still changing when this was written, and without a real call to
// check against, a fake would only test a guess. Their batch endpoints are stable. status says
// which mode is in use, so the Capsule can show "transcribing" instead of live words.

import net from "node:net";

/** @typedef {"deepgram"|"openai"|"elevenlabs"} Provider */

export const PROVIDERS = /** @type {const} */ (["deepgram", "openai", "elevenlabs"]);

/** Each provider's own origin, and the vault item that holds its key. */
export const DEFAULTS = {
  deepgram: { origin: "https://api.deepgram.com", item: "voice-deepgram-key", name: "Deepgram", streaming: true },
  openai: { origin: "https://api.openai.com", item: "voice-openai-key", name: "OpenAI", streaming: false },
  elevenlabs: { origin: "https://api.elevenlabs.io", item: "voice-elevenlabs-key", name: "ElevenLabs", streaming: false },
};

/** Default voices: stock voices each provider ships, so nothing personal is baked in. */
const VOICES = { deepgram: "aura-2-thalia-en", openai: "alloy", elevenlabs: "21m00Tcm4TlvDq8ikWAM" };

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** An error with a code the stream and the tools pass on as is. Messages never carry a value. */
export class VoiceError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * The origin to use for a provider: its own, or a test's override on this machine.
 * @param {Provider} provider @param {any} endpoints config.voice.endpoints
 */
export function origin(provider, endpoints) {
  const o = endpoints && endpoints[provider];
  if (o === undefined || o === null || o === "") return DEFAULTS[provider].origin;
  let u;
  try { u = new URL(String(o)); } catch { throw new VoiceError("bad_endpoint", `the ${provider} endpoint override is not a URL`); }
  if (!["http:", "https:"].includes(u.protocol) || !LOOPBACK.has(u.hostname) || u.username || u.password || (u.pathname !== "/" && u.pathname !== "")) {
    throw new VoiceError("bad_endpoint", `the ${provider} endpoint override must be http(s)://127.0.0.1:<port> with no path; a key is only ever sent to ${DEFAULTS[provider].origin} or to a test server on this machine`);
  }
  return u.origin;
}

/** @param {any} cfg */
export function settings(cfg) {
  const v = (cfg && cfg.voice) || {};
  const provider = PROVIDERS.includes(v.provider) ? v.provider : "deepgram";
  return { provider: /** @type {Provider} */ (provider), speak: v.speak === true, voice: typeof v.voice === "string" && v.voice ? v.voice : null, endpoints: v.endpoints || null };
}

/**
 * Can the provider's host be reached right now? One TCP connect, nothing sent: made when asked,
 * never on a schedule, and it carries no key.
 * @param {string} base @param {number} [timeout]
 */
export function reachable(base, timeout = 2500) {
  const u = new URL(base);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return new Promise(resolve => {
    const s = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ""), port });
    const done = ok => { clearTimeout(t); s.destroy(); resolve(ok); };
    const t = setTimeout(() => done(false), timeout);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Map a provider's HTTP status to the error the person sees. @param {Provider} p @param {number} status */
export function statusError(p, status) {
  if (status === 401 || status === 403) return new VoiceError("provider_rejected", `${DEFAULTS[p].name} refused the key (HTTP ${status}); replace it in Settings`);
  return new VoiceError("provider_error", `${DEFAULTS[p].name} answered HTTP ${status}`);
}

/** @param {Provider} p */
export const offline = p => new VoiceError("offline", `${DEFAULTS[p].name} cannot be reached; check the connection`);

/**
 * The Deepgram listen socket's URL and headers for 16 kHz mono linear16.
 * @param {string} base @param {string} key
 */
export function deepgramListen(base, key) {
  const qs = new URLSearchParams({ model: "nova-3", encoding: "linear16", sample_rate: "16000", channels: "1", interim_results: "true", smart_format: "true", punctuate: "true" });
  return { url: base.replace(/^http/, "ws") + "/v1/listen?" + qs, headers: { authorization: `Token ${key}` } };
}

/**
 * Wrap raw linear16 in a WAV header, which is what the batch endpoints take.
 * @param {Buffer} pcm @param {number} [rate]
 */
export function wav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Transcribe a whole utterance in one request (OpenAI, ElevenLabs).
 * @param {Provider} p @param {string} base @param {string} key @param {Buffer} pcm
 * @returns {Promise<string>}
 */
export async function transcribe(p, base, key, pcm) {
  const form = new FormData();
  form.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "speech.wav");
  let url, headers;
  if (p === "openai") { url = base + "/v1/audio/transcriptions"; headers = { authorization: `Bearer ${key}` }; form.append("model", "gpt-4o-mini-transcribe"); }
  else if (p === "elevenlabs") { url = base + "/v1/speech-to-text"; headers = { "xi-api-key": key }; form.append("model_id", "scribe_v1"); }
  else throw new VoiceError("provider_error", `${p} streams; it is not transcribed on release`);
  let res;
  try { res = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(30_000) }); }
  catch { throw offline(p); }
  if (!res.ok) { await res.body?.cancel(); throw statusError(p, res.status); }
  let body;
  try { body = await res.json(); } catch { throw new VoiceError("provider_error", `${DEFAULTS[p].name} sent a transcript that is not JSON`); }
  return String((body && body.text) || "").trim();
}

/**
 * Start text to speech. Resolves once the provider has answered with audio, so a refused key or
 * a dead network is reported by the tool call, not by a later fetch of the bytes. The body is
 * left unread, to be piped to the one caller who holds the ticket.
 * @param {Provider} p @param {string} base @param {string} key @param {string} text @param {string|null} voice
 * @returns {Promise<{ body: ReadableStream<Uint8Array>, type: string }>}
 */
export async function speak(p, base, key, text, voice) {
  const v = voice || VOICES[p];
  let url, headers, body;
  if (p === "deepgram") {
    url = `${base}/v1/speak?${new URLSearchParams({ model: v, encoding: "mp3" })}`;
    headers = { authorization: `Token ${key}` }; body = { text };
  } else if (p === "openai") {
    url = `${base}/v1/audio/speech`; headers = { authorization: `Bearer ${key}` };
    body = { model: "gpt-4o-mini-tts", voice: v, input: text, response_format: "mp3" };
  } else {
    url = `${base}/v1/text-to-speech/${encodeURIComponent(v)}/stream?output_format=mp3_44100_128`;
    headers = { "xi-api-key": key }; body = { text, model_id: "eleven_flash_v2_5" };
  }
  // The timeout covers waiting for the answer only; the audio itself may take longer to arrive.
  const abort = new AbortController();
  const t = setTimeout(() => abort.abort(), 15_000);
  let res;
  try { res = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal: abort.signal }); }
  catch { throw offline(p); }
  finally { clearTimeout(t); }
  if (!res.ok || !res.body) { await res.body?.cancel(); throw statusError(p, res.status); }
  return { body: res.body, type: "audio/mpeg" };
}
