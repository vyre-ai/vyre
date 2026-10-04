// @ts-check
// The import-more formats. Every fixture is made up: alex, juno and kit at Harlow Legal and
// Northwind Bakery, harlow.test, northwind.test and example.com, and sample values only.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { parse, parseFile } from "./import.js";
import { readXML, expiry } from "./import-more.js";
import { crc32 } from "./zip.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEED = "JBSWY3DPEHPK3PXP";
const OTP = `otpauth://totp/Harlow:alex?secret=${SEED}&issuer=Harlow`;
// A password with a comma, a quote and a newline, CSV-quoted.
const HARD = 'sample,pw "q9"\nline-two';
const HARD_CSV = '"sample,pw ""q9""\nline-two"';

/** Every value a fixture holds. None may reach a name, a description, `skipped` or an error. */
const VALUES = [
  "sample,pw", "line-two", SEED, "sample-lp-pass-1", "sample-lp-note-body", "4111111111111111", "sample-cvv-731",
  "12 Harbour Lane", "sample-dl-pass-2", "sample-dl-note-3", "5500005555555559", "sample-cvv-842", "sample-passport-P123",
  "8 Mill Street", "sample-keeper-pass-4", "sample-keeper-custom-5", "sample-keeper-pass-6", "4012888888881881",
  "sample-cvv-953", "sample-np-pass-7", "sample-np-note-8", "3782822463", "sample-cvv-064", "sample-pp-pass-9",
  "sample-pp-note-10", "6011111111111117", "sample-cvv-175", "sample-wifi-11", "sample-pp-csv-12", "sample-en-pass-13",
  "sample-en-note-14", "5105105105105100", "sample-cvv-286", "sample-kp-pass-15", "sample-kp-pass-16", "sample-kp-note-17",
  "sample-kp-custom-18", "sample-kp-bin-19", "sample-kx-pass-20", "sample-ff-pass-21", "sample-edge-pass-22",
  "sample-dl-secnote-23", "sample-np-card-pin-24", "sample-kp-protected-25",
];

// ---------------------------------------------------------------------------------------------
// Fixtures

const LASTPASS = [
  "url,username,password,totp,extra,name,grouping,fav",
  `https://portal.harlow.test/login,alex@harlow.test,${HARD_CSV},${SEED},"a note, with a comma",Harlow Portal,Work\\Clients,1`,
  `http://sn,,,,"sample-lp-note-body",Harlow Wifi,Work,0`,
  `http://sn,,,,"NoteType:Credit Card\nLanguage:en-US\nName on Card:Alex Example\nType:Visa\nNumber:4111111111111111\nSecurity Code:sample-cvv-731\nStart Date:,\nExpiration Date:March,2029\nNotes:card notes",Northwind Card,,0`,
  `http://sn,,,,"NoteType:Address\nLanguage:en-US\nFirst Name:Juno\nLast Name:Example\nCompany:Harlow Legal\nAddress 1:12 Harbour Lane\nCity / Town:Harlow\nZip / Postal Code:00123\nCountry:US\nPhone:{""num"":""5550100"",""ext"":"""",""cc3l"":""USA""}\nNotes:",Juno Home,,0`,
].join("\n");

const DL_CREDENTIALS = "username,username2,username3,title,password,note,url,category,otpSecret\n" +
  `kit@northwind.test,,,Northwind Orders,sample-dl-pass-2,"sample-dl-note-3",https://orders.northwind.test,Shop,${OTP}\n` +
  `,,,Northwind Codes,,,,,${SEED}\n`;
const DL_SECURENOTES = "title,note\nNorthwind Recipe,\"sample-dl-secnote-23\nsecond line\"\n";
const DL_PAYMENTS = "type,account_name,account_holder,cc_number,code,expiration_month,expiration_year,routing_number,account_number,country,issuing_bank\n" +
  "payment_card,Northwind Visa,Kit Example,5500005555555559,sample-cvv-842,7,2030,,,US,Example Bank\n";
const DL_IDS = "type,number,name,issue_date,expiration_date,place_of_issue,state\n" +
  "passport,sample-passport-P123,Kit Example,2020-01-02,2030-01-01,US,\n";
