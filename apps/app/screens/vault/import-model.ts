// The pure half of the Vault's import page: the managers a person can bring passwords in from, what a preview says in plain words, and the words for a result or a refusal. Names and counts only;
// nothing here ever holds a value (the box reads the file, the app sends its bytes once and keeps nothing).

/** What vault.import.preview answers (core/vault/vault.js importPreview). Names, kinds and counts. */
export type Preview = {
  format: string; token?: string; counts: Record<string, number>; add: string[]; same: string[];
  conflicts: { name: string; existing: string }[]; renamed: { from: string; to: string }[]; skipped: string[];
};
/** What vault.import answers. */
export type Imported = {
  format: string; added: string[]; updated: string[]; same: string[]; conflicts: string[]; renamed: { from: string; to: string }[]; skipped: string[];
  rewritten?: string[]; unchanged?: string[]; committed?: string[]; advice?: string;
};
/** One .env file from vault.env.scan. */
export type ScanFile = { project: string | null; file: string; secrets: number; kinds: string[]; git: { tracked: boolean; ignored: boolean } | null };
export type Scan = { files: ScanFile[]; scanned: number; templates: number; truncated: boolean };

/** One place a person keeps passwords today, and how to get a file out of it. `accept` is what the file picker offers. */
export type Source = { id: string; name: string; how: string; accept: string; note?: string };

const CSV = ".csv,text/csv";
/** The fifteen the import code reads, in the order people ask for them. The box works out the format from the file itself, so a wrong pick still imports. */
export const SOURCES: Source[] = [
  { id: "1password", name: "1Password", how: "File, then Export, then choose 1PUX or CSV.", accept: ".1pux,.csv,.zip" },
  { id: "bitwarden", name: "Bitwarden", how: "Tools, then Export vault. Choose .json or .csv, not the encrypted file.", accept: ".json,.csv" },
  { id: "lastpass", name: "LastPass", how: "Advanced Options, then Export. It saves a .csv.", accept: CSV },
  { id: "dashlane", name: "Dashlane", how: "File, then Export, then Credentials. Choose CSV or the zip.", accept: ".csv,.zip,.dash" },
  { id: "keeper", name: "Keeper", how: "Settings, then Export. Choose CSV or JSON.", accept: ".csv,.json" },
  { id: "nordpass", name: "NordPass", how: "Settings, then Export items. It saves a .csv.", accept: CSV },
  { id: "proton", name: "Proton Pass", how: "Settings, then Export. Choose zip or CSV, and leave PGP encryption off.", accept: ".zip,.csv,.json" },
  { id: "enpass", name: "Enpass", how: "File, then Export, then JSON.", accept: ".json" },
  { id: "keepass", name: "KeePass or KeePassXC", how: "Database, then Export. Choose XML or CSV. The .kdbx file itself is encrypted and cannot be read.", accept: ".xml,.csv" },
  { id: "apple", name: "Apple Passwords", how: "In Passwords, File, then Export All Passwords. It saves a .csv.", accept: CSV },
  { id: "chrome", name: "Chrome", how: "Settings, then Google Password Manager, then Settings, then Export passwords.", accept: CSV },
  { id: "chromium", name: "Edge, Brave, Arc, Opera or Vivaldi", how: "Open the browser's password settings and choose Export. They all save a .csv.", accept: CSV },
  { id: "firefox", name: "Firefox", how: "Open about:logins, then the menu, then Export Logins.", accept: CSV },
  { id: "safari", name: "Safari", how: "File, then Export, then Passwords. It saves a .csv.", accept: CSV },
  { id: "env", name: "A .env file", how: "Choose the file. To find the ones on your computer instead, use Your projects.", accept: ".env,.txt,text/plain" },
];

/** The manager a detected format belongs to, for "Looks like a Bitwarden export". */
const FORMAT_NAME: Record<string, string> = {
  env: ".env file", "1password-csv": "1Password", "1password-1pux": "1Password", "bitwarden-csv": "Bitwarden", "bitwarden-json": "Bitwarden", "chrome-csv": "Chrome",
  "apple-csv": "Apple Passwords", "safari-csv": "Safari", csv: "password", "edge-csv": "Edge", "brave-csv": "Brave", "arc-csv": "Arc", "opera-csv": "Opera", "vivaldi-csv": "Vivaldi",
  "firefox-csv": "Firefox", "lastpass-csv": "LastPass", "dashlane-csv": "Dashlane", "dashlane-zip": "Dashlane", "keeper-csv": "Keeper", "keeper-json": "Keeper", "nordpass-csv": "NordPass",
  "protonpass-csv": "Proton Pass", "protonpass-json": "Proton Pass", "protonpass-zip": "Proton Pass", "enpass-json": "Enpass", "keepass-xml": "KeePass", "keepassxc-csv": "KeePassXC",
};
export const formatName = (format: string): string => FORMAT_NAME[format] ?? "password";

