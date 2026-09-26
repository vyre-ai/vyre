// @ts-check
// fake: a speech provider on 127.0.0.1 for the voice tests, so no test ever reaches Deepgram,
// OpenAI or ElevenLabs or needs a real key.
//
// It imitates the parts voice uses, closely enough to catch the mistakes that matter: the
// Deepgram listen socket (interim results as audio arrives, a final every half second of audio,
// the last words and a close after CloseStream), its speak route, OpenAI's and ElevenLabs'
// batch transcription and speech routes, and a 401 for any key but the good one. Its 401 body
// quotes the key it was sent, as a careless real service might, so a test can prove that no
// provider's words are ever passed on to the person or into a log.

import http from "node:http";
import { accept, refuse } from "./ws.js";

export const WORDS = ["hello", "from", "harlow", "legal"];
/** Half a second of 16 kHz linear16: one word is final after this much audio. */
const WORD_BYTES = 16_000;
export const AUDIO = Buffer.from("ID3\x04fake-mp3-frames-for-the-voice-tests", "latin1");

/**
 * @param {{ key: string }} opts the one key this fake accepts
 */
export async function fakeSpeech({ key }) {
  const got = { listens: 0, audioBytes: 0, closeStream: 0, speak: [], transcribe: [], auth: [] };
  const ok = (h, want) => { got.auth.push(Boolean(h)); return h === want; };
  const reject = (res, sent) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ err_code: "INVALID_AUTH", err_msg: `Invalid credentials: ${sent}` }));
  };
  const body = req => new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
  const mp3 = res => { res.writeHead(200, { "content-type": "audio/mpeg" }); res.write(AUDIO.subarray(0, 8)); setTimeout(() => res.end(AUDIO.subarray(8)), 5); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://fake");
    const raw = await body(req);
    if (req.method === "POST" && url.pathname === "/v1/speak") {
      const h = req.headers.authorization;
      if (!ok(h, `Token ${key}`)) return reject(res, h);
      got.speak.push({ provider: "deepgram", model: url.searchParams.get("model"), text: JSON.parse(String(raw)).text });
      return mp3(res);
    }
    if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
      const h = req.headers.authorization;
      if (!ok(h, `Bearer ${key}`)) return reject(res, h);
      got.speak.push({ provider: "openai", text: JSON.parse(String(raw)).input });
      return mp3(res);
    }
    const tts = /^\/v1\/text-to-speech\/([^/]+)\/stream$/.exec(url.pathname);
    if (req.method === "POST" && tts) {
      const h = req.headers["xi-api-key"];
      if (!ok(h, key)) return reject(res, h);
      got.speak.push({ provider: "elevenlabs", voice: tts[1], text: JSON.parse(String(raw)).text });
      return mp3(res);
    }
    if (req.method === "POST" && (url.pathname === "/v1/audio/transcriptions" || url.pathname === "/v1/speech-to-text")) {
      const openai = url.pathname === "/v1/audio/transcriptions";
      const h = openai ? req.headers.authorization : req.headers["xi-api-key"];
      if (!ok(h, openai ? `Bearer ${key}` : key)) return reject(res, h);
      // A real multipart body: the WAV is in it, and its size says how many words were spoken.
      const at = raw.indexOf("RIFF");
      const pcm = at >= 0 ? raw.readUInt32LE(at + 40) : 0;
      got.transcribe.push({ provider: openai ? "openai" : "elevenlabs", pcm, wav: at >= 0 && raw.subarray(at + 8, at + 12).toString() === "WAVE" });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ text: WORDS.slice(0, Math.max(1, Math.ceil(pcm / WORD_BYTES))).join(" ") }));
    }
    res.writeHead(404); res.end();
  });

  const sockets = new Set();
  server.on("upgrade", (req, socket, head) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const url = new URL(req.url || "/", "http://fake");
    if (url.pathname !== "/v1/listen") { refuse(socket, 404, "Not Found"); return; }
    const h = req.headers.authorization;
    got.auth.push(Boolean(h));
    if (h !== `Token ${key}`) { refuse(socket, 401, "Unauthorized", { err_code: "INVALID_AUTH", err_msg: `Invalid credentials: ${h}` }); return; }
    if (url.searchParams.get("encoding") !== "linear16" || url.searchParams.get("sample_rate") !== "16000") { refuse(socket, 400, "Bad Request"); return; }
    got.listens++;
    const peer = accept(req, socket, head);
    if (!peer) return;
    let bytes = 0, word = 0;
    const result = (text, is_final) => peer.json({ type: "Results", is_final, speech_final: is_final, channel: { alternatives: [{ transcript: text }] } });
    peer.on("message", m => {
      if (m.binary) {
        bytes += m.binary.length; got.audioBytes += m.binary.length;
        // Interim words as audio arrives, then the word is final once enough audio is in.
        const w = WORDS[word % WORDS.length];
        if (bytes >= WORD_BYTES) { bytes -= WORD_BYTES; word++; result(w, true); }
        else result(w.slice(0, Math.max(1, Math.round(w.length * bytes / WORD_BYTES))), false);
        return;
      }
      const msg = JSON.parse(String(m.text));
      if (msg.type === "CloseStream") {
        got.closeStream++;
        if (bytes > 0) result(WORDS[word % WORDS.length], true);
        peer.json({ type: "Metadata", duration: got.audioBytes / 32_000 });
        setTimeout(() => peer.close(1000), 10);
      }
    });
  });

  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  return { base, got, close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); for (const s of sockets) s.destroy(); }) };
}