const DL_PERSONAL = "type,title,first_name,middle_name,last_name,login,date_of_birth,place_of_birth,email,email_type,item_name,phone_number,phone_number_type,address,city,state,zip,country\n" +
  "address,,,,,,,,,,Northwind Shop,,,8 Mill Street,Northwind,CA,90001,US\n" +
  "email,,,,,,,,kit@northwind.test,work,Work Mail,,,,,,,\n";

const KEEPER_CSV = [
  `Work,Harlow Portal,juno@harlow.test,sample-keeper-pass-4,https://portal.harlow.test,"line one\nline two",Team Share,Badge PIN,sample-keeper-custom-5,TFC:Keeper,${OTP}`,
  `,Northwind Admin,kit,sample-keeper-pass-6,northwind.test,,`,
  `Personal,Gate Code,,,,"sample-kp-custom-18 is not here",`,
].join("\n");

const KEEPER_JSON = JSON.stringify({
  shared_folders: [],
  records: [
    { title: "Harlow Mail", $type: "login", login: "juno@harlow.test", password: "sample-keeper-pass-4", login_url: "https://mail.harlow.test",
      notes: "", custom_fields: { "$oneTimeCode::1": OTP, "Recovery Hint": "sample-keeper-custom-5" }, folders: [{ folder: "Work" }] },
    { title: "Northwind Amex", $type: "bankCard", custom_fields: {
      "$paymentCard::1": { cardNumber: "4012888888881881", cardExpirationDate: "04/2031", cardSecurityCode: "sample-cvv-953" },
      "$text:cardholderName::1": "Kit Example", "$pinCode::1": "sample-np-card-pin-24" }, folders: [{ shared_folder: "Shop", folder: "Cards" }] },
    { title: "Empty Record", $type: "login" },
  ],
});

const NORDPASS = "name,url,additional_urls,username,password,note,cardholdername,cardnumber,cvc,pin,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,type\n" +
  `Harlow Portal,https://portal.harlow.test,"https://files.harlow.test",alex,sample-np-pass-7,,,,,,,,Work,,,,,,,,,password\n` +
  `Harlow Memo,,,,,"sample-np-note-8, with comma",,,,,,,,,,,,,,,,note\n` +
  `Northwind Card,,,,,,Alex Example,3782822463,sample-cvv-064,,09/28,,Shop,,,,,,,,,credit_card\n` +
  `Juno Address,,,,,,,,,,,00123,,Juno Example,5550100,juno@harlow.test,12 Harbour Lane,,Harlow,US,CA,identity\n` +
  `Work,,,,,,,,,,,,,,,,,,,,,folder\n`;

const PROTON_DATA = {
  version: "1.21.0", userId: "u", encrypted: false,
  vaults: {
    share1: { name: "Personal", items: [
      { itemId: "a", state: 1, data: { metadata: { name: "Harlow Portal", note: "" }, type: "login", extraFields: [],
        content: { itemEmail: "juno@harlow.test", itemUsername: "", password: "sample-pp-pass-9", urls: ["https://portal.harlow.test", "https://m.harlow.test"], totpUri: OTP } } },
      { itemId: "b", state: 1, data: { metadata: { name: "Northwind Memo", note: "sample-pp-note-10" }, type: "note", content: {} } },
      { itemId: "c", state: 1, data: { metadata: { name: "Northwind Visa", note: "" }, type: "creditCard",
        content: { cardholderName: "Kit Example", number: "6011111111111117", verificationNumber: "sample-cvv-175", expirationDate: "2029-05", pin: "" } } },
      { itemId: "d", state: 1, data: { metadata: { name: "Shop Wifi", note: "" }, type: "wifi", content: { ssid: "Northwind Guest", password: "sample-wifi-11" } } },
      { itemId: "e", state: 1, data: { metadata: { name: "Shop Alias", note: "" }, type: "alias", content: {} } },
      { itemId: "f", state: 2, data: { metadata: { name: "Old Login", note: "" }, type: "login", content: { password: "sample-pp-pass-9" } } },
    ] },
  },
};
const PROTON_CSV = "type,name,url,email,username,password,note,totp,createTime,modifyTime,vault\n" +
  `login,Harlow Files,https://files.harlow.test,alex@harlow.test,,sample-pp-csv-12,"multi\nline",,1700000000,1700000000,Work\n` +
  `note,Harlow Memo,,,,,sample-pp-note-10,,1700000000,1700000000,Work\n` +
  `alias,Shop Alias,,,,,,,1700000000,1700000000,Work\n`;

