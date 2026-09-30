// @ts-check
// A tokenizer for code blocks, not a parser. Fast enough to run on every fenced block in a
// thread, and safe on anything: it never throws, never backtracks catastrophically (every
// pattern is linear in input length), and never returns markup: just {text, cls} runs for
// markdown.js to turn into spans with h(). Unknown languages get no color, not a crash.

/** @typedef {{ text: string, cls: string|null }} Token */

const KEYWORDS = {
  js: "const let var function return if else for while do switch case break continue class extends new this typeof instanceof in of try catch finally throw async await yield import export from as default static get set null undefined true false super void delete",
  ts: "const let var function return if else for while do switch case break continue class extends new this typeof instanceof in of try catch finally throw async await yield import export from as default static get set null undefined true false super void delete interface type enum implements public private protected readonly namespace declare keyof",
  python: "def return if elif else for while class import from as try except finally with lambda pass break continue raise yield async await None True False and or not in is global nonlocal del assert",
  bash: "if then else elif fi for in do done while until case esac function return local export readonly declare set",
};
KEYWORDS.javascript = KEYWORDS.js;
KEYWORDS.typescript = KEYWORDS.ts;

/** Build one combined regex from ordered [cls, source] pairs, first match at a position wins. */
function tokenizer(specs) {
  const re = new RegExp(specs.map(([, src], i) => `(?<g${i}>${src})`).join("|"), "g");
  return code => {
    /** @type {Token[]} */
    const out = [];
    let last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(code))) {
      if (m.index > last) out.push({ text: code.slice(last, m.index), cls: null });
      for (let i = 0; i < specs.length; i++) {
        const g = m.groups && m.groups[`g${i}`];
        if (g !== undefined) { out.push({ text: g, cls: specs[i][0] }); break; }
      }
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++; // never stall on a zero-width match
    }
    if (last < code.length) out.push({ text: code.slice(last), cls: null });
    return out;
  };
}

const kw = list => `\\b(?:${list.trim().split(/\s+/).join("|")})\\b`;
const STRING_JS = "`(?:\\\\.|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'";
const STRING_PY = "\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'";
const STRING_SH = "\"(?:\\\\.|[^\"\\\\])*\"|'[^']*'";
const NUMBER = "\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b";

const TOKENIZERS = {
  js: tokenizer([
    ["tok-comment", "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/"],
    ["tok-string", STRING_JS],
    ["tok-keyword", kw(KEYWORDS.js)],
    ["tok-number", NUMBER],
    ["tok-function", "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()"],
    ["tok-punct", "[{}()\\[\\];,.:?<>=+\\-*/%!&|^~]"],
  ]),
  ts: tokenizer([
    ["tok-comment", "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/"],
    ["tok-string", STRING_JS],
    ["tok-keyword", kw(KEYWORDS.ts)],
    ["tok-number", NUMBER],
    ["tok-function", "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()"],
    ["tok-punct", "[{}()\\[\\];,.:?<>=+\\-*/%!&|^~]"],
  ]),
  json: tokenizer([
    ["tok-string", "\"(?:\\\\.|[^\"\\\\])*\""],
    ["tok-keyword", "\\b(?:true|false|null)\\b"],
    ["tok-number", "-?\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b"],
    ["tok-punct", "[{}\\[\\]:,]"],
  ]),
  bash: tokenizer([
    ["tok-comment", "#[^\\n]*"],
    ["tok-string", STRING_SH],
    ["tok-keyword", kw(KEYWORDS.bash)],
    ["tok-function", "\\$\\{[^}\\n]+\\}|\\$[A-Za-z_][A-Za-z0-9_]*"],
    ["tok-punct", "[|&;()<>{}\\[\\]=]"],
  ]),
  css: tokenizer([
    ["tok-comment", "\\/\\*[\\s\\S]*?\\*\\/"],
    ["tok-string", "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'"],
    ["tok-keyword", "@[a-zA-Z-]+"],
    ["tok-number", "#[0-9a-fA-F]{3,8}\\b|\\b\\d+\\.?\\d*(?:px|em|rem|%|vh|vw|s|ms|deg)?\\b"],
    ["tok-punct", "[{}:;,()]"],
  ]),
  html: tokenizer([
    ["tok-comment", "<!--[\\s\\S]*?-->"],
    ["tok-string", "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'"],
    ["tok-keyword", "<\\/?[a-zA-Z][\\w-]*"],
    ["tok-function", "[a-zA-Z-]+(?==)"],
    ["tok-punct", "\\/?>|[=]"],
  ]),
  python: tokenizer([
    ["tok-comment", "#[^\\n]*"],
    ["tok-string", STRING_PY],
    ["tok-keyword", kw(KEYWORDS.python)],
    ["tok-number", NUMBER],
    ["tok-function", "\\b[A-Za-z_][\\w]*(?=\\s*\\()"],
    ["tok-punct", "[{}()\\[\\]:,.=+\\-*/%!<>]"],
  ]),
};
TOKENIZERS.javascript = TOKENIZERS.js;
TOKENIZERS.typescript = TOKENIZERS.ts;
TOKENIZERS.sh = TOKENIZERS.bash;

/**
 * Tokenize `code` for `lang`. Unknown/missing languages get one plain, uncolored token.
 * @param {string} code
 * @param {string} [lang]
 * @returns {Token[]}
 */
export function highlight(code, lang) {
  const src = code == null ? "" : String(code);
  if (!src) return [];
  const fn = TOKENIZERS[String(lang || "").toLowerCase()];
  return fn ? fn(src) : [{ text: src, cls: null }];
}
