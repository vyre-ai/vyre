// @ts-check
// point: act on a POINT of a screenshot. The last rung of the ladder (snapshot, selector, label, frame, then the picture): it exists for a surface that has no controls in the DOM (a canvas,
// a video, a closed shadow root, a cross-origin frame Vyre cannot read into), and it is a new write path, so it is bound tightly:
//   - the point is mapped from a shot Vyre kept by an unguessable id (never from numbers in the call), and refused if the page has moved since (scroll, zoom, size, address, a dialog);
//   - what is under the point is found by a hit test that descends into iframes and open shadow roots, and classified by ITS TEXT and its ancestors' (the same patterns as chrome_act):
//     a Send or Delete rendered as a bare div holds whatever the plan says;
//   - a target with no text at all (a drawn surface) is allowed only when the person's approved plan says so (trust.pointBudget) or the person releases this one act;
//   - hover and scroll are read-class; typing refuses line breaks, tabs and control characters, and credential fields.

import { err } from "../lib/err.js";
import { METRICS, getShot } from "../lib/shots.js";
import { classifyText, evaluate, framesOf, digest, script, tabOf, refindFrame } from "./page.js";

const ACTIONS = ["click", "double", "type", "scroll", "hover", "drag"];
const READ_CLASS = new Set(["scroll", "hover"]);
const MAX_TEXT = 500;
/** Newlines, tabs and other control characters (and so any chord): Enter and Ctrl+Enter are send keys, typed text is not allowed to carry them. */
const hasControl = (/** @type {string} */ t) => { for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c < 32 || c === 127 || c === 0x85 || c === 0x2028 || c === 0x2029) return true; } return false; };
/** @type {Map<number, number[]>} */ const recent = new Map();
const RATE_N = 8, RATE_MS = 10_000;
/** For tests. */
export const _resetRate = () => recent.clear();

/** What is at a point in one frame: the element (through open shadow roots), its text and its ancestors' up to the nearest clickable, and whether it is something a person could read. */
const hitScript = (/** @type {number} */ x, /** @type {number} */ y) => script("hit", { x, y }, `
  const x = ARGS.x, y = ARGS.y;
  let el = document.elementFromPoint(x, y);
  for (let i = 0; el && el.shadowRoot && i < 6; i++) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; }
  if (!el) return { none: true };
  const tag = el.tagName.toLowerCase();
  const out = { tag, kind: "element", text: "", textless: true, password: false, fillable: false, submit: false, path: "", modals: 0 };
  const rect = el.getBoundingClientRect();
  out.rect = { l: Math.round(rect.left), t: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
  if (tag === "iframe" || tag === "frame") { out.kind = "iframe"; out.src = el.src || ""; out.name = el.name || ""; return out; }
  if (tag === "canvas") out.kind = "canvas"; else if (tag === "video" || tag === "audio") out.kind = "media"; else if (tag === "svg" || el instanceof SVGElement) out.kind = "svg"; else if (tag === "img") out.kind = "image"; else if (tag === "object" || tag === "embed") out.kind = "embed";
  const clickable = n => { if (!n || n.nodeType !== 1) return false; const t = n.tagName.toLowerCase(); if (["button", "a", "input", "select", "textarea", "summary", "label", "option"].includes(t)) return true; const r = n.getAttribute("role"); if (r && /^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|option|checkbox|radio|switch|treeitem|gridcell)$/.test(r)) return true; if (n.hasAttribute("onclick") || (n.tabIndex >= 0 && n.hasAttribute("tabindex"))) return true; try { return getComputedStyle(n).cursor === "pointer"; } catch (e) { return false; } };
  const parts = []; const seen = new Set();
  const add = v => { v = String(v == null ? "" : v).replace(/\\s+/g, " ").trim(); if (v && !seen.has(v)) { seen.add(v); parts.push(v.slice(0, 160)); } };
  let n = el, stop = false;
  for (let i = 0; n && i < 8 && !stop; i++) {
    if (n.nodeType === 1) {
      add(n.getAttribute("aria-label")); add(n.getAttribute("title")); add(n.getAttribute("alt")); add(n.getAttribute("placeholder"));
      const lb = n.getAttribute("aria-labelledby"); if (lb) for (const id of lb.split(/\\s+/).slice(0, 3)) { const t = document.getElementById(id); if (t) add(t.textContent); }
      if (n.tagName === "INPUT" && /^(button|submit|reset|image)$/i.test(n.type || "")) add(n.value);
      const tx = n.innerText != null ? n.innerText : n.textContent; add(String(tx || "").slice(0, 200));
      if (clickable(n)) stop = true;
    }
    if (!stop) n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  }
  // The clickable's form: a submit button sends it whatever it says.
  const c = el.closest ? el.closest("button,input,[role=button]") : null;
  if (c && ((c.tagName === "BUTTON" && (c.type || "submit") === "submit" && c.form) || (c.tagName === "INPUT" && /^(submit|image)$/i.test(c.type || "")))) out.submit = true;
  out.text = parts.join(" | ").slice(0, 300);
  out.textless = out.text.length === 0;
  const fe = el.closest ? el.closest("input,textarea,select,[contenteditable=''],[contenteditable='true']") : null;
  if (fe) { const t = fe.tagName.toLowerCase(); out.fillable = t !== "input" || !/^(button|submit|reset|image|checkbox|radio|range|color|file)$/i.test(fe.type || "text"); const ty = String(fe.type || "").toLowerCase(), ac = String(fe.getAttribute("autocomplete") || "").toLowerCase(), id = (fe.name || "") + " " + (fe.id || ""); out.password = ty === "password" || ac === "one-time-code" || /current-password|new-password/.test(ac) || /\\b(otp|passcode|2fa|mfa|verification[-_ ]?code)\\b/i.test(id); }
  out.path = tag + (el.id ? "#" + String(el.id).slice(0, 30) : "") + "@" + out.rect.l + "," + out.rect.t + "," + out.rect.w + "," + out.rect.h;
  try { out.modals = document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]').length; } catch (e) {}
  return out;
`);