const ENPASS = JSON.stringify({
  folders: [{ uuid: "f1", title: "Work", parent_uuid: "" }, { uuid: "f2", title: "Clients", parent_uuid: "f1" }],
  items: [
    { title: "Harlow Portal", category: "login", note: "", folders: ["f2"], fields: [
      { label: "Username", type: "username", value: "alex", sensitive: 0 },
      { label: "E-mail", type: "email", value: "alex@harlow.test", sensitive: 0 },
      { label: "Password", type: "password", value: "sample-en-pass-13", sensitive: 1 },
      { label: "Website", type: "url", value: "https://portal.harlow.test", sensitive: 0 },
      { label: "TOTP", type: "totp", value: SEED, sensitive: 1 },
      { label: "Security question", type: "text", value: "sample-kp-custom-18", sensitive: 0 },
    ] },
    { title: "Northwind Card", category: "creditcard", note: "", fields: [
      { label: "Cardholder", type: "ccName", value: "Kit Example" },
      { label: "Type", type: "ccType", value: "Mastercard" },
      { label: "Number", type: "ccNumber", value: "5105105105105100" },
      { label: "CVC", type: "ccCvc", value: "sample-cvv-286" },
      { label: "Expiry date", type: "ccExpiry", value: "11/2027" },
      { label: "Old", type: "text", value: "x", deleted: 1 },
    ] },
    { title: "Kit Notes", category: "note", note: "sample-en-note-14", fields: [] },
    { title: "Kit Home", category: "identity", note: "", fields: [
      { label: "First name", type: "text", value: "Kit" }, { label: "Street", type: "text", value: "8 Mill Street" },
      { label: "City", type: "text", value: "Northwind" }, { label: "Country", type: "text", value: "US" },
    ] },
  ],
});

const KEEPASS_XML = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<!-- a KeePassXC export -->
<KeePassFile>
  <Meta><Generator>KeePassXC</Generator><RecycleBinUUID>YmluYmluYmluYmluYmluYg==</RecycleBinUUID></Meta>
  <Root>
    <Group><UUID>cm9vdHJvb3Ryb290cm9vdA==</UUID><Name>Root</Name>
      <Entry><UUID>ZTE=</UUID>
        <String><Key>Title</Key><Value>Harlow &amp; Co Portal</Value></String>
        <String><Key>UserName</Key><Value>juno</Value></String>
        <String><Key>Password</Key><Value ProtectInMemory="True">sample-kp-pass-15 &lt;&#x21;&gt;</Value></String>
        <String><Key>URL</Key><Value>https://portal.harlow.test</Value></String>
        <String><Key>Notes</Key><Value><![CDATA[sample-kp-note-17 <raw> & more]]></Value></String>
        <String><Key>otp</Key><Value>${OTP.replace(/&/g, "&amp;")}</Value></String>
        <String><Key>Badge</Key><Value>sample-kp-custom-18</Value></String>
        <String><Key>Vault PIN</Key><Value Protected="True">c2FtcGxlLWtwLXByb3RlY3RlZC0yNQ==</Value></String>
        <Binary><Key>scan.pdf</Key><Value Ref="0"/></Binary>
        <History><Entry><String><Key>Password</Key><Value>old-history-pass</Value></String></Entry></History>
      </Entry>
      <Group><UUID>d29yaw==</UUID><Name>Work</Name>
        <Group><UUID>Y2xpZW50cw==</UUID><Name>Clients</Name>
          <Entry><UUID>ZTI=</UUID>
            <String><Key>Title</Key><Value>Northwind Codes</Value></String>
            <String><Key>TimeOtp-Secret-Base32</Key><Value>${SEED}</Value></String>
            <String><Key>TimeOtp-Period</Key><Value>60</Value></String>
          </Entry>
          <Entry><UUID>ZTM=</UUID>
            <String><Key>Title</Key><Value>Door Codes</Value></String>
            <String><Key>Notes</Key><Value>front: 1234</Value></String>
          </Entry>
        </Group>
      </Group>
      <Group><UUID>YmluYmluYmluYmluYmluYg==</UUID><Name>Recycle Bin</Name>
        <Entry><String><Key>Title</Key><Value>Deleted</Value></String><String><Key>Password</Key><Value>sample-kp-bin-19</Value></String></Entry>
      </Group>
    </Group>
  </Root>
