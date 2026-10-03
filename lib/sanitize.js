// @ts-check
// sanitize — keep credentials out of everything Vyre builds from transcripts.
//
// People paste keys into conversations. That is normal and unavoidable; copying them into a
// searchable index is not. A scan of one real index found twenty-one live credentials across
// twelve sessions. So every piece of text the transcripts adapter hands out has been through
// redact() first, and nothing downstream (Recall, Memory, the catalogue) ever sees the original.
//
// The placeholder keeps the SHAPE of a secret, its kind and last four characters, so a
// conversation about "the token" still reads and is still findable while the value is gone.
//
// This never touches the transcripts themselves. They are Claude Code's record, not ours.
//
// Examples in this file are written as prose rather than as NAME=VALUE lines, because the
// redactor is run over its own source by a test and must not report itself.

/**
 * name, pattern, label, and optionally which capture group holds the secret. A rule with no
 * group replaces its whole match; a rule with one replaces only that group, so the name in
 * front of a value survives and "rotate the billing token" stays answerable.
 * @type {Array<[string, RegExp, string, number?]>}
 */
export const PATTERNS = [
  ["digitalocean",  /\bdop_v1_[a-f0-9]{32,}/gi,                                  "DO token"],
  ["openai",        /\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_\-]{20,}/g,            "API key"],
  ["anthropic",     /\bsk-ant-[A-Za-z0-9_\-]{20,}/g,                             "Anthropic key"],
  ["github",        /\bgh[pousr]_[A-Za-z0-9]{30,}/g,                             "GitHub token"],
  ["aws",           /\bAKIA[0-9A-Z]{16}\b/g,                                     "AWS key id"],
  ["aws-secret",    /\b(?<=aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{40}/gi, "AWS secret"],
  ["slack",         /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,                           "Slack token"],
  // App-level (xapp-) and refresh (xoxe-) tokens do not share the xox[baprs] shape, and both
  // authorise a workspace.
  ["slack-app",     /\bxapp-[0-9]-[A-Za-z0-9]+-[0-9]+-[A-Za-z0-9]{16,}/g,        "Slack app token"],
  ["slack-refresh", /\bxoxe(?:\.xoxp)?-[0-9]-[A-Za-z0-9-]{20,}/g,                 "Slack refresh token"],
  ["google",        /\bAIza[0-9A-Za-z_\-]{30,}/g,                                "Google key"],
  ["jwt",           /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{6,}/g, "JWT"],
  ["bearer",        /\bBearer\s+[A-Za-z0-9._\-]{24,}/g,                          "bearer token"],
  ["tailscale",     /\btskey-[a-z]+-[A-Za-z0-9]{10,}/g,                          "Tailscale key"],
  // The publishable key (pk_) is not a secret, it ships in client code on purpose. It is listed
  // so nobody reading the index mistakes one for a leak.
  ["stripe",        /\b[prs]k_(?:live|test)_[A-Za-z0-9]{20,}/g,                  "Stripe key"],
  ["sendgrid",      /\bSG\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/g,           "SendGrid key"],
  // A password glued to -p, scoped to the clients that take one that way. Unscoped, -p collides
  // with -parameters, -prefix, -printf, -pthread and friends; spaced, bare -p means "prompt me"
  // and the next word is the database name.
  ["db-flag-password", /\b(?:mysql|mysqldump|mariadb|psql|mongosh?|redis-cli)\b[^\n]{0,120}?\s-p([^\s]{8,})/g, "password", 1],
  // curl's -u takes user and password joined by a colon, which is what makes it unambiguous.
  ["curl-userpass", /\B-u\s+[^\s:]{1,64}:([^\s]{6,})/g,                          "password", 1],
  ["deepgram",      /\b(?<=deepgram[_-]?(?:api[_-]?)?key\s*[=:]\s*["']?)[a-f0-9]{32,}/gi, "Deepgram key"],
  ["pem",           /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private key"],
  // A key block with no end takes the rest of the text with it. Matching the header alone once
  // counted a hit, replaced thirty characters and indexed the base64 body right after it: a
  // clipped turn or a streamed paste loses its END line all the time. Over-redacting the tail
  // of a truncated paste is the cheap mistake.
  ["pem-open",      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g,               "private key"],

  // ---- opaque values, which is what most credentials are ----
  //
  // Everything above recognises a vendor prefix. Measured on a real index, 58 turns carried a
  // secret-named assignment and only 2 carried any prefix at all; four of the 58 were live.

  // A password in a connection string: no prefix and no word "password", and pasted constantly.
  ["conn-url",      /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@\/?#]+):([^\s@\/?&=#]{3,})@/gi, "url password", 2],
  // A value behind a name that means secret. The name must MEAN it, so PATH and NODE_ENV are
  // untouched. Placeholders such as a dollar-brace reference or angle brackets are left alone.
  ["password",      /(?:^|[\s{,"'`_-])((?:[A-Za-z0-9_.-]*[_.-])?pass(?:word|wd)?|passphrase)["']?\s*[:=]\s*["']?((?!\$\{|<|your|xxx|process\.env)[^\s"',;}\n]{8,})/gi, "password", 2],
  // Parentheses are excluded from the value because a credential never has one and code always
  // does; without that, a key derivation call in ordinary source read as a leak. A name ending
  // in _FILE or _PATH points at a secret rather than holding one.
  ["named-secret",  /\b(?:export\s+)?["']?((?:[A-Za-z0-9_.-]*[_.-])?(?:apikey|apisecret|authtoken|accesstoken|accesskey|secretkey|privatekey|clientsecret|refreshtoken|sessiontoken|token|secret|key|password|passwd|passphrase|credential|auth)(?:[_.-][A-Za-z0-9_.-]*)?)(?<!_FILE)(?<!_PATH)(?<!_file)(?<!_path)["']?\s*[:=]\s*["']?((?!\$\{|<|your|xxx|\.\.\.|changeme|placeholder|example|process\.env|import\.meta|\.{0,2}\/)[^\s"',;}()\n]{12,})/gi, "secret", 2],
  // camelCase names, which the rule above cannot reach: apiKey has no separator before Key,
  // only a change of case. Deliberately case-sensitive, or MONKEY and KEYBOARD match again.
  ["camel-secret",  /\b([a-z][A-Za-z0-9]*(?:Key|Secret|Token|Password|Passphrase|Credential|Auth))["']?\s*[:=]\s*["']?((?!\$\{|<|your|xxx|process\.env)[^\s"',;}()\n]{12,})/g, "secret", 2],
];

// Names that contain a secret word and are not secrets: a token count is a number, a cache key
// is an identifier, a keychain is a file, a secretary is a person. Excluded by name, because a
// cache key and a real secret key base have the same shape and only the name tells them apart.
const NOT_SECRET_NAME = /^(?:.*_(?:count|id|ids|name|names|length|size|type|version|at|on)|cache_key|idempotency_key|keychain|secretar\w*|authors?|public_key|ssh_public_key|.*_public_key)$/i;

/**
 * Replace each secret with a marker that keeps its kind and last four characters.
 * Never throws, whatever it is given: a transcript is JSON written by something else.
 * @param {unknown} text
 * @returns {{ text: string, hits: string[] }}
 */
export function redact(text) {
  if (text === null || text === undefined || text === "") return { text: "", hits: [] };
  let out = String(text);
  /** @type {string[]} */
  const hits = [];
  for (const [name, re, label, group] of PATTERNS) {
    out = out.replace(re, (m, ...rest) => {
      // For a name/value rule the first group is the NAME, and some names contain a secret word
      // without meaning one.
      if (group === 2 && NOT_SECRET_NAME.test(String(rest[0] || ""))) return m;
      const secret = group ? String(rest[group - 1] ?? m) : m;
      if (!secret || secret.length < 8) return m;
      // Placeholders help nobody when redacted, and markers must never be redacted again, or
      // every re-index would chew further into the text.
      if (/^(\[|x{4,}|\*{4,}|<[^>]+>|\$\{?\w+\}?|redacted|changeme|your[-_])/i.test(secret)) return m;
      // The checks below apply only to generic name/value rules. A vendor rule has already
      // proved what it found by its prefix; a SendGrid key is literally dotted words.
      if (group) {
        // A dotted identifier is code: a token assigned from an accessor call.
        if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(secret)) return m;
        // A CONSTANT or a TypeName is a variable, not a credential. Narrower than "letters
        // only", because a chosen passphrase can be letters only.
        if (/^[A-Z][A-Z0-9_]*$/.test(secret) || /^[A-Z][A-Za-z_$]*$/.test(secret)) return m;
        // Words joined by hyphens or underscores are prose or configuration. The password rule
        // is exempt: a chosen password may well be four hyphenated words.
        if (name !== "password" && /^[A-Za-z_$]+(?:[-_][A-Za-z_$]+)+$/.test(secret)) return m;
        // A shell or sed fragment, which deployment scripts are full of.
        if (/^[.*$|\\]/.test(secret)) return m;
      }
      hits.push(name);
      const marker = `[${label} redacted …${secret.slice(-4)}]`;
      return group ? m.replace(secret, marker) : marker;
    });
  }
  return { text: out, hits };
}

/** The kinds of secret in a text, without changing it. */
export const scan = (/** @type {unknown} */ text) => redact(text).hits;