/** What has focus in a frame, deep through open shadow roots. */
const FOCUS = script("focus", {}, `
  let a = document.activeElement;
  for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 6; i++) a = a.shadowRoot.activeElement;
  if (!a || a === document.body || a === document.documentElement) return { none: true };
  const t = a.tagName.toLowerCase(), ty = String(a.type || "").toLowerCase(), ac = String(a.getAttribute("autocomplete") || "").toLowerCase(), id = (a.name || "") + " " + (a.id || "");
  const fillable = t === "textarea" || a.isContentEditable || (t === "input" && !/^(button|submit|reset|image|checkbox|radio|range|color|file)$/.test(ty || "text"));
  return { tag: t, fillable, password: ty === "password" || ac === "one-time-code" || /current-password|new-password/.test(ac) || /\\b(otp|passcode|2fa|mfa|verification[-_ ]?code)\\b/i.test(id) };
`);

/** The shot's numbers against the page's now: anything that differs means the point would land somewhere else. @param {any} a @param {any} b */
function drift(a, b) {
  const keys = ["w", "h", "sx", "sy", "dpr", "vv", "vw", "url", "modals"];
  return keys.filter(k => a[k] !== b[k]);
}

/**
 * Where a viewport point lands: the top page first, then into the iframe under it, and so on. A frame Vyre has no session for is a surface it cannot read into.
 * @param {any} ctx @param {number} tabId @param {number} x @param {number} y
 * @returns {Promise<{ frame: any, x: number, y: number, info: any, frameOrigin: string, frameUrl: string, depth: number, unreadable?: string }>}
 */