</KeePassFile>`;

const KEEPASSXC_CSV = `"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"\n` +
  `"Root/Work","Harlow Portal","alex","sample-kx-pass-20","https://portal.harlow.test","",${JSON.stringify(OTP)},"0","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z"\n` +
  `"Root","Northwind 2FA","","","","","${SEED}","0","",""\n` +
  `"Root/Recycle Bin","Gone","kit","sample-kp-bin-19","","","","0","",""\n`;

const FIREFOX = `"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n` +
  `"https://orders.northwind.test","kit@northwind.test","sample-ff-pass-21",,"https://orders.northwind.test","{a1}","1700000000000","1700000000000","1700000000000"\n` +
  `"https://portal.harlow.test","juno",${HARD_CSV},,"","{a2}","1","1","1"\n`;

const EDGE = "name,url,username,password,note\nportal.harlow.test,https://portal.harlow.test/,alex,sample-edge-pass-22,\"a, note\"\n";

// ---------------------------------------------------------------------------------------------
// A minimal zip writer, as in import.test.js.

/** @param {[string, string|Buffer][]} entries */
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [n, d] of entries) {
    const data = Buffer.from(d);
    const body = zlib.deflateRawSync(data);
    const name = Buffer.from(n);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10);
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

const DASHLANE_ZIP = zip([
  ["credentials.csv", DL_CREDENTIALS], ["securenotes.csv", DL_SECURENOTES], ["payments.csv", DL_PAYMENTS],
  ["ids.csv", DL_IDS], ["personalInfo.csv", DL_PERSONAL],
]);
const PROTON_ZIP = zip([["Proton Pass/data.json", JSON.stringify(PROTON_DATA)]]);
const PROTON_ZIP_PGP = zip([["Proton Pass/data.pgp", "-----BEGIN PGP MESSAGE-----\nsample-pp-pass-9\n-----END PGP MESSAGE-----\n"]]);
const KDBX = Buffer.concat([Buffer.from([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5]), Buffer.from("sample-kp-pass-16")]);

/** @param {import("./import.js").Result} r */
const byName = r => Object.fromEntries(r.items.map(i => [i.name, i]));

// ---------------------------------------------------------------------------------------------

test("lastpass-csv: logins with a hard password, secure notes, a card and an address note", () => {
  const r = parse(LASTPASS);
  assert.equal(r.format, "lastpass-csv");
  assert.equal(r.error, undefined);
  const by = byName(r);
  assert.deepEqual(Object.keys(by), ["harlow-portal", "harlow-wifi", "northwind-card", "juno-home"]);
  assert.equal(by["harlow-portal"].kind, "login");
  assert.deepEqual(by["harlow-portal"].fields, { username: "alex@harlow.test", password: HARD, totp: SEED, notes: "a note, with a comma" });
  assert.deepEqual(by["harlow-portal"].tags, ["Work/Clients"]);
  assert.deepEqual(by["harlow-portal"].hosts, ["https://portal.harlow.test"]);
  assert.deepEqual(by["harlow-wifi"].fields, { text: "sample-lp-note-body" });
  assert.equal(by["northwind-card"].kind, "card");
  assert.deepEqual(by["northwind-card"].fields, { number: "4111111111111111", holder: "Alex Example", expiry: "03/29", cvv: "sample-cvv-731", notes: "card notes" });
  assert.equal(by["northwind-card"].description, "Northwind Card (Visa)");
  assert.equal(by["juno-home"].kind, "address");
  assert.deepEqual(by["juno-home"].fields, { name: "Juno Example", company: "Harlow Legal", line1: "12 Harbour Lane", city: "Harlow", postal: "00123", country: "US", phone: "5550100" });
});

