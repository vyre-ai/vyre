// @ts-check
// Every fixture here is fictional and inline: example.com hosts, made-up passwords.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, parseCSV, merge } from "./import.js";

// A password with a comma, a quote and a newline, as it appears once CSV-quoted.
const HARD = 'correct,horse "7Q!x"\nsecond-line';
const HARD_CSV = '"correct,horse ""7Q!x""\nsecond-line"';
const TOTP = "otpauth://totp/Example:alex@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";

const ONEPASSWORD = [
  "Title,Website,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
  `Example Mail,https://mail.example.com/login,alex@example.com,${HARD_CSV},${TOTP},false,false,work;mail,"a note, with comma"`,
  "Example Mail,https://mail.example.com,sam@example.com,tr0ub4dor-9Z,,false,false,,",
  "Example Mail,https://mail.example.com,sam@example.com,another-pass-4K,,false,false,,",
  ",https://shop.example.org,,shop-pass-1A,,false,false,,",
  "Empty Row,,,,,false,false,,",
].join("\r\n");

const BITWARDEN_CSV = [
  "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
  `Work,1,login,Example Chat,,"pin: 4321",0,https://chat.example.com,alex@example.com,${HARD_CSV},`,
  `,,note,Example Recovery Codes,"code-aaaa-1111\ncode-bbbb-2222",,0,,,,`,
  ",,identity,Example Identity,,,0,,,,",
].join("\n");

const BITWARDEN_JSON = JSON.stringify({
  encrypted: false,
  folders: [{ id: "f1", name: "Personal" }],
  items: [
    { id: "a", type: 1, name: "Example Bank", folderId: "f1", notes: null,
      login: { username: "alex@example.com", password: HARD, totp: TOTP, uris: [{ uri: "https://bank.example.com/signin" }] } },
    { id: "b", type: 2, name: "Example Wifi", notes: "wifi-pass-Hq8!", secureNote: { type: 0 } },
    { id: "c", type: 3, name: "Example Card", notes: null,
      card: { cardholderName: "Alex Example", brand: "Visa", number: "4111 1111 1111 1111", expMonth: "3", expYear: "2029", code: "123" } },
    { id: "d", type: 4, name: "Example Person", identity: { firstName: "Alex" } },
  ],
});

const CHROME = "name,url,username,password,note\n" +
  `mail.example.com,https://mail.example.com/,alex@example.com,${HARD_CSV},\n` +
  ",https://forum.example.net/,,forum-pass-8W,\n";

const SAFARI = "Title,URL,Username,Password,Notes,OTPAuth\n" +
  `Example Photos (alex@example.com),https://photos.example.com/,alex@example.com,${HARD_CSV},,${TOTP}\n`;

const GENERIC = "Name,Login,Password,Web Site\nExample Forum,alex,forum-generic-3P,forum.example.net\n";

const ENV = [
  "# fictional settings",
  "",
  "export EXAMPLE_API_KEY=sk-example-0000-aaaa",
  "SINGLE='literal \\n $not-expanded'",
  'DOUBLE="line one\\nline \\"two\\" \\\\ tab\\there"',
  'MULTI="first',
  'second"',
  "INLINE=plain-value-xyz # trailing comment",
  "HASH_KEPT=abc#def",
  "EMPTY=",
  "EMPTY_QUOTED=\"\"",
  "not a pair line with junk-value-qq",
  "  # indented comment",
].join("\n");

/** Every secret value used in any fixture above. */
const VALUES = [
  HARD, "correct,horse", "7Q!x", "tr0ub4dor-9Z", "another-pass-4K", "shop-pass-1A", "JBSWY3DPEHPK3PXP",
  "4321", "code-aaaa-1111", "wifi-pass-Hq8!", "4111", "forum-pass-8W", "forum-generic-3P",
  "sk-example-0000-aaaa", "literal", "line one", "second", "plain-value-xyz", "abc#def", "junk-value-qq",
];