async function resolveHit(ctx, tabId, x, y) {
  const list = await framesOf(ctx, tabId);
  let frame = list.find((/** @type {any} */ f) => f.how === "top" || f.index === 0) || list[0];
  let fx = x, fy = y;
  for (let depth = 0; depth < 5; depth++) {
    const info = await evaluate(ctx, tabId, hitScript(fx, fy), {}, frame);
    const here = { frame, x: fx, y: fy, info: info || { none: true }, frameOrigin: String(frame.origin || ""), frameUrl: String(frame.url || ""), depth };
    if (!info || info.none || info.kind !== "iframe") return here;
    // An iframe is under the point: which of this frame's children is it? By address, else the only child on that origin.
    const kids = list.filter((/** @type {any} */ f) => f.parentId === frame.frameId && f.how !== "none" && f.readable !== false);
    const bySrc = kids.filter((/** @type {any} */ f) => info.src && String(f.url || "").split("#")[0] === String(info.src).split("#")[0]);
    const pick = bySrc.length === 1 ? bySrc[0] : kids.length === 1 ? kids[0] : null;
    if (!pick) return { ...here, unreadable: "an iframe Vyre cannot read into" };
    fx -= info.rect.l; fy -= info.rect.t; frame = pick;
  }
  return { frame, x: fx, y: fy, info: { none: true }, frameOrigin: String(frame.origin || ""), frameUrl: String(frame.url || ""), depth: 5, unreadable: "frames nested too deep" };
}

/** @param {any} frame */
const sessionOf = frame => (frame && frame.how !== "top" && frame.session ? String(frame.session) : undefined);

/**
 * @param {any} ctx @param {number} tabId @param {any} frame @param {string} type @param {any} p
 * @param {{ wait?: boolean }} [o]
 */
async function mouse(ctx, tabId, frame, type, p, o = {}) {
  const call = ctx.cdp.send(tabId, "Input.dispatchMouseEvent", { type, ...p }, sessionOf(frame));
  if (o.wait === false) { void Promise.resolve(call).catch(() => {}); return; } // a mouseMoved is not always acknowledged (see mouseClick)
  await call;
}

/** The units a write needs from the plan's budget. @param {string} action @param {string} [text] */
const need = (action, text) => (action === "double" ? { click: 2 } : action === "type" ? { type: 1 } : action === "drag" ? { drag: 1 } : { click: 1 });