test("dashlane: the zip and each CSV on its own; credentials, TOTP-only, notes, cards, IDs, addresses", () => {
  const z = parseFile(DASHLANE_ZIP);
  assert.equal(z.format, "dashlane-zip");
  assert.equal(z.error, undefined);
  const by = byName(z);
  assert.deepEqual(by["northwind-orders"].fields, { username: "kit@northwind.test", password: "sample-dl-pass-2", totp: OTP, notes: "sample-dl-note-3" });
  assert.deepEqual(by["northwind-orders"].tags, ["Shop"]);
  assert.equal(by["northwind-codes"].kind, "authenticator");
  assert.deepEqual(by["northwind-codes"].fields, { totp: SEED });
  assert.deepEqual(by["northwind-recipe"].fields, { text: "sample-dl-secnote-23\nsecond line" });
  assert.equal(by["northwind-visa"].kind, "card");
  assert.deepEqual(by["northwind-visa"].fields, { number: "5500005555555559", holder: "Kit Example", expiry: "07/30", cvv: "sample-cvv-842", "field-issuing-bank": "Example Bank", "field-country": "US" });
  assert.equal(by.passport.kind, "identity");
  assert.deepEqual(by.passport.fields, { name: "Kit Example", number: "sample-passport-P123", issued: "2020-01-02", expiry: "2030-01-01", country: "US", type: "passport" });
  assert.equal(by["northwind-shop"].kind, "address");
  assert.deepEqual(by["northwind-shop"].fields, { line1: "8 Mill Street", city: "Northwind", region: "CA", postal: "90001", country: "US" });
  assert.deepEqual(z.skipped, ["personalInfo.csv row 3 (Work Mail): personal info of type email is not imported"]);
  // Each CSV alone.
  const c = parse(DL_CREDENTIALS);
  assert.equal(c.format, "dashlane-csv");
  assert.equal(c.items.length, 2);
  assert.equal(parse(DL_PAYMENTS).format, "dashlane-csv");
  assert.equal(parse(DL_IDS).items[0].kind, "identity");
  assert.equal(parse(DL_PERSONAL).items[0].kind, "address");
  assert.equal(parse(DL_SECURENOTES, { format: "dashlane-csv" }).items[0].kind, "note");
});

test("keeper: headerless CSV with custom pairs and TFC TOTP, and the JSON export", () => {
  const r = parse(KEEPER_CSV);
  assert.equal(r.format, "keeper-csv");
  const by = byName(r);
  assert.deepEqual(by["harlow-portal"].fields, { username: "juno@harlow.test", password: "sample-keeper-pass-4", totp: OTP, notes: "line one\nline two", "field-badge-pin": "sample-keeper-custom-5" });
  assert.deepEqual(by["harlow-portal"].tags, ["Work", "Team Share"]);
  assert.deepEqual(by["northwind-admin"].hosts, ["https://northwind.test"]);
  assert.equal(by["gate-code"].kind, "note");

  const j = parse(KEEPER_JSON);
  assert.equal(j.format, "keeper-json");
  const jb = byName(j);
  assert.deepEqual(jb["harlow-mail"].fields, { username: "juno@harlow.test", password: "sample-keeper-pass-4", totp: OTP, "field-recovery-hint": "sample-keeper-custom-5" });
  assert.deepEqual(jb["harlow-mail"].tags, ["Work"]);
  assert.equal(jb["northwind-amex"].kind, "card");
  assert.deepEqual(jb["northwind-amex"].fields, { number: "4012888888881881", holder: "Kit Example", expiry: "04/31", cvv: "sample-cvv-953", pin: "sample-np-card-pin-24" });
  assert.deepEqual(jb["northwind-amex"].tags, ["Shop/Cards"]);
  assert.deepEqual(j.skipped, ["record 3 (Empty Record): nothing to import"]);
});

test("nordpass-csv: logins with extra URLs, notes, a card and an identity as an address", () => {
  const r = parse(NORDPASS);
  assert.equal(r.format, "nordpass-csv");
  const by = byName(r);
  assert.deepEqual(Object.keys(by), ["harlow-portal", "harlow-memo", "northwind-card", "juno-address"]);
  assert.deepEqual(by["harlow-portal"].hosts, ["https://portal.harlow.test", "https://files.harlow.test"]);
  assert.deepEqual(by["harlow-memo"].fields, { text: "sample-np-note-8, with comma" });
  assert.deepEqual(by["northwind-card"].fields, { number: "3782822463", holder: "Alex Example", expiry: "09/28", cvv: "sample-cvv-064" });
  assert.equal(by["juno-address"].kind, "address");
  assert.equal(by["juno-address"].fields.line1, "12 Harbour Lane");
  assert.equal(by["juno-address"].fields.region, "CA");
});

