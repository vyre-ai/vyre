// @ts-check
// Every fixture here is fictional and inline: example.com hosts, made-up passwords.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { parse, parseFile, parseCSV, merge, plan } from "./import.js";
import { crc32 } from "./zip.js";
import { envEntries } from "./envfiles.js";

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
  // Every line parses as it always did; envEntries is what the import reads.
  assert.deepEqual(Object.fromEntries(envEntries(ENV).entries.map(e => [e.key, e.value])), {
    EXAMPLE_API_KEY: "sk-example-0000-aaaa",
    SINGLE: "literal \\n $not-expanded",
    DOUBLE: 'line one\nline "two" \\ tab\there',
    MULTI: "first\nsecond",
    INLINE: "plain-value-xyz",
    HASH_KEPT: "abc#def",
  });
  // The file is one env-set holding what detect.js calls secret; the rest stays in the file.
  const r = parse(ENV, { filename: "/somewhere/.env.local" });
  assert.equal(r.format, "env");
  assert.equal(r.items.length, 1);
  const [it] = r.items;
  assert.equal(it.kind, "env-set");
  assert.equal(it.name, "somewhere.env.local");
  assert.equal(it.fields.EXAMPLE_API_KEY, "sk-example-0000-aaaa");
  assert.deepEqual([...Object.keys(it.fields), ...(r.kept ?? [])].sort(), ["DOUBLE", "EXAMPLE_API_KEY", "HASH_KEPT", "INLINE", "MULTI", "SINGLE"]);
  assert.match(it.description, /^from \.env\.local · \d+ values?$/);
  assert.deepEqual(it.hosts, []);
  assert.ok(r.skipped.includes("EMPTY: empty value"));
  assert.ok(r.skipped.includes("EMPTY_QUOTED: empty value"));
  assert.ok(r.skipped.some(s => /^line 12:/.test(s)));
  assert.equal(parse("A_TOKEN=abcdefghij0123456789").items[0].name, "env");
});

