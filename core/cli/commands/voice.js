// @ts-check
// `vyre voice`: push-to-talk from the terminal, the voice module's status, and saving its key.
// The talking itself lives in local/voice/talk.js; this file only parses arguments.

import { call } from "../../daemon/client.js";
import * as config from "../../config/index.js";
import { hiddenPrompt } from "../../vault/cli-io.js";
import { callAsPerson } from "../presence.js";
import { talkLoop } from "../../../local/voice/talk.js";
import { out, dim, bold, signal, beacon } from "../style.js";

const USAGE = "vyre voice [status | key [provider] | --send <thread>]";
const SURFACE = "cli:" + process.pid;
const ITEMS = { deepgram: "voice-deepgram-key", openai: "voice-openai-key", elevenlabs: "voice-elevenlabs-key" };

const fail = r => {
  const down = ["unreachable", "timeout"].includes(r.error.code);
  out(down ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message);
  return ["presence_required", "presence_refused", "presence_denied", "no_terminal"].includes(r.error.code) ? 3 : 1;
};

export default {
  name: "voice", order: 70, usage: USAGE, summary: "push-to-talk from the terminal (Enter to talk), status, and the speech key",
  async run([sub, ...rest]) {
    if (sub === "status") {
      const r = await call("voice.status", {});
      if (r.error) return fail(r);
      const s = r.data;
      out(`  ${bold(s.provider)} ${dim(s.mode)} · key ${s.key ? signal("saved") : beacon(s.key_state)} · ${s.online ? signal("online") : beacon("offline")}${s.speak ? " · spoken replies on" : ""}`);
      if (!s.key) out(dim(`  save it with: vyre voice key ${s.provider}`));
      return 0;
    }
    if (sub === "key") {
      const provider = rest[0] || "deepgram";
      const item = ITEMS[/** @type {keyof typeof ITEMS} */ (provider)];
      if (!item || rest.length > 1) { out(`  usage: vyre voice key [${Object.keys(ITEMS).join("|")}] (the key from the prompt, or piped in)`); return 1; }
      let value = "";
      try { value = await hiddenPrompt(`${provider} key: `); } catch { value = ""; }
      if (!value) { out("  no key given, nothing stored"); return 1; }
      // Saving and granting a key are a person's acts: Touch ID or a code typed at this terminal
      // (read from /dev/tty, so the key can still come in on stdin).
      const put = await callAsPerson("vault.put", { name: item, kind: "api-key", fields: { value }, description: `${provider} key for push-to-talk` });
      value = "";
      if (put.error) return fail(put);
      const g = await callAsPerson("vault.grant", { name: item, module: "voice" });
      if (g.error) return fail(g);
      const grant = g.data.grant;
      if (grant.status === "pending") out(`  ${signal("stored")} ${bold(item)} ${beacon("· grant waiting for approval")} ${dim(`vyre vault approve ${grant.id}`)}`);
      else out(`  ${signal("stored")} ${bold(item)} ${dim("· granted to voice")}`);
      if (provider !== "deepgram") {
        const s = await call("voice.settings", { provider });
        if (s.error) return fail(s);
      }
      return 0;
    }
    let thread = null;
    const args = sub === undefined ? [] : [sub, ...rest];
    if (args[0] === "--send") {
      thread = args[1];
      if (!thread || args.length > 2) { out(`  usage: ${USAGE}`); return 1; }
    } else if (args.length) { out(`  usage: ${USAGE}`); return 1; }
    const onFinal = thread ? async text => {
      const r = await call("threads.send", { thread, text, surface: SURFACE });
      if (r.error) fail(r); else out(dim(`  sent to ${thread}`));
    } : undefined;
    return talkLoop({ socketPath: config.paths(config.home()).socket, onFinal });
  },
};