test("protonpass: the zip, its data.json, the CSV, and an encrypted export refused", () => {
  const z = parseFile(PROTON_ZIP);
  assert.equal(z.format, "protonpass-zip");
  const by = byName(z);
  assert.deepEqual(Object.keys(by), ["harlow-portal", "northwind-memo", "northwind-visa", "shop-wifi"]);
  assert.deepEqual(by["harlow-portal"].fields, { username: "juno@harlow.test", password: "sample-pp-pass-9", totp: OTP });
  assert.deepEqual(by["harlow-portal"].hosts, ["https://portal.harlow.test", "https://m.harlow.test"]);
  assert.deepEqual(by["harlow-portal"].tags, ["Personal"]);
  assert.deepEqual(by["northwind-visa"].fields, { number: "6011111111111117", holder: "Kit Example", expiry: "05/29", cvv: "sample-cvv-175" });
  assert.equal(by["shop-wifi"].kind, "wifi");
  assert.deepEqual(by["shop-wifi"].fields, { ssid: "Northwind Guest", password: "sample-wifi-11" });
  assert.deepEqual(z.skipped, ["item 5 (Shop Alias): alias items hold no secret and are not imported", "item 6 (Old Login): in the trash"]);
  assert.equal(parse(JSON.stringify(PROTON_DATA)).format, "protonpass-json");

  const c = parse(PROTON_CSV);
  assert.equal(c.format, "protonpass-csv");
  assert.deepEqual(c.items.map(i => [i.name, i.kind]), [["harlow-files", "login"], ["harlow-memo", "note"]]);
  assert.deepEqual(c.items[0].fields, { username: "alex@harlow.test", password: "sample-pp-csv-12", notes: "multi\nline" });

  const enc = parseFile(PROTON_ZIP_PGP);
  assert.equal(enc.format, "protonpass-zip");
  assert.match(enc.error ?? "", /encrypted.*without encryption/);
  const armour = parse("-----BEGIN PGP MESSAGE-----\nsample-pp-pass-9\n-----END PGP MESSAGE-----\n");
  assert.match(armour.error ?? "", /encrypted/);
});

test("enpass-json: login with folders and extras, card, note and an identity address", () => {
  const r = parse(ENPASS);
  assert.equal(r.format, "enpass-json");
  const by = byName(r);
  assert.deepEqual(by["harlow-portal"].fields, { username: "alex", password: "sample-en-pass-13", totp: SEED, "field-security-question": "sample-kp-custom-18", "field-email": "alex@harlow.test" });
  assert.deepEqual(by["harlow-portal"].tags, ["Work/Clients"]);
  assert.deepEqual(by["northwind-card"].fields, { number: "5105105105105100", holder: "Kit Example", expiry: "11/27", cvv: "sample-cvv-286" });
  assert.equal(by["northwind-card"].description, "Northwind Card (Mastercard)");
  assert.deepEqual(by["kit-notes"].fields, { text: "sample-en-note-14" });
  assert.equal(by["kit-home"].kind, "address");
  assert.deepEqual(by["kit-home"].fields, { name: "Kit", line1: "8 Mill Street", city: "Northwind", country: "US" });
});

test("keepass-xml: entities, CDATA, nested groups, TOTP both ways, notes, recycle bin, protected fields", () => {
  const r = parse(KEEPASS_XML);
  assert.equal(r.format, "keepass-xml");
  assert.equal(r.error, undefined);
  const by = byName(r);
  assert.deepEqual(Object.keys(by), ["harlow-co-portal", "northwind-codes", "door-codes"]);
  const p = by["harlow-co-portal"];
  assert.equal(p.description, "Harlow & Co Portal");
  assert.deepEqual(p.fields, { username: "juno", password: "sample-kp-pass-15 <!>", totp: OTP, notes: "sample-kp-note-17 <raw> & more", "field-badge": "sample-kp-custom-18" });
  assert.deepEqual(p.tags, undefined);
  assert.equal(by["northwind-codes"].kind, "authenticator");
  assert.match(by["northwind-codes"].fields.totp, /^otpauth:\/\/totp\/Northwind%20Codes\?secret=JBSWY3DPEHPK3PXP&period=60$/);
  assert.deepEqual(by["northwind-codes"].tags, ["Work/Clients"]);
  assert.deepEqual(by["door-codes"].fields, { text: "front: 1234" });
  assert.deepEqual(r.skipped, [
    "entry 1 (Harlow & Co Portal): field Vault PIN is encrypted in the file and not imported",
    "entry 1 (Harlow & Co Portal): attachment scan.pdf not imported",
    "group Recycle Bin: the recycle bin is not imported",
  ]);
});

