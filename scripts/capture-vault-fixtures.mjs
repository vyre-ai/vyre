// Record what a real vyred answers for the Vault's reads, so the app's Vault screens are shot against real shapes with no box behind them (apps/app/screens/vault/real-box.fixture.json).
//   node scripts/capture-vault-fixtures.mjs        (on a test box: a temp home, a file keystore, fake values; never touches a real vault)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { present } from "../test/helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-vault-fx-"));
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "fixture-box", role: "box", vault: { keystore: "file" } }));
const d = await start({ root, presence: present, log: () => {} });
const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
const out = {};
try {
  const put = async (name, kind, fields, extra = {}) => { const r = await cli("vault.put", { name, kind, fields, ...extra }); if (r.error) console.log(`put ${name}: ${r.error.code} ${r.error.message}`); return r; };
  await put("Gmail", "login", { username: "intake@juniperstudio.example.com", password: "Tr0ub4dor&3-x9" }, { url: "https://mail.google.com/login", description: "Intake inbox" });
  await put("Clio", "login", { username: "alex@juniperstudio.example.com", password: "password1" }, { url: "https://app.clio.com" });
  await put("Passport-portal", "login", { username: "alex.rivera", password: "password1" }, { url: "https://travel.state.gov" });
  await put("Airline-account", "login", { username: "alex@example.com", password: "k3Jq!zP0xN7wLm4R", totp: "JBSWY3DPEHPK3PXP" }, { url: "https://airline.example.com" });
  await put("Stripe-key", "api-key", { value: "sk_test_fixturefixturefixture00" }, { description: "Billing", hosts: ["https://api.stripe.com"] });
  await put("OpenAI-key", "api-key", { value: "sk-fixturefixturefixturefixture00" }, { description: "Drafting", hosts: ["https://api.openai.com"] });
  await put("Corporate-card", "card", { number: "4242424242424242", expiry: "12/28", cvc: "123" }, { description: "Firm Visa" });
  await put("Deploy-token", "secret", { value: "ghp_fixturefixturefixturefixturefixtu" });
  const reads = ["vault.list", "vault.state", "vault.caps", "vault.health", "vault.pass.list", "vault.pending", "vault.devices", "vault.vaults.list", "vault.people", "vault.emergency.list", "vault.codes", "vault.account.status"];
  for (const t of reads) { const r = await cli(t, {}); out[t] = r.error ? { error: r.error } : { data: r.data }; }
  out["vault.uses"] = { data: { uses: [] } };
  out["vault.history"] = { data: { versions: [] } };
  out["vault.audit"] = { data: { events: [] } };
} finally { await d.stop(); }
const file = path.join(REPO, "apps/app/screens/vault/real-box.fixture.json");
// Never a value: the fixture holds the reads' answers only (names, kinds, hosts, counts).
const text = JSON.stringify(out, null, 1) + "\n";
for (const secret of ["Tr0ub4dor", "sk_test_fixture", "sk-fixture", "ghp_fixture", "4242424242424242", "JBSWY3DP", "k3Jq!zP0"]) if (text.includes(secret)) throw new Error(`a value reached the fixture: ${secret}`);
fs.writeFileSync(file, text);
console.log(`wrote ${path.relative(REPO, file)} (${Object.keys(out).length} answers)`);
