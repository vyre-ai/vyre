// @ts-check
// `vyre voice`: push-to-talk from the terminal, the voice module's status, and saving its key.
// The talking itself lives in local/voice/talk.js; this file only parses arguments.
//
// --json: status prints voice.status's reply; key prints { stored, provider, grant }. Talking
// needs a terminal (Enter to talk), so under --json or --view it is refused with exit 2. Under
// --view `key` never reads a terminal: without --stdin it answers with a prompt frame naming the
// command to run with the key piped in.

import { call } from "../../daemon/client.js";
import * as config from "../../config/index.js";
import { hiddenPrompt } from "../../vault/cli-io.js";
import { callAsPerson } from "../presence.js";
import { talkLoop } from "../../../local/voice/talk.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { EXIT, json, emit, fail as kitFail, failTool, usage, viewing } from "../kit.js";
import { prompt } from "../view.js";

const USAGE = "vyre voice [talk [--send <thread>] | status | key [provider] [--stdin]] [--json]";
const SURFACE = "cli:" + process.pid;
const ITEMS = { deepgram: "voice-deepgram-key", openai: "voice-openai-key", elevenlabs: "voice-elevenlabs-key" };

/** Every verb run() handles, for `vyre commands --json`. `vyre voice` alone talks. */
export const VERBS = [
  { verb: "talk", summary: "push-to-talk on this terminal: Enter to talk; --send types it into a thread (the default)", usage: "[--send <thread>]" },
  { verb: "status", summary: "the speech provider, its key and whether it is online", usage: "[--json]", read: true },
  { verb: "key", summary: "save the speech key in the vault and grant it to voice; --stdin reads it from a pipe", usage: "[deepgram|openai|elevenlabs] [--stdin] [--json]", person: true },
];

const fail = r => {
  if (json()) return failTool(r.error);
  const down = ["unreachable", "timeout"].includes(r.error.code);
  out(down ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message);
  return ["presence_required", "presence_refused", "presence_denied", "no_terminal"].includes(r.error.code) ? 3 : 1;
};

/** @param {string[]} rest */
async function key(rest) {
  const stdin = rest.includes("--stdin");
  const words = rest.filter(a => a !== "--stdin");
  const provider = words[0] || "deepgram";
  const item = ITEMS[/** @type {keyof typeof ITEMS} */ (provider)];
  if (!item || words.length > 1) return usage(`vyre voice key [${Object.keys(ITEMS).join("|")}]: the key comes from the prompt, or piped in with --stdin`, "vyre help voice");
  // A surface has no terminal to type a secret into: it is told how to pipe it in instead.
  if (viewing() && !stdin) {
    emit({ prompt: "key", provider }, prompt({ name: "key", label: `The ${provider} key`, secret: true, args: ["voice", "key", provider, "--stdin"], answer: "stdin" }));
    return EXIT.USAGE;
  }
  let value = "";
  try { value = await hiddenPrompt(`${provider} key: `); } catch { value = ""; }
  if (!value) return json() ? kitFail("no key given, nothing stored", { code: "bad_input", next: `vyre voice key ${provider}` }) : (out("  no key given, nothing stored"), 1);
  // Saving and granting a key are a person's acts: Touch ID or a code typed at this terminal
  // (read from /dev/tty, so the key can still come in on stdin).
  const put = await callAsPerson("vault.put", { name: item, kind: "api-key", fields: { value }, description: `${provider} key for push-to-talk` });
  value = "";
  if (put.error) return fail(put);
  const g = await callAsPerson("vault.grant", { name: item, module: "voice" });
  if (g.error) return fail(g);
  const grant = g.data.grant;
  if (provider !== "deepgram") {
    const s = await call("voice.settings", { provider });
    if (s.error) return fail(s);
  }
  if (json()) return emit({ stored: item, provider, grant: { status: grant.status, ...(grant.id ? { id: grant.id } : {}) } });
  if (grant.status === "pending") out(`  ${signal("stored")} ${bold(item)} ${beacon("· grant waiting for approval")} ${dim(`vyre vault approve ${grant.id}`)}`);
  else out(`  ${signal("stored")} ${bold(item)} ${dim("· granted to voice")}`);
  return 0;
}

export default {
  name: "voice", order: 70, usage: USAGE, summary: "push-to-talk from the terminal (Enter to talk), status, and the speech key",
  verbs: VERBS,
  /** @param {string[]} all */
  async run(all) {
    const [sub, ...rest] = all.filter(a => a !== "--json");
    if (sub === "status") {
      if (rest.length) return usage(`vyre voice status takes no arguments (got ${rest[0]})`);
      const r = await call("voice.status", {});
      if (r.error) return fail(r);
      const s = r.data;
      if (json()) return emit(s);
      out(`  ${bold(s.provider)} ${dim(s.mode)} · key ${s.key ? signal("saved") : beacon(s.key_state)} · ${s.online ? signal("online") : beacon("offline")}${s.speak ? " · spoken replies on" : ""}`);
      if (!s.key) out(dim(`  save it with: vyre voice key ${s.provider}`));
      return 0;
    }
    if (sub === "key") return key(rest);
    let thread = null;
    const args = sub === undefined ? [] : sub === "talk" ? rest : [sub, ...rest];
    if (args[0] === "--send") {
      thread = args[1];
      if (!thread || args.length > 2) return usage(`vyre voice --send needs one thread`, USAGE);
    } else if (args.length) return usage(`vyre voice ${args[0]}: not a verb`, USAGE);
    // Enter to talk needs a person at a terminal; a surface has its own push-to-talk.
    if (json()) return kitFail("push-to-talk needs a terminal: run vyre voice in one", { code: "needs_terminal", exit: EXIT.USAGE, next: "vyre voice status --json" });
    const onFinal = thread ? async text => {
      const r = await call("threads.send", { thread, text, surface: SURFACE });
      if (r.error) fail(r); else out(dim(`  sent to ${thread}`));
    } : undefined;
    return talkLoop({ socketPath: config.paths(config.home()).socket, onFinal });
  },
};
