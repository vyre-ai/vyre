// @ts-check
// keyfind: recognises an API key or token a page shows. Pure functions over a string and a short
// label, so they are tested without a browser; keychip.js is the only caller in the page.
//
// Why it is built this way:
//   - Two ways in. A provider prefix (sk-ant-, ghp_, xoxb-, AKIA...) is enough on its own. A
//     generic high-entropy string counts only when the element is labelled key, token or secret.
//   - The prefix table is a copy of the provider rows in core/vault/detect.js, which the box runs
//     again on the value before it stores anything (fill-key.js). keyfind.test.js checks that
//     every shape accepted here is one detect.js calls a secret with the same provider, so the
//     two cannot drift. A shape the box would not accept never raises a chip.
//   - It never returns or keeps anything but the matched value and a provider word.
//   - Nothing that looks like a UUID, a git or file hash, an image, a placeholder or a run of one
//     character is ever a key.

(() => {
  const g = /** @type {any} */ (globalThis);
  if (g.vyreKeyFind) return;

  /** @type {Array<[RegExp, string, ("live"|"test")?]>} Provider rows from detect.js: shape, provider. */
  const PREFIXES = [
    [/^sk-ant-[\w-]{20,}$/, "anthropic"],
    [/^sk-or-[\w-]{20,}$/, "openrouter"],
    [/^sk-(proj|svcacct|admin)-[\w-]{20,}$/, "openai"],
    [/^sk-[A-Za-z0-9]{48,}$/, "openai"],
    [/^(sk|rk)_live_[A-Za-z0-9]{16,}$/, "stripe", "live"],
    [/^(sk|rk)_test_[A-Za-z0-9]{16,}$/, "stripe", "test"],
    [/^whsec_[A-Za-z0-9+/=]{16,}$/, "stripe"],
    [/^ghp_[A-Za-z0-9]{30,}$/, "github"],
    [/^github_pat_[A-Za-z0-9_]{40,}$/, "github"],
    [/^(gho|ghu|ghr)_[A-Za-z0-9]{30,}$/, "github"],
    [/^ghs_[A-Za-z0-9]{30,}$/, "github"],
    [/^glpat-[\w-]{20,}$/, "gitlab"],
    [/^xox[pare]-[A-Za-z0-9-]{10,}$/, "slack"],
    [/^xoxb-[A-Za-z0-9-]{10,}$/, "slack"],
    [/^xapp-[A-Za-z0-9-]{10,}$/, "slack"],
    [/^(AKIA|ASIA)[A-Z0-9]{16}$/, "aws"],
    [/^AIza[\w-]{35}$/, "google"],
    [/^GOCSPX-[\w-]{20,}$/, "google"],
    [/^SG\.[\w-]{16,}\.[\w-]{16,}$/, "sendgrid"],
    [/^re_[A-Za-z0-9_]{16,}$/, "resend"],
    [/^key-[0-9a-f]{32}$/, "mailgun"],
    [/^SK[0-9a-f]{32}$/, "twilio"],
    [/^npm_[A-Za-z0-9]{36}$/, "npm"],
    [/^pypi-[\w-]{50,}$/, "pypi"],
    [/^hf_[A-Za-z0-9]{30,}$/, "huggingface"],
    [/^dop_v1_[a-f0-9]{64}$/, "digitalocean"],
    [/^pplx-[A-Za-z0-9]{40,}$/, "perplexity"],
    [/^lin_api_[A-Za-z0-9]{32,}$/, "linear"],
    [/^sntry[su]_[A-Za-z0-9+/=_]{40,}$/, "sentry"],
    [/^pcsk_[A-Za-z0-9_]{20,}$/, "pinecone"],
    [/^jina_[A-Za-z0-9_]{20,}$/, "jina"],
    [/^apify_api_[A-Za-z0-9]{20,}$/, "apify"],
    [/^sb_secret_[\w-]{16,}$/, "supabase"],
  ];

  const MAX = 300;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HASH = /^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{56}$|^[0-9a-f]{64}$|^[0-9a-f]{128}$/i;
  const IMAGE = /^data:|^(iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|PHN2Zy|AAABAA)/;
  const PLACEHOLDER = /x{4,}|\*{4,}|•{3,}|\.{4,}|<[^>]*>|\{\{|\[[^\]]*\]|your[-_ ]?(api|secret|key|token)|api[-_ ]?key[-_ ]?here|insert|placeholder|example|changeme|redacted|dummy|sample|todo|\bfake\b/i;
  /** Words that say a label is about a key or token the person will use. */
  const LABEL = /\b(api[ _-]?keys?|secret[ _-]?keys?|access[ _-]?(keys?|tokens?)|auth[ _-]?tokens?|bearer|tokens?|secrets?|client[ _-]?secret|new key|your key|key)\b/i;
  /** Labels that name something that is not a credential to keep. */
  const NOT_LABEL = /\b(public|publishable|site[ _-]?key|recaptcha|hcaptcha|password|passphrase|license|licence|ssh|fingerprint|checksum|hash|sha\d*|commit|session id|csrf|nonce|promo|coupon|invite|referral|tracking)\b/i;

  /** Shannon entropy in bits per character. @param {string} v */
  function entropy(v) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const ch of v) counts.set(ch, (counts.get(ch) || 0) + 1);
    let h = 0;
    for (const n of counts.values()) { const p = n / v.length; h -= p * Math.log2(p); }
    return h;
  }

  /** @param {string} v */
  const classes = v => (/[a-z]/.test(v) ? 1 : 0) + (/[A-Z]/.test(v) ? 1 : 0) + (/\d/.test(v) ? 1 : 0);

  /** True for a value that can never be a key, whatever its label says. @param {string} v */
  function never(v) {
    if (UUID.test(v) || HASH.test(v) || IMAGE.test(v) || PLACEHOLDER.test(v)) return true;
    if (/(.)\1{7,}/.test(v)) return true;
    return false;
  }

  /**
   * The provider a value's own shape names, or null. A value of one repeated few characters
   * (a template filled with filler) is not a key even when its prefix fits.
   * @param {string} value
   * @returns {{ provider: string, mode?: "live"|"test" }|null}
   */
  function shape(value) {
    const v = String(value);
    if (v.length < 16 || v.length > MAX || never(v)) return null;
    for (const [re, provider, mode] of PREFIXES) {
      if (!re.test(v)) continue;
      // What follows the prefix must look drawn at random, not typed.
      const tail = v.replace(/^[A-Za-z0-9]{2,12}[-_.]/, "").replace(/^(sk|pk|rk|xox[a-z]|AKIA|ASIA)[-_]?/, "");
      if (new Set(tail).size < 8) return null;
      return { provider, ...(mode ? { mode } : {}) };
    }
    return null;
  }

  /**
   * Long, dense, mixed and not prose: most likely generated. Same idea as detect.js's check.
   * @param {string} v
   */
  function generic(v) {
    if (v.length < 20 || v.length > MAX || /\s/.test(v) || never(v)) return false;
    if (!/^[A-Za-z0-9_\-+/=.]+$/.test(v)) return false;
    return classes(v) >= 2 && entropy(v) >= 3.5;
  }

  /**
   * Whether a label reads as a key or token label, and a short lower case version to name the
   * item after ("api key", "client secret"). Only the matched words leave, never the surroundings.
   * @param {string} text
   * @returns {string|null}
   */
  function labelOf(text) {
    const t = String(text || "").slice(0, 400);
    if (NOT_LABEL.test(t)) return null;
    const m = LABEL.exec(t);
    return m ? m[1].toLowerCase().replace(/[ _-]+/g, " ") : null;
  }

  /**
   * Decide about one value a page shows.
   * @param {{ value: string, label?: string, kind?: string }} o
   *   label: the text around the element (its label, name, id, nearby words).
   *   kind: "password" for a password input, which is login save's, never a key.
   * @returns {{ value: string, provider: string|null, generic: boolean, label: string|null }|null}
   */
  function candidate({ value, label = "", kind = "" }) {
    if (kind === "password") return null;
    const v = String(value == null ? "" : value).trim();
    if (!v) return null;
    const said = labelOf(label);
    const s = shape(v);
    if (s) return { value: v, provider: s.provider, generic: false, label: said };
    if (said && generic(v)) return { value: v, provider: null, generic: true, label: said };
    return null;
  }

  /**
   * A small stable number for a value (53-bit, cyrb53). It stands for the value in messages and
   * in the once-only set, so the value itself is not sent before the person taps Save.
   * @param {string} s
   */
  function fingerprint(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  g.vyreKeyFind = { shape, generic, labelOf, candidate, fingerprint, MAX };
})();