test("import: detects the format without being told", () => {
  assert.equal(parse(ONEPASSWORD).format, "1password-csv");
  assert.equal(parse(BITWARDEN_CSV).format, "bitwarden-csv");
  assert.equal(parse(BITWARDEN_JSON).format, "bitwarden-json");
  assert.equal(parse(CHROME).format, "chrome-csv");
  assert.equal(parse(SAFARI).format, "apple-csv");
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

// ---------------------------------------------------------------------------------------------
// 1Password .1pux

/** A minimal zip writer: stored or deflated entries. @param {[string, string|Buffer, (0|8)?][]} entries */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [n, d, method = 8] of entries) {
    const data = Buffer.from(d);
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(n);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const PUX = {
  login: "pux-login-pass-7Rq!",
  card: "4111111111111111",
  cvv: "987",
  note: "pux note body with a fictional recovery phrase",
  password: "pux-standalone-secret-5Tz",
  apiKey: "pux-api-key-0000-bbbb",
  apiHost: "api.example.net",
  archived: "pux-archived-pass-2Lk",
  server: "pux-server-root-9Qw",
  attachment: "fictional attachment body",
};
const PUX_TOTP = "otpauth://totp/Example:alex@example.com?secret=GEZDGNBVGY3TQOJQ&issuer=Example";

const EXPORT_DATA = {
  accounts: [{
    attrs: { accountName: "Example Account", email: "alex@example.com" },
    vaults: [{
      attrs: { name: "Personal" },
      items: [
        { uuid: "u1", categoryUuid: "001", state: "active",
          overview: { title: "Example Mail", url: "https://mail.example.com/login", urls: [{ url: "https://mail.example.com/login" }, { url: "https://webmail.example.com" }], tags: ["work"] },
          details: {
            loginFields: [
              { designation: "username", name: "email", value: "alex@example.com" },
              { designation: "password", name: "password", value: PUX.login },
            ],
            notesPlain: "",
            sections: [{ title: "", fields: [{ title: "one-time password", id: "TOTP_1", value: { totp: PUX_TOTP } }] }],
          } },
        { uuid: "u2", categoryUuid: "002", state: "active",
          overview: { title: "Example Card", tags: [] },
          details: { sections: [{ title: "", fields: [
            { title: "cardholder name", id: "cardholder", value: { string: "Alex Example" } },
            { title: "type", id: "type", value: { creditCardType: "Visa" } },
            { title: "number", id: "ccnum", value: { creditCardNumber: "4111 1111 1111 1111" } },
            { title: "verification number", id: "cvv", value: { concealed: PUX.cvv } },
            { title: "expiry date", id: "expiry", value: { monthYear: 203012 } },
            { title: "valid from", id: "validFrom", value: { monthYear: 202501 } },
            { title: "issuing bank", id: "bank", value: { string: "Example Bank" } },
          ] }] } },
        { uuid: "u3", categoryUuid: "003", state: "active",
          overview: { title: "Example Recovery", tags: [] },
          details: { notesPlain: PUX.note, sections: [] } },
        { uuid: "u4", categoryUuid: "005", state: "active",
          overview: { title: "Example Router" },
          details: { password: PUX.password } },
        { uuid: "u5", categoryUuid: "112", state: "active",
          overview: { title: "Example API" },
          details: { notesPlain: "", sections: [{ title: "", fields: [
            { title: "username", id: "username", value: { string: "svc-example" } },
            { title: "credential", id: "credential", value: { concealed: PUX.apiKey } },
            { title: "type", id: "type", value: { menu: "bearer" } },
            { title: "hostname", id: "hostname", value: { string: PUX.apiHost } },
            { title: "expires", id: "expires", value: { date: 1893456000 } },
          ] }] } },
        { uuid: "u6", categoryUuid: "001", state: "archived",
          overview: { title: "Old Example Login", url: "https://old.example.com" },
          details: { loginFields: [{ designation: "password", value: PUX.archived }] } },
        { uuid: "u7", categoryUuid: "110", state: "active",
          overview: { title: "Example Server" },
          details: { notesPlain: "rack 4", sections: [{ title: "Admin", fields: [
            { title: "admin password", id: "admin_console_password", value: { concealed: PUX.server } },
            { title: "address", id: "addr", value: { address: { street: "1 Example Way", city: "Example" } } },
          ] }] } },
        { uuid: "u8", categoryUuid: "006", state: "active", overview: { title: "Example Scan" }, details: {} },
      ],
    }],
  }],
};

const PUX_FILE = zip([
  ["export.attributes", '{"version":3}', 0],
  ["export.data", JSON.stringify(EXPORT_DATA)],
  ["files/", "", 0],
  ["files/doc123__scan.pdf", PUX.attachment],
]);

test("import: 1Password .1pux logins, cards, notes, passwords, API credentials and the rest", () => {
  const r = parseFile(PUX_FILE, { filename: "Export.1pux" });
  assert.equal(r.error, undefined);
  assert.equal(r.format, "1password-1pux");
  const by = Object.fromEntries(r.items.map(i => [i.name, i]));
  assert.deepEqual(Object.keys(by), ["example-mail", "example-card", "example-recovery", "example-router", "example-api", "example-server"]);

  assert.equal(by["example-mail"].kind, "login");
  assert.deepEqual(by["example-mail"].fields, { username: "alex@example.com", password: PUX.login, totp: PUX_TOTP });
  assert.equal(by["example-mail"].url, "https://mail.example.com/login");
  assert.deepEqual(by["example-mail"].hosts, ["https://mail.example.com", "https://webmail.example.com"]);
  assert.deepEqual(by["example-mail"].tags, ["work"]);

  assert.equal(by["example-card"].kind, "card");
  assert.deepEqual(by["example-card"].fields, { holder: "Alex Example", number: PUX.card, expiry: "12/30", cvv: PUX.cvv, "valid-from": "01/25", "issuing-bank": "Example Bank" });
  assert.equal(by["example-card"].description, "Example Card (Visa)");

  assert.deepEqual(by["example-recovery"], { name: "example-recovery", kind: "note", description: "Example Recovery", fields: { text: PUX.note }, hosts: [] });
  assert.equal(by["example-router"].kind, "secret");
  assert.deepEqual(by["example-router"].fields, { value: PUX.password });

  assert.equal(by["example-api"].kind, "api-key");
  assert.deepEqual(by["example-api"].fields, { value: PUX.apiKey, username: "svc-example", type: "bearer", hostname: PUX.apiHost, expires: "2030-01-01" });

  assert.equal(by["example-server"].kind, "note");
  assert.deepEqual(by["example-server"].fields, { text: "rack 4", "admin-password": PUX.server });

  assert.deepEqual(r.skipped, [
    "item 6 (Old Example Login): archived",
    "item 7 (Example Server): field address (address) not imported",
    "item 8 (Example Scan): nothing to import",
    "attachment doc123__scan.pdf not imported",
  ]);
  const out = JSON.stringify(r.skipped);
  for (const v of [...Object.values(PUX), PUX_TOTP, "1 Example Way"]) assert.ok(!out.includes(v), `leaked ${JSON.stringify(v.slice(0, 4))}...`);
  for (const i of r.items) assert.match(i.name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
});

test("import: a .1pux is found by its bytes, and a broken one fails without a value", () => {
  assert.equal(parseFile(PUX_FILE).format, "1password-1pux");
  assert.equal(parseFile(new Uint8Array(PUX_FILE)).items.length, 6);

  const bad = [
    parseFile(zip([["export.attributes", "{}"]]), { filename: "x.1pux" }),
    parseFile(zip([["export.data", `{"accounts": [ "${PUX.password}", `]]), { filename: "x.1pux" }),
    parseFile(zip([["export.data", `{"items": ["${PUX.password}"]}`]])),
    parseFile(Buffer.from(`not a zip ${PUX.password} at all, just some text`), { filename: "x.1pux" }),
    parseFile(Buffer.from(`EXAMPLE=${PUX.password}\n`), { format: "1password-1pux" }),
    parseFile(PUX_FILE.subarray(0, PUX_FILE.length - 30)),
    parseFile(PUX_FILE, { format: "csv" }),
    parse(`{"accounts": []}`, { format: "1password-1pux" }),
  ];
  for (const r of bad) {
    assert.ok(r.error, "an error is reported");
    assert.deepEqual(r.items, []);
    const out = JSON.stringify(r.skipped) + r.error;
    for (const v of [...Object.values(PUX), PUX_TOTP]) assert.ok(!out.includes(v), `leaked in ${r.error}`);
  }
  assert.match(bad[0].error ?? "", /no export\.data/);
  assert.match(bad[1].error ?? "", /not valid JSON/);
  assert.match(bad[5].error ?? "", /could not be read/);
  assert.match(bad[6].error ?? "", /zip archive/);
});

test("parseFile: CSV and .env bytes still go through parse", () => {
  const csv = parseFile(Buffer.from(ONEPASSWORD, "utf8"));
  assert.equal(csv.format, "1password-csv");
  assert.deepEqual(csv.items.map(i => i.name), parse(ONEPASSWORD).items.map(i => i.name));
  const env = parseFile(Buffer.from("\ufeff" + ENV, "utf8"), { filename: "prod.env" });
  assert.equal(env.format, "env");
  assert.deepEqual(env.items, parse(ENV, { filename: "prod.env" }).items);
  assert.match(parseFile(Buffer.from([0x41, 0x3d, 0xff, 0xfe])).error ?? "", /not UTF-8/);
  // @ts-expect-error: not bytes
  assert.ok(parseFile("KEY=value").error);
});

// ---------------------------------------------------------------------------------------------
// Apple Passwords and the import planner (ADR 0028, decision 1). Sample values only.

const APPLE = "Title,URL,Username,Password,Notes,OTPAuth\n" +
  "Northwind Bakery,https://orders.northwind.test/login,alex@northwind.test,sample-apple-1,,otpauth://totp/Northwind:alex?secret=JBSWY3DPEHPK3PXP\n" +
  "Harlow Legal,https://portal.harlow.test,juno,sample-apple-2,a note,\n";

test("import: Apple Passwords is apple-csv, safari-csv is an alias, OTPAuth is the totp field", () => {
  const a = parse(APPLE);
  assert.equal(a.format, "apple-csv");
  assert.equal(a.items.length, 2);
  assert.equal(a.items[0].kind, "login");
  assert.equal(a.items[0].fields.totp, "otpauth://totp/Northwind:alex?secret=JBSWY3DPEHPK3PXP");
  assert.deepEqual(a.items[0].hosts, ["https://orders.northwind.test"]);
  assert.equal(a.items[1].fields.notes, "a note");
  const s = parse(APPLE, { format: "safari-csv" });
  assert.equal(s.format, "safari-csv");
  assert.deepEqual(s.items.map(i => [i.name, i.fields]), a.items.map(i => [i.name, i.fields]));
  assert.deepEqual(parseFile(Buffer.from(APPLE)).items.map(i => i.name), a.items.map(i => i.name));
});

/** @param {string} name @param {string} url @param {string} username @param {string} password */
const login = (name, url, username, password) => ({ name, kind: /** @type {const} */ ("login"), description: name, fields: { username, password }, url, hosts: [new URL(url).origin] });

test("plan: same origin, username and password is same; another password is a conflict", () => {
  const existing = [
    { name: "northwind", kind: "login", origin: "https://orders.northwind.test", username: "alex@northwind.test", password: "sample-pw-1" },
    { name: "harlow", kind: "login", origin: "https://portal.harlow.test", username: "juno", password: "sample-pw-2" },
  ];
  const p = plan(existing, [
    // Another path on the same origin, and the username in other case with spaces: still the same login.
    login("northwind-bakery", "https://orders.northwind.test/account", "  ALEX@Northwind.test ", "sample-pw-1"),
    login("harlow-legal", "https://portal.harlow.test/", "juno", "sample-pw-changed"),
    // Same host, another username: a new login.
    login("harlow-kit", "https://portal.harlow.test", "kit", "sample-pw-3"),
    // Same username on another origin: a new login.
    login("harlow-other", "http://portal.harlow.test", "juno", "sample-pw-2"),
  ]);
  assert.deepEqual(p.same, ["northwind-bakery"]);
  assert.deepEqual(p.conflicts.map(c => ({ name: c.name, existing: c.existing })), [{ name: "harlow-legal", existing: "harlow" }]);
  assert.equal(p.conflicts[0].item.fields.password, "sample-pw-changed");
  assert.deepEqual(p.add.map(i => i.name), ["harlow-kit", "harlow-other"]);
  assert.deepEqual(p.renamed, []);
});

test("plan: a taken name is renamed -2, -3, against the vault and within the batch", () => {
  const existing = [
    { name: "northwind", kind: "login", origin: "https://orders.northwind.test", username: "alex", password: "sample-pw-1" },
    { name: "northwind-2", kind: "note" },
    { name: "recipes", kind: "note" },
  ];
  const note = /** @type {any} */ ({ name: "recipes", kind: "note", description: "recipes", fields: { text: "sample note" }, hosts: [] });
  const p = plan(existing, [
    login("northwind", "https://shop.northwind.test", "alex", "sample-pw-4"),
    // Already the name a rename would pick: it keeps its own name, and the rename goes past it.
    login("northwind-3", "https://mail.northwind.test", "alex", "sample-pw-5"),
    note,
  ]);
  assert.deepEqual(p.renamed, [{ from: "northwind", to: "northwind-4" }, { from: "recipes", to: "recipes-2" }]);
  assert.deepEqual(p.add.map(i => i.name), ["northwind-4", "northwind-3", "recipes-2"]);
  assert.equal(note.name, "recipes", "the input item is not changed");
  // A renamed long name still fits the name rules.
  const long = "n".repeat(128);
  const q = plan([{ name: long, kind: "note" }], [login(long, "https://a.northwind.test", "kit", "sample-pw-6")]);
  assert.match(q.add[0].name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.ok(q.add[0].name.endsWith("-2"));
  // A login with no site is judged by its name alone.
  const r = plan([{ name: "pin", kind: "login", origin: "", username: "", password: "x" }],
    [/** @type {any} */ ({ name: "pin", kind: "login", description: "", fields: { password: "x" }, hosts: [] })]);
  assert.deepEqual(r.same, []);
  assert.deepEqual(r.renamed, [{ from: "pin", to: "pin-2" }]);
});