test("parseCSV: quoted commas, doubled quotes, newlines, CRLF and a BOM", () => {
  const rows = parseCSV('﻿a,b,c\r\n"x,1","say ""hi""","l1\r\nl2"\r\n\r\nlast,,\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["x,1", 'say "hi"', "l1\r\nl2"], ["last", "", ""]]);
  assert.deepEqual(parseCSV("a,b"), [["a", "b"]]);
});

test("import: 1Password CSV with TOTP, a hard password and name collisions", () => {
  const r = parse(ONEPASSWORD, { format: "1password-csv" });
  assert.equal(r.error, undefined);
  const [a, b, c, d] = r.items;
  assert.equal(a.name, "example-mail");
  assert.equal(a.kind, "login");
  assert.equal(a.description, "Example Mail");
  assert.equal(a.fields.password, HARD);
  assert.equal(a.fields.totp, TOTP);
  assert.equal(a.fields.username, "alex@example.com");
  assert.equal(a.fields.notes, "a note, with comma");
  assert.equal(a.url, "https://mail.example.com/login");
  assert.deepEqual(a.hosts, ["https://mail.example.com"]);
  assert.deepEqual(a.tags, ["work", "mail"]);
  assert.equal(b.name, "example-mail-sam-example-com");
  assert.equal(c.name, "example-mail-2");
  assert.equal(d.name, "shop-example-org");
  assert.equal(r.items.length, 4);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /Empty Row/);
  assert.ok(!("totp" in b.fields) && !("notes" in b.fields));
});

test("import: Bitwarden CSV logins, notes and unsupported types", () => {
  const r = parse(BITWARDEN_CSV, { format: "bitwarden-csv" });
  assert.equal(r.items.length, 2);
  const [login, note] = r.items;
  assert.equal(login.name, "example-chat");
  assert.equal(login.fields.password, HARD);
  assert.equal(login.fields["field-pin"], "4321");
  assert.deepEqual(login.tags, ["Work"]);
  assert.deepEqual(login.hosts, ["https://chat.example.com"]);
  assert.equal(note.kind, "note");
  assert.equal(note.fields.text, "code-aaaa-1111\ncode-bbbb-2222");
  assert.match(r.skipped[0], /identity/);
});

test("import: Bitwarden JSON logins, notes and cards", () => {
  const r = parse(BITWARDEN_JSON, { format: "bitwarden-json" });
  assert.equal(r.items.length, 3);
  const [login, note, card] = r.items;
  assert.equal(login.fields.password, HARD);
  assert.equal(login.fields.totp, TOTP);
  assert.deepEqual(login.tags, ["Personal"]);
  assert.deepEqual(login.hosts, ["https://bank.example.com"]);
  assert.equal(note.kind, "note");
  assert.equal(note.fields.text, "wifi-pass-Hq8!");
  assert.equal(card.kind, "card");
  assert.deepEqual(card.fields, { holder: "Alex Example", number: "4111111111111111", expiry: "03/29", cvv: "123" });
  assert.equal(card.description, "Example Card (Visa)");
  assert.match(r.skipped[0], /identity/);
  const enc = parse(JSON.stringify({ encrypted: true, encKeyValidation_DO_NOT_EDIT: "x", data: "y" }));
  assert.match(enc.error ?? "", /encrypted/);
});

test("import: Chrome, Safari and generic CSV", () => {
  const c = parse(CHROME, { format: "chrome-csv" });
  assert.deepEqual(c.items.map(i => i.name), ["mail-example-com", "forum-example-net"]);
  assert.equal(c.items[0].fields.password, HARD);
  const s = parse(SAFARI, { format: "safari-csv" });
  assert.equal(s.items[0].name, "example-photos-alex-example-com");
  assert.equal(s.items[0].fields.totp, TOTP);
  assert.equal(s.items[0].fields.password, HARD);
  const g = parse(GENERIC, { format: "csv" });
  assert.equal(g.items[0].name, "example-forum");
  assert.equal(g.items[0].fields.username, "alex");
  assert.deepEqual(g.items[0].hosts, ["https://forum.example.net"]);
});