test("keepass-xml: a DOCTYPE, bad XML and a .kdbx file are refused without a value", () => {
  const xxe = `<?xml version="1.0"?><!DOCTYPE k [<!ENTITY x SYSTEM "file:///etc/passwd">]><KeePassFile><Root>&x;</Root></KeePassFile>`;
  const d = parse(xxe, { format: "keepass-xml" });
  assert.match(d.error ?? "", /DOCTYPE is refused/);
  assert.equal(parse(xxe).format, "keepass-xml");
  assert.throws(() => readXML("<a>&unknown;</a>"), /unknown entity/);
  assert.throws(() => readXML("<a>&#0;</a>"), /out of range/);
  assert.throws(() => readXML("<a><b></a>"), /does not match/);
  assert.throws(() => readXML("<a>x & y</a>"), /bare &/);
  assert.equal(readXML("<a x='1 &amp; 2'>&#65;&#x42;<![CDATA[<c>]]></a>").text, "AB<c>");
  assert.equal(readXML("<a x='1 &amp; 2'/>").attrs.x, "1 & 2");
  const bad = parse(`<KeePassFile><Root><Group><Entry><String><Key>Password</Key><Value>sample-kp-pass-16</Value></String></Entry></Group></Root>`);
  assert.match(bad.error ?? "", /could not be read \(an element is not closed\)/);
  const k = parseFile(KDBX, { filename: "Harlow.kdbx" });
  assert.equal(k.format, "keepass-xml");
  assert.match(k.error ?? "", /KeePass database.*export it as XML or CSV/);
  assert.match(parseFile(KDBX).error ?? "", /\.kdbx/);
});

test("keepassxc-csv: groups as folders past the root, a standalone TOTP, the recycle bin", () => {
  const r = parse(KEEPASSXC_CSV);
  assert.equal(r.format, "keepassxc-csv");
  const by = byName(r);
  assert.deepEqual(by["harlow-portal"].fields, { username: "alex", password: "sample-kx-pass-20", totp: OTP });
  assert.deepEqual(by["harlow-portal"].tags, ["Work"]);
  assert.equal(by["northwind-2fa"].kind, "authenticator");
  assert.deepEqual(by["northwind-2fa"].fields, { totp: SEED });
  assert.equal(by["northwind-2fa"].tags, undefined);
  assert.deepEqual(r.skipped, ["row 4 (Gone): in the recycle bin"]);
});

test("firefox-csv and the Chromium aliases", () => {
  const f = parse(FIREFOX);
  assert.equal(f.format, "firefox-csv");
  assert.deepEqual(f.items.map(i => i.name), ["orders-northwind-test", "portal-harlow-test"]);
  assert.equal(f.items[1].fields.password, HARD);
  assert.equal(f.items[0].description, "login from Firefox");
  assert.deepEqual(f.items[0].fields, { username: "kit@northwind.test", password: "sample-ff-pass-21" });
  assert.equal(parse(EDGE).format, "chrome-csv");
  for (const fmt of /** @type {const} */ (["edge-csv", "brave-csv", "arc-csv", "opera-csv", "vivaldi-csv"])) {
    const r = parse(EDGE, { format: fmt });
    assert.equal(r.format, fmt);
    assert.deepEqual(r.items.map(i => [i.name, i.fields]), parse(EDGE, { format: "chrome-csv" }).items.map(i => [i.name, i.fields]));
  }
});