const KIND_WORDS: Record<string, [string, string]> = {
  login: ["login", "logins"], note: ["note", "notes"], card: ["card", "cards"], secret: ["key", "keys"], "api-key": ["key", "keys"], "env-set": ["key set", "key sets"],
  authenticator: ["code", "codes"], address: ["address", "addresses"], identity: ["identity", "identities"], wifi: ["Wi-Fi network", "Wi-Fi networks"],
};
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "96 logins, 20 notes and 3 cards", the biggest first; keys of one kind share a word. */
export function kindsLine(counts: Record<string, number>): string {
  const by = new Map<string, number>();
  for (const [k, n] of Object.entries(counts)) {
    if (!n) continue;
    const w = KIND_WORDS[k] ?? [k, `${k}s`];
    by.set(w[1], (by.get(w[1]) ?? 0) + n);
  }
  const parts = [...by.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${n === 1 ? (Object.values(KIND_WORDS).find((x) => x[1] === w)?.[0] ?? w) : w}`);
  return parts.length < 2 ? parts[0] ?? "" : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export type PreviewView = {
  /** "Bitwarden, 148 items" */
  title: string;
  /** What comes in, what is here already, what differs. */
  fresh: number; here: number; differ: number;
  kinds: string;
  /** The first names that will come in, and how many more. */
  names: string[]; more: number;
  differs: string[]; renamed: string[]; skipped: string[];
  /** Nothing to bring in. */
  empty: boolean;
};

export function previewView(p: Preview, show = 6): PreviewView {
  const total = Object.values(p.counts ?? {}).reduce((a, b) => a + b, 0);
  const fresh = p.add.length;
  return {
    title: `${formatName(p.format)} export, ${plural(total, "item", "items")}`,
    fresh, here: p.same.length, differ: p.conflicts.length, kinds: kindsLine(p.counts ?? {}),
    names: p.add.slice(0, show), more: Math.max(0, fresh - show),
    differs: p.conflicts.map((c) => c.existing), renamed: p.renamed.map((r) => `${r.from} will be called ${r.to}, because that name is taken.`), skipped: p.skipped,
    empty: fresh === 0 && p.conflicts.length === 0,
  };
}

/** The button: one yes for everything the preview showed. With differing items the choice is made first, so the label counts what will actually change. */
export function importLabel(v: PreviewView, useFile: boolean): string {
  const n = v.fresh + (useFile ? v.differ : 0);
  return n ? `Import ${plural(n, "item", "items")}` : "Nothing to import";
}

/** The result in one sentence, then what to do about the file. */
export function resultLine(r: Imported): string {
  const n = r.added.length;
  const bits = [n ? `${plural(n, "item is", "items are")} in your Vault.` : "Nothing new was added."];
  if (r.updated.length) bits.push(`${plural(r.updated.length, "item", "items")} got a new version; the old one stays in its history.`);
  if (r.same.length) bits.push(`${r.same.length} ${r.same.length === 1 ? "was" : "were"} already there.`);
  if (r.conflicts.length) bits.push(`${plural(r.conflicts.length, "item differs and was", "items differ and were")} left as it is.`);
  return bits.join(" ");
}

/** Our own sentences for a refused preview or import. */
export function importRefusal(code: string | undefined, message: string): string {
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
  if (code === "locked" || code === "vault_locked") return "Unlock the Vault first, then choose the file again.";
  if (code === "denied" || code === "forbidden") return "This device may not import into the Vault.";
  // The box's own words for a file it cannot read ("this is a KeePass database (.kdbx), which is encrypted ...") are written for a person and carry no value.
  return message || "The file could not be imported. Nothing was changed.";
}

// ---- the project scan --------------------------------------------------------------------

/** The folder a .env sits in, for a row title: the last two parts of its path. */
export function whereLine(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return parts.slice(-3, -1).join("/") || parts[parts.length - 1] || file;
}
export const fileName = (file: string): string => file.split(/[\\/]/).filter(Boolean).pop() ?? file;

export type ScanGroup = { project: string; files: (ScanFile & { where: string; line: string; warn: string })[]; secrets: number };

/** The files grouped by project, the biggest first, each with a plain line ("4 keys: Stripe, OpenAI") and a git warning when its values are in history. */
export function scanGroups(s: Scan): ScanGroup[] {
  const by = new Map<string, ScanGroup>();
  for (const f of s.files) {
    const project = f.project || whereLine(f.file).split("/")[0] || "Other folders";
    const g = by.get(project) ?? { project, files: [], secrets: 0 };
    const kinds = f.kinds.slice(0, 3).map(brandOf).join(", ");
    const warn = f.git?.tracked ? "Committed to git, so the old values stay in its history. Change them at the provider." : f.git && !f.git.ignored ? "Not in .gitignore yet." : "";
    g.files.push({ ...f, where: whereLine(f.file), line: `${plural(f.secrets, "key", "keys")}${kinds ? `: ${kinds}` : ""}`, warn });
    g.secrets += f.secrets;
    by.set(project, g);
  }
  return [...by.values()].sort((a, b) => b.secrets - a.secrets);
}

/** A provider as its own name spells it; anything else gets a capital. */
const BRAND: Record<string, string> = { openai: "OpenAI", github: "GitHub", aws: "AWS", sendgrid: "SendGrid", digitalocean: "DigitalOcean", openrouter: "OpenRouter", huggingface: "Hugging Face", gitlab: "GitLab", pypi: "PyPI", npm: "npm", supabase: "Supabase", stripe: "Stripe", anthropic: "Anthropic", resend: "Resend", twilio: "Twilio", postgres: "Postgres", mysql: "MySQL", mongodb: "MongoDB", elevenlabs: "ElevenLabs", deepgram: "Deepgram", perplexity: "Perplexity" };
export const brandOf = (k: string): string => BRAND[k.toLowerCase()] ?? (k ? k[0].toUpperCase() + k.slice(1) : k);

export const scanTotals = (s: Scan): { files: number; secrets: number } => ({ files: s.files.length, secrets: s.files.reduce((a, f) => a + f.secrets, 0) });