test("import: .env with export, quotes, comments, inline comment and empty values", () => {
  const r = parse(ENV, { filename: "/somewhere/.env.local" });
  assert.equal(r.format, "env");
  const v = Object.fromEntries(r.items.map(i => [i.name, i.fields.value]));
  assert.deepEqual(v, {
    EXAMPLE_API_KEY: "sk-example-0000-aaaa",
    SINGLE: "literal \\n $not-expanded",
    DOUBLE: 'line one\nline "two" \\ tab\there',
    MULTI: "first\nsecond",
    INLINE: "plain-value-xyz",
    HASH_KEPT: "abc#def",
  });
  for (const i of r.items) {
    assert.equal(i.kind, "secret");
    assert.equal(i.description, "from .env.local");
    assert.deepEqual(i.hosts, []);
  }
  assert.ok(r.skipped.includes("EMPTY: empty value"));
  assert.ok(r.skipped.includes("EMPTY_QUOTED: empty value"));
  assert.ok(r.skipped.some(s => /^line 12:/.test(s)));
  assert.equal(parse("A=1").items[0].description, "from .env");
});

test("import: detects the format without being told", () => {
  assert.equal(parse(ONEPASSWORD).format, "1password-csv");
  assert.equal(parse(BITWARDEN_CSV).format, "bitwarden-csv");
  assert.equal(parse(BITWARDEN_JSON).format, "bitwarden-json");
  assert.equal(parse(CHROME).format, "chrome-csv");
  assert.equal(parse(SAFARI).format, "safari-csv");
  assert.equal(parse(GENERIC).format, "csv");
  assert.equal(parse(ENV).format, "env");
  assert.equal(parse("anything", { filename: "prod.env" }).format, "env");
  assert.equal(parse("﻿" + CHROME).items.length, 2);
  assert.match(parse("just some prose here").error ?? "", /could not tell/);
});

test("import: merge splits new items from names already present", () => {
  const { items } = parse(CHROME);
  const m = merge(["mail-example-com", "other"], items);
  assert.deepEqual(m.add.map(i => i.name), ["forum-example-net"]);
  assert.deepEqual(m.duplicate, ["mail-example-com"]);
});

test("import: every name is valid", () => {
  for (const text of [ONEPASSWORD, BITWARDEN_CSV, BITWARDEN_JSON, CHROME, SAFARI, GENERIC, ENV]) {
    for (const i of parse(text).items) assert.match(i.name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  }
  const long = "Title,Website,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n" +
    `${"X".repeat(300)},,u1,p-long-1,,,,,\n${"X".repeat(300)},,u1,p-long-2,,,,,\n`;
  const names = parse(long).items.map(i => i.name);
  assert.equal(new Set(names).size, 2);
  for (const n of names) assert.ok(n.length <= 128);
});

test("import: no value ever reaches skipped or an error", () => {
  const broken = [
    ONEPASSWORD, BITWARDEN_CSV, BITWARDEN_JSON, CHROME, SAFARI, GENERIC, ENV,
    '{"items": [ "sk-example-0000-aaaa", ',            // invalid JSON holding a value
    'BROKEN="plain-value-xyz\nnever closed',           // unterminated quote
    "Title,Password\nExample,forum-pass-8W",
  ];
  const withFormats = [
    ...broken.map(t => parse(t)),
    parse('{"items": "sk-example-0000-aaaa"', { format: "bitwarden-json" }),
    parse("x,forum-pass-8W\n", { format: "chrome-csv" }),
  ];
  for (const r of withFormats) {
    const out = JSON.stringify(r.skipped) + (r.error ?? "");
    for (const v of VALUES) assert.ok(!out.includes(v), `leaked ${JSON.stringify(v.slice(0, 4))}...`);
  }
});