export default {
  name: "point",
  ops: {
    /**
     * @param {any} args {tabId, shot, x, y, action, text?, to?: {x,y}, dy?} @param {any} ctx @param {any} trust
     */
    "point.act": async (args, ctx, trust = {}) => {
      const tabId = await tabOf(args, ctx, "point.act");
      // The module carries it as `kind` (an `action` argument is the tab tools' own and is stripped before any op sees it).
      const action = String(args.kind || args.action || "click");
      if (!ACTIONS.includes(action)) throw err("bad_request", `action must be one of ${ACTIONS.join(", ")}`);
      const num = (/** @type {any} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
      const px = num(args.x), py = num(args.y);
      if (!(px >= 0 && py >= 0)) throw err("bad_request", "x and y are the point in the screenshot, in its own pixels");
      if (action === "type") {
        if (typeof args.text !== "string" || !args.text.length) throw err("bad_request", "type needs text");
        if (args.text.length > MAX_TEXT) throw err("bad_request", `type takes at most ${MAX_TEXT} characters`);
        if (hasControl(args.text)) throw err("bad_request", "typed text may not carry a line break, a tab or any control character (Enter sends, and a chord is a keystroke, not text): type the text, then act on the send control");
      }
      const release = trust.release && (trust.release.sig || trust.release.signature) ? String(trust.release.sig || trust.release.signature) : "";
      const shot = typeof args.shot === "string" ? getShot(args.shot, tabId, { released: !!release }) : null;
      if (!shot) throw err("stale", "that screenshot is unknown or has expired: take a fresh one (chrome_screenshot) and point at it");
      // The page must still look like the picture.
      const now = await evaluate(ctx, tabId, METRICS);
      const off = now && typeof now === "object" ? drift(shot.metrics, now) : ["unreadable"];
      if (off.length) throw err("stale", `the page is not as it was in the screenshot (${off.join(", ")} changed): take a fresh one`);
      const cx = px / shot.scale, cy = py / shot.scale;
      if (cx >= shot.metrics.w || cy >= shot.metrics.h) throw err("bad_request", "that point is outside the screenshot");
      let to = null;
      if (action === "drag") {
        const tx = num(args.to && args.to.x), ty = num(args.to && args.to.y);
        if (!(tx >= 0 && ty >= 0)) throw err("bad_request", "drag needs to: {x, y}");
        to = { x: tx / shot.scale, y: ty / shot.scale };
        if (to.x >= shot.metrics.w || to.y >= shot.metrics.h) throw err("bad_request", "the drop point is outside the screenshot");
      }
      const hit = await resolveHit(ctx, tabId, cx, cy);
      // Every frame the point lands in answers to the floor on its own: a sign-in or bank page framed into an allowed one is still blind.
      const fl = hit.frameUrl ? await ctx.floorUrl(hit.frameUrl, "point.act") : { allow: true };
      if (fl && fl.allow === false) throw err("blocked", `${fl.why || "that page is off limits"} (${fl.tier || "blind"})`);
      /** @type {any} */ let drop = null;
      if (to) {
        drop = await resolveHit(ctx, tabId, to.x, to.y);
        if (drop.frame !== hit.frame && drop.frame.index !== hit.frame.index) throw err("bad_request", "a drag stays inside one frame: the drop point is in another");
      }
      const info = hit.info || { none: true };
      if (info.password) throw err("blocked", "that is a password or one-time-code field: Vyre never types or clicks into one from a picture");
      const write = !READ_CLASS.has(action);
      const text = String(info.text || "");
      const cons = text ? classifyText(text) : { consequential: false, why: "" };
      const dropInfo = drop && drop.info ? drop.info : null;
      const dropCons = dropInfo && dropInfo.text ? classifyText(String(dropInfo.text)) : { consequential: false, why: "" };
      const consequential = write && (cons.consequential || info.submit === true || dropCons.consequential || (dropInfo && dropInfo.submit === true));
      // Drawn: nothing in the DOM says what it is (a canvas, a video, a frame Vyre cannot see into, a closed shadow root, an empty element).
      const drawn = write && !consequential && (!!hit.unreadable || info.none === true || info.textless === true || (dropInfo ? dropInfo.textless === true : false));
      const sig = digest([action, hit.frameOrigin, String(info.path || ""), text, String(dropInfo && dropInfo.path || ""), shot.metrics.url, `${Math.round(cx)},${Math.round(cy)}`].join("\n"));
      const held = (/** @type {string} */ why) => ({ ok: false, held: true, why, control: { role: consequential ? "control" : "drawn surface", name: consequential ? text.slice(0, 80) : `${info.kind || "surface"} at ${Math.round(px)},${Math.round(py)}` }, fields: [{ name: "where", value: `${hit.frameOrigin || "this page"}, ${action} at ${Math.round(px)},${Math.round(py)}` }, { name: "under the point", value: text ? text.slice(0, 120) : (hit.unreadable || `${info.kind || "nothing readable"} (nothing in the page says what this does)`) }, ...(action === "type" ? [{ name: "typing", value: `${String(args.text).length} characters` }] : [])], sig, origin: hit.frameOrigin });
      const asked = trust.asked === true;
      const changedErr = () => err("changed", "the page changed since it was held, so nothing was done; look again and ask again");
      /** @type {Record<string, number>} */ const spend = {};
      if (write) {
        if (consequential) {
          // A send, a delete, a publish, a payment: asked every time, whatever the plan says.
          if (release ? release !== sig : !asked) { if (release) throw changedErr(); return held(cons.consequential ? cons.why : dropCons.consequential ? dropCons.why : "a submit button sends its form"); }
        } else if (drawn) {
          const b = trust.pointBudget;
          const n = need(action, args.text);
          const origins = b && Array.isArray(b.origins) ? b.origins : b && b.tabOrigin ? [b.tabOrigin] : [];
          const covered = !!b && b.tab === tabId && origins.includes(hit.frameOrigin) && Object.entries(n).every(([k, v]) => (Number(b[k]) || 0) >= v);
          if (covered) Object.assign(spend, n);
          else if (release ? release !== sig : !asked) { if (release) throw changedErr(); return held(b && origins.length && !origins.includes(hit.frameOrigin) ? `the plan covers ${origins[0]}, not ${hit.frameOrigin || "this frame"}` : "nothing in the page says what this drawn surface does, so it waits for the person's approval (or a plan that names it)"); }
        }
        // A runaway loop of point acts is a bug or an attack: a few per few seconds, per tab.
        const nowMs = Date.now(), log = (recent.get(tabId) || []).filter(t => nowMs - t < RATE_MS);
        if (log.length >= RATE_N) throw err("rate_limited", `at most ${RATE_N} point actions in ${RATE_MS / 1000} seconds on one tab`);
        log.push(nowMs); recent.set(tabId, log);
        // Right before dispatch: the same thing must still be under the point (a dialog or a navigation that arrived in between).
        const again = await resolveHit(ctx, tabId, cx, cy);
        if ((again.info && again.info.path) !== (info.path || undefined) || (again.info && again.info.modals) !== info.modals || again.frameOrigin !== hit.frameOrigin) throw err("changed", "something else is under the point now, so nothing was done: take a fresh screenshot");
      }
      const f = hit.frame, at = { x: Math.round(hit.x), y: Math.round(hit.y) };
      if (action === "hover") await mouse(ctx, tabId, f, "mouseMoved", { x: at.x, y: at.y }, { wait: false });
      else if (action === "scroll") await mouse(ctx, tabId, f, "mouseWheel", { x: at.x, y: at.y, deltaX: 0, deltaY: Math.max(-2000, Math.min(2000, Math.round(Number(args.dy) || 400))) });
      else if (action === "click" || action === "double" || action === "type") {
        await mouse(ctx, tabId, f, "mouseMoved", { x: at.x, y: at.y }, { wait: false });
        const clicks = action === "double" ? 2 : 1;
        for (let c = 1; c <= clicks; c++) {
          await mouse(ctx, tabId, f, "mousePressed", { x: at.x, y: at.y, button: "left", clickCount: c });
          await mouse(ctx, tabId, f, "mouseReleased", { x: at.x, y: at.y, button: "left", clickCount: c });
        }
        if (action === "type") {
          const foc = await evaluate(ctx, tabId, FOCUS, {}, f).catch(() => null);
          if (foc && foc.password) throw err("blocked", "focus is in a password or one-time-code field: nothing was typed");
          const kind = foc && !foc.none ? "control" : "drawn";
          if (kind === "drawn" && !spend.type && !(release && release === sig) && !asked && !drawn) {
            // A focus Vyre cannot read (nothing focused, a canvas listening for keys) is a drawn surface even though the click target had some text.
            const b = trust.pointBudget; const origins = b && Array.isArray(b.origins) ? b.origins : b && b.tabOrigin ? [b.tabOrigin] : [];
            if (!(b && b.tab === tabId && origins.includes(hit.frameOrigin) && (Number(b.type) || 0) >= 1)) return held("nothing readable has focus after the click, so this typing waits for the person's approval (or a plan that names it)");
            spend.type = 1;
          }
          if (foc && foc.fillable) await ctx.cdp.send(tabId, "Input.insertText", { text: args.text }, sessionOf(f));
          else for (const ch of String(args.text)) { await ctx.cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }, sessionOf(f)); await ctx.cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch }, sessionOf(f)); }
        }
      } else if (action === "drag") {
        const d = { x: Math.round(drop.x), y: Math.round(drop.y) };
        await mouse(ctx, tabId, f, "mouseMoved", { x: at.x, y: at.y }, { wait: false });
        await mouse(ctx, tabId, f, "mousePressed", { x: at.x, y: at.y, button: "left", clickCount: 1 });
        for (let i = 1; i <= 6; i++) await mouse(ctx, tabId, f, "mouseMoved", { x: Math.round(at.x + ((d.x - at.x) * i) / 6), y: Math.round(at.y + ((d.y - at.y) * i) / 6), button: "left", buttons: 1 }, { wait: false });
        await mouse(ctx, tabId, f, "mouseReleased", { x: d.x, y: d.y, button: "left", clickCount: 1 });
      }
      return { ok: true, did: action, at: { x: Math.round(px), y: Math.round(py) }, under: { kind: info.kind || (hit.unreadable ? "iframe" : "none"), ...(text ? { text: text.slice(0, 80) } : { drawn: true }), frame: hit.frameOrigin || "top" }, ...(Object.keys(spend).length ? { spent: spend } : {}), note: "the page may have changed: take a fresh screenshot before the next point" };
    },
  },
};
