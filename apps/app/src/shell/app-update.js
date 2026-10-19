// @ts-check
// The Mac app's own update. The Mac app is sideloaded (a dmg from the GitHub release, no store and no in-place updater), so "Update" here means: find the newest stable release that has a Mac dmg,
// have the person's browser download it (the shell's `open`, Host/VyreAppWindow.swift), and say the two steps that finish it. The button always shows where it is ("Downloading…") and how it
// ended (the steps, or a plain error with where to get it by hand): it never does nothing. Pure: the fetch, the open and the clock are passed in.

export const RELEASES = "https://github.com/vyre-ai/vyre/releases";
const API = "https://api.github.com/repos/vyre-ai/vyre/releases?per_page=30";

/** "0.6.2" or "v0.6.2-rc.1" as numbers and a pre-release tag, or null. @param {unknown} v */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || "").trim());
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || "" } : null;
}

/** Above zero when a is newer than b; a stable release is newer than its own pre-releases. Unreadable versions compare equal. @param {unknown} a @param {unknown} b */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The dmg's name for this Mac, as the release publishes it under its stable name. @param {string | null | undefined} arch */
export const dmgName = (arch) => (arch === "aarch64" || arch === "x86_64" ? `Vyre-${arch}.dmg` : null);

/** Where the browser gets version `version` for this Mac: the dmg itself when the arch is known, else the release's page (which lists both). @param {string} version @param {string | null | undefined} arch */
export function downloadUrl(version, arch) {
  const dmg = dmgName(arch);
  const tag = `v${String(version).replace(/^v/, "")}`;
  return dmg ? `${RELEASES}/download/${tag}/${dmg}` : `${RELEASES}/tag/${tag}`;
}

/**
 * The newest stable release newer than `current` that has a Mac dmg (for this arch when it is known), from GitHub's release list, or null. Drafts and pre-releases are not offered: the Mac app
 * ships with stable releases only. @param {any} list @param {string} current @param {string | null | undefined} arch
 * @returns {{ version: string, url: string } | null}
 */
export function pickAppRelease(list, current, arch) {
  if (!Array.isArray(list) || !parseVersion(current)) return null;
  const want = dmgName(arch);
  /** @type {{ version: string, url: string } | null} */ let best = null;
  for (const r of list) {
    if (!r || r.draft || r.prerelease) continue;
    const v = parseVersion(r.tag_name);
    if (!v || v.pre) continue;
    const version = v.n.join(".");
    const names = Array.isArray(r.assets) ? r.assets.map((/** @type {any} */ a) => String((a && a.name) || "")) : [];
    if (want ? !names.includes(want) : !names.some((n) => /^Vyre-.*\.dmg$/.test(n))) continue;
    if (compareVersions(version, current) <= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, url: downloadUrl(version, arch) };
  }
  return best;
}

/**
 * Is a newer Mac app out? GitHub's release list first; when it cannot be read (offline, a page whose policy does not reach GitHub), the version the server says is out (`hint`, update.status
 * `available`), stable only. Null when this Mac app is current, or when it cannot tell.
 * @param {{ fetch?: typeof fetch, current: string | null | undefined, arch?: string | null, hint?: string | null }} o
 * @returns {Promise<{ version: string, url: string } | null>}
 */
export async function latestAppRelease(o) {
  const current = String(o.current || "");
  if (!parseVersion(current)) return null;
  try {
    const f = o.fetch || globalThis.fetch.bind(globalThis);
    const res = await f(API, { headers: { accept: "application/vnd.github+json" } });
    if (res.ok) return pickAppRelease(await res.json(), current, o.arch);
  } catch { /* fall back to the server's word */ }
  const hint = parseVersion(o.hint);
  if (hint && !hint.pre && compareVersions(o.hint, current) > 0) { const version = hint.n.join("."); return { version, url: downloadUrl(version, o.arch) }; }
  return null;
}

/** What the button says while it works. */
export const DOWNLOADING = "Downloading…";

/** The two steps after the download, in the person's words. @param {string} version */
export const doneLine = (version) => `Your browser is downloading Vyre ${version}. Open the downloaded Vyre and drag it to Applications, then quit this Vyre and open the new one. Your data, vault and sign-ins stay.`;

/** A plain error, with where to get it by hand. @param {string} why @param {string} version */
export const failLine = (why, version) => `The download did not start (${why}). Get Vyre ${version} from github.com/vyre-ai/vyre/releases and drag it to Applications.`;

/**
 * Press Update: say "Downloading…", hand the dmg's address to the person's browser through the shell, and end with the steps or a plain error. A shell that never answers ends in an error after
 * `timeoutMs`, so the button cannot hang.
 * @param {{ open: ((url: string) => Promise<unknown>) | null | undefined, release: { version: string, url: string }, onStep?: (s: { busy: boolean, line: string, ok?: boolean }) => void, timeoutMs?: number, setTimeout?: (f: () => void, ms: number) => any }} o
 * @returns {Promise<{ ok: boolean, line: string }>}
 */
export async function runAppUpdate(o) {
  const step = o.onStep || (() => {});
  const { version, url } = o.release;
  step({ busy: true, line: DOWNLOADING });
  /** @type {{ ok: boolean, line: string }} */ let out;
  if (!o.open) out = { ok: false, line: failLine("this window cannot open your browser", version) };
  else {
    const st = o.setTimeout || ((f, ms) => setTimeout(f, ms));
    const ms = o.timeoutMs ?? 15_000;
    try {
      await Promise.race([Promise.resolve().then(() => /** @type {(url: string) => Promise<unknown>} */ (o.open)(url)), new Promise((_, rej) => st(() => rej(new Error("the app did not answer")), ms))]);
      out = { ok: true, line: doneLine(version) };
    } catch (e) {
      const why = e instanceof Error && e.message ? e.message.replace(/[.\s]+$/, "") : "the app said no";
      out = { ok: false, line: failLine(why.charAt(0).toLowerCase() + why.slice(1), version) };
    }
  }
  step({ busy: false, line: out.line, ok: out.ok });
  return out;
}