test("detection: every format is found without a hint, and older ones still are", () => {
  const cases = /** @type {[string|Buffer, string][]} */ ([
    [LASTPASS, "lastpass-csv"], [DL_CREDENTIALS, "dashlane-csv"], [DASHLANE_ZIP, "dashlane-zip"], [KEEPER_CSV, "keeper-csv"],
    [KEEPER_JSON, "keeper-json"], [NORDPASS, "nordpass-csv"], [PROTON_ZIP, "protonpass-zip"], [JSON.stringify(PROTON_DATA), "protonpass-json"],
    [PROTON_CSV, "protonpass-csv"], [ENPASS, "enpass-json"], [KEEPASS_XML, "keepass-xml"], [KEEPASSXC_CSV, "keepassxc-csv"],
    [FIREFOX, "firefox-csv"], [EDGE, "chrome-csv"],
    ["Title,URL,Username,Password,Notes,OTPAuth\nHarlow,https://harlow.test,juno,sample-x,,\n", "apple-csv"],
    ['{"encrypted":false,"items":[{"type":1,"name":"Harlow","login":{"username":"juno"}}]}', "bitwarden-json"],
  ]);
  for (const [input, want] of cases) {
    const r = typeof input === "string" ? parseFile(Buffer.from(input)) : parseFile(input);
    assert.equal(r.format, want, `detected ${want}`);
    assert.equal(r.error, undefined, `${want}: ${r.error}`);
    for (const i of r.items) assert.match(i.name, NAME);
  }
  // A zip format through parse() is sent to parseFile.
  assert.match(parse("x", { format: "dashlane-zip" }).error ?? "", /parseFile/);
  // A zip that is none of the exports read.
  assert.match(parseFile(zip([["readme.txt", "hello"]])).error ?? "", /not an export read here/);
  assert.equal(expiry("2029-03"), "03/29");
  assert.equal(expiry("Sept 2031"), "09/31");
  assert.equal(expiry("soon"), "soon");
});

test("no value ever reaches a name, a description, skipped or an error", () => {
  const results = [
    ...[LASTPASS, DL_CREDENTIALS, DL_SECURENOTES, DL_PAYMENTS, DL_IDS, DL_PERSONAL, KEEPER_CSV, KEEPER_JSON, NORDPASS,
      JSON.stringify(PROTON_DATA), PROTON_CSV, ENPASS, KEEPASS_XML, KEEPASSXC_CSV, FIREFOX, EDGE].map(t => parse(t)),
    ...[DASHLANE_ZIP, PROTON_ZIP, PROTON_ZIP_PGP, KDBX].map(b => parseFile(b)),
    // Broken inputs that hold values.
    parse('{"records": [ "sample-keeper-pass-4", ', { format: "keeper-json" }),
    parse('{"items": "sample-en-pass-13"', { format: "enpass-json" }),
    parse('{"vaults": ["sample-pp-pass-9"', { format: "protonpass-json" }),
    parse("<KeePassFile><Root>sample-kp-pass-16 & more</Root></KeePassFile>", { format: "keepass-xml" }),
    parse("<KeePassFile><Root><Group><Entry>sample-kp-pass-16</Entrx></Group></Root></KeePassFile>"),
    parse("<!DOCTYPE sample-kp-pass-16><KeePassFile/>", { format: "keepass-xml" }),
    parse("<sample-kp-pass-16/>", { format: "keepass-xml" }),
    parse("sample-lp-pass-1,x\n", { format: "lastpass-csv" }),
    parse("sample-np-pass-7,x\n", { format: "nordpass-csv" }),
    parse("sample-pp-csv-12,x\n", { format: "protonpass-csv" }),
    parse("sample-kx-pass-20,x\n", { format: "keepassxc-csv" }),
    parse("sample-dl-pass-2,x\n", { format: "dashlane-csv" }),
    parse(`name,url,username,password,note,cardholdername,cardnumber,custom_fields,type\nHarlow,,,,,,,"[sample-np-pass-7",password\n`),
    parseFile(zip([["credentials.csv", Buffer.from([0xff, 0xfe, 0x41])]])),
  ];
  let checked = 0;
  for (const r of results) {
    const out = JSON.stringify(r.skipped) + (r.error ?? "") + JSON.stringify(r.items.map(i => [i.name, i.description, i.tags ?? [], i.hosts]));
    for (const v of VALUES) assert.ok(!out.includes(v), `leaked ${JSON.stringify(v.slice(0, 6))}... in ${r.format}`);
    checked++;
  }
  assert.equal(checked, results.length);
  // The broken ones say so.
  for (const r of results.slice(20)) assert.ok(r.error || r.skipped.length, `a broken input reports a reason (${r.format})`);
});
