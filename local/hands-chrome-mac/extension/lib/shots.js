// @ts-check
// shots: what a screenshot was taken of, kept here (never in what the model sends) so a point is always mapped with the numbers of the picture the model looked at.
// A shot is an unguessable id for 60 seconds (a release the person gives later may use it for 15 minutes, and only if the page still looks the same).

/** The page's own numbers, read in the top frame: what the picture covers, and what would make a point mean something else by the time it is used. */
export const METRICS = `/*vyre:metrics*/(() => { const vv = window.visualViewport; let modals = 0; try { modals = document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[popover]:popover-open').length; } catch (e) { try { modals = document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]').length; } catch (x) {} } return { w: innerWidth, h: innerHeight, sx: Math.round(scrollX), sy: Math.round(scrollY), dpr: devicePixelRatio, vv: vv ? vv.scale : 1, vw: vv ? Math.round(vv.width) : innerWidth, url: String(location.href).split('#')[0], modals }; })()`;

/** Width and height of a PNG or JPEG from its base64 bytes, or null. @param {string} b64 @returns {{ w: number, h: number }|null} */
export function imageSize(b64) {
  try {
    const bin = atob(String(b64).slice(0, 87384)); // ~65 KB of bytes is plenty for a header
    const head = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) head[i] = bin.charCodeAt(i);
    const u32 = (/** @type {number} */ o) => ((head[o] << 24) | (head[o + 1] << 16) | (head[o + 2] << 8) | head[o + 3]) >>> 0;
    const u16 = (/** @type {number} */ o) => (head[o] << 8) | head[o + 1];
    if (head.length > 24 && head[0] === 0x89 && head[1] === 0x50) return { w: u32(16), h: u32(20) };
    if (head[0] === 0xff && head[1] === 0xd8) {
      let i = 2;
      while (i + 9 < head.length) {
        if (head[i] !== 0xff) { i++; continue; }
        const m = head[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: u16(i + 5), w: u16(i + 7) };
        i += 2 + u16(i + 2);
      }
    }
  } catch { /* not an image we can size */ }
  return null;
}

const TTL_MS = 60_000;
const RELEASE_TTL_MS = 15 * 60_000;
/** @type {Map<string, { id: string, tab: number, at: number, scale: number, metrics: any }>} */
const store = new Map();
const rand = () => { const a = new Uint8Array(12); (globalThis.crypto || /** @type {any} */ ({ getRandomValues: (/** @type {Uint8Array} */ x) => { for (let i = 0; i < x.length; i++) x[i] = Math.floor(Math.random() * 256); } })).getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); };

/** @param {number} tab @param {number} scale @param {any} metrics */
export function putShot(tab, scale, metrics) {
  const id = rand();
  store.set(id, { id, tab, at: Date.now(), scale, metrics });
  while (store.size > 24) store.delete(/** @type {string} */ (store.keys().next().value));
  return id;
}
/** @param {string} id @param {number} tab @param {{ released?: boolean, now?: number }} [o] */
export function getShot(id, tab, o = {}) {
  const s = store.get(String(id));
  if (!s || s.tab !== tab) return null;
  const age = (o.now ?? Date.now()) - s.at;
  return age <= (o.released ? RELEASE_TTL_MS : TTL_MS) ? s : null;
}
export const SHOT_TTL_SECONDS = TTL_MS / 1000;
export const _clear = () => store.clear();
